const stationApi = require('../../../utils/station-api')
const { ensureSession } = require('../../../utils/auth-guard')
const { ScaleBle } = require('../../../services/scaleBle')
const { buildQrMatrix, createCheckinPayload, drawQr } = require('../../../utils/scale-qr')

/**
 * 设备类型隔离（设计 §11）：体脂秤工作站仅接受 SCALE 场次。
 * normalizeStation 对缺失 deviceType 回填 'SCALE'，因此服务端未升级时也不会误伤老数据。
 */
function isStationDeviceTypeAllowed (expected, actual) {
  const text = String(actual === null || actual === undefined || actual === '' ? expected : actual).toUpperCase()
  return text === String(expected).toUpperCase()
}

/**
 * 会话级指标累积器（设计 §9.1）：以指标类型为键、后帧覆盖同型前帧；
 * 0x30 完成帧 metrics 为空数组，天然不参与覆盖。weight 只认稳定帧（status==='stable'），
 * 实时/无效值（NaN、非正数、无单位）一律拒绝入袋。
 */
function accumulateScaleMetric (accumulator, frameResult) {
  const metrics = Array.isArray(frameResult && frameResult.metrics) ? frameResult.metrics : []
  for (const item of metrics) {
    if (!item || !item.name) continue
    const value = Number(item.value)
    if (!Number.isFinite(value)) continue
    if (item.name === 'weight' && (frameResult.status !== 'stable' || value <= 0)) continue
    accumulator[item.name] = { name: item.name, value, unit: String(item.unit || '') }
  }
  return accumulator
}

/** 复制累积器形成不可变草稿快照（冻结，防止后续帧污染已提交数据）。 */
function snapshotScaleMetrics (accumulator) {
  return Object.keys(accumulator).map(name => Object.freeze(Object.assign({}, accumulator[name]))).sort((a, b) => a.name < b.name ? -1 : 1)
}

/** 最低完整性判定（设计 §9.1）：必须收到协议 0x30 稳定完成信号且累积到有效体重。 */
function evaluateDraftReadiness (accumulator, completeReceived) {
  const weight = accumulator.weight
  if (!completeReceived) return { ready: false, reason: '未完成测量：等待体脂秤稳定完成信号' }
  if (!weight || !(Number(weight.value) > 0)) return { ready: false, reason: '缺少有效体重，不能提交草稿' }
  return { ready: true, reason: '' }
}

/**
 * v2 检测会话归属判定（设计 §8 / §15）：只接收【同时】满足两帧条件的数据 ——
 * (1) receivedAt 不早于本会话启动时间（同连接周期内的旧患者延迟帧）；
 * (2) 帧上携带的 measurementSessionId（若有）等于当前服务端会话 ID。
 * 第二层是阶段二新增的服务端 ID 键：迟到帧被 BLE 重投递并盖上旧 sessionId 时，
 * 即使时间戳落在窗口内也会被丢弃；无标记的历史实现/直调路径退回时间窗单层防护。
 */
function acceptsFrameForSession (session, frameResult) {
  if (!session || !session.measurementSessionId) return false
  const frameSession = frameResult && frameResult.measurementSessionId
  if (frameSession && String(frameSession) !== String(session.measurementSessionId)) return false
  const receivedAt = frameResult && Number(frameResult.receivedAt)
  if (Number.isFinite(receivedAt) && receivedAt < Number(session.startedAt || 0)) return false
  return true
}

/** 从 v2 callNext/getStation 响应解析服务端下发的检测会话 ID（医生视图活动项携带）。 */
function serverMeasurementSessionIdFrom (station) {
  if (!station || typeof station !== 'object') return ''
  const direct = station.measurementSessionId
  if (direct) return String(direct)
  const item = station.currentQueueItem || station.currentDraft
  return item && item.measurementSessionId ? String(item.measurementSessionId) : ''
}

/**
 * 错误语义分类（设计 §17）：
 * expired → 410 二维码/检测会话过期（清态、明确提示、不得自动重放旧会话）
 * conflict → 409 状态冲突/并发竞争/幂等 key 冲突（保留本地态，按回传状态刷新恢复）
 */
function classifyStationError (error) {
  const code = Number(error && (error.statusCode || error.code))
  if ((error && error.expiredSession === true) || code === 410) return 'expired'
  if ((error && error.stateConflict === true) || code === 409) return 'conflict'
  return 'generic'
}

// 统一措辞（交付项 4）：会话过期与部分结果的中文提示全站同一句，避免多页面漂移。
const SESSION_EXPIRED_TEXT = '本次检测会话已过期，请重新叫号'
const PARTIAL_RESULT_TEXT = '部分血脂结果'

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function metricLabel (name) {
  const labels = {
    weight: '体重',
    bodyFat: '体脂率',
    bmi: 'BMI',
    heartRate: '心率'
  }
  return labels[name] || name
}

function metricText (metric) {
  return {
    name: valueText(metric?.name || metric?.type),
    value: metric?.value,
    unit: valueText(metric?.unit),
    label: metricLabel(metric?.name || metric?.type)
  }
}

function currentTimestamp () {
  return new Date().toISOString().slice(0, 19)
}

function patientProfile (item) {
  const summary = item?.patientSummary || {}
  return {
    maskedName: valueText(summary.maskedName, '待叫号患者'),
    gender: summary.gender === null || summary.gender === undefined || summary.gender === '' ? '' : Number(summary.gender),
    age: summary.age === null || summary.age === undefined || summary.age === '' ? '' : Number(summary.age),
    height: summary.height === null || summary.height === undefined || summary.height === '' ? '' : Number(summary.height),
    genderText: valueText(summary.genderText),
    heightText: valueText(summary.heightText)
  }
}

function createActionKey (prefix) {
  return stationApi.createIdempotencyKey(prefix)
}

function currentDraftFromQueueItem (item) {
  if (!item) return null
  if (!item.draftId) return null
  return {
    id: valueText(item.draftId),
    status: valueText(item.draftStatus, 'RESULT_PENDING')
  }
}

// 导出纯函数供 node 测试直接驱动：挂到 globalThis 命名空间槽位，小程序运行时与 Page 注册均不受影响。
globalThis.__cdmsScaleStationTestables = {
  isStationDeviceTypeAllowed, accumulateScaleMetric, snapshotScaleMetrics, evaluateDraftReadiness,
  acceptsFrameForSession, serverMeasurementSessionIdFrom, classifyStationError,
  SESSION_EXPIRED_TEXT, PARTIAL_RESULT_TEXT
}

Page({
  data: {
    loading: false,
    creating: false,
    scanning: false,
    connecting: false,
    measuring: false,
    saving: false,
    canConfirm: false,
    errorText: '',
    statusText: '待创建场次',
    stationId: '',
    stationStatus: 'OPEN',
    checkinToken: '',
    qrPayload: '',
    tokenExpiresAt: '',
    queue: [],
    currentQueueItem: null,
    currentDraft: null,
    metrics: [],
    deviceTypeMismatch: false,
    devices: [],
    deviceNames: [],
    deviceIndex: -1,
    connected: false
  },

  async onLoad (query = {}) {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (session.activeRole !== 'DOCTOR') {
        this.setData({ errorText: '请先使用医生账号登录' })
        return
      }
      this.scale = new ScaleBle({
        onState: state => this.onScaleState(state),
        onResult: result => this.onScaleResult(result)
      })
      // 会话级状态（不进 data，避免 setData 序列化开销）：指标累积器与检测会话上下文
      this.metricAccumulator = {}
      this.measurementCompleteReceived = false
      this.measurementSessionId = ''
      this.measurementSessionStartedAt = 0
      this.draftSnapshot = null
      const stationId = valueText(query.stationId, '')
      this.setData({ errorText: '', stationId })
      if (stationId) {
        await this.loadStation(stationId)
        return
      }
      await this.createStation()
    } catch (error) {
      this.setData({ loading: false, creating: false, errorText: error?.statusCode === 401 ? '登录状态已失效，请重新登录' : '体脂秤工作站加载失败，请稍后重试' })
    }
  },

  onUnload () {
    this.stopMeasurementTimeout()
    if (this.scale) {
      this.scale.disconnect().catch(() => {})
      this.scale.destroy()
    }
  },

  async createStation () {
    // TODO(阶段三): 创建/关闭场次等动作的网络超时重试应复用同一动作 key 直到明确成功/失败（设计 §14）；
    // 后端 cdms_station_action_request 幂等表未上线前，v1 writePayload 通道每次调用生成新 key。
    this.setData({ creating: true, loading: true, errorText: '' })
    try {
      const station = await stationApi.createStation({
        stationName: '体脂秤轮测场次',
        idempotencyKey: createActionKey('station-create')
      })
      const stationId = valueText(station.id || station.stationId, '')
      if (stationId) {
        this.setData({ stationId })
      }
      this.applyStation(station)
      await this.refreshStation(stationId || station.id || station.stationId)
    } catch (error) {
      this.setData({ errorText: error.message || '场次创建失败' })
    } finally {
      this.setData({ creating: false, loading: false })
    }
  },

  async loadStation (stationId) {
    this.setData({ loading: true, errorText: '' })
    try {
      await this.refreshStation(stationId)
    } catch (error) {
      this.setData({ errorText: error.message || '场次加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async refreshStation (stationId = this.data.stationId) {
    if (!stationId) return
    const [station, queue] = await Promise.all([
      stationApi.getStation(stationId),
      stationApi.getTodayQueue(stationId)
    ])
    this.applyStation(Object.assign({}, station, {
      queue: queue.items || station.queue || []
    }))
  },

  applyStation (station = {}, options = {}) {
    // 设备类型隔离（设计 §11）：加载/刷新场次后立即核对 deviceType，不匹配则停止一切 BLE 操作。
    if (!isStationDeviceTypeAllowed('SCALE', station.deviceType)) {
      this.abortMeasurementSession('设备类型不匹配：请扫描正确的设备二维码')
      this.setData({ deviceTypeMismatch: true, statusText: '请扫描正确的设备二维码（本页面仅支持体脂秤 SCALE 场次）' })
      return
    }
    if (this.data.deviceTypeMismatch) {
      this.setData({ deviceTypeMismatch: false })
      wx.showToast({ title: '已切换到体脂秤场次', icon: 'none' })
    }
    const queue = Array.isArray(station.queue) ? station.queue : []
    const currentQueueItem = station.currentQueueItem || queue.find(item => ['CALLED', 'MEASURING', 'RESULT_PENDING'].includes(String(item.status || ''))) || null
    const currentDraft = station.currentDraft || currentDraftFromQueueItem(currentQueueItem)
    const nextStationId = valueText(station.id || station.stationId, this.data.stationId)
    const nextToken = valueText(station.checkinToken, this.data.checkinToken)
    const draftStatus = valueText(currentDraft?.status || currentQueueItem?.draftStatus)
    // 注意：applyStation 从不写 measuring —— 采集态只由会话生命周期方法
    // （abort/adopt/begin、结果处理、callNext/confirm/close）管理，避免渲染竞态打回叫号成果。
    this.setData({
      stationId: nextStationId,
      stationStatus: valueText(station.status, 'OPEN'),
      checkinToken: nextToken,
      qrPayload: createCheckinPayload(nextStationId, nextToken),
      tokenExpiresAt: valueText(station.tokenExpiresAt),
      queue,
      currentQueueItem,
      currentDraft,
      metrics: currentQueueItem && currentQueueItem.metrics && currentQueueItem.metrics.length ? currentQueueItem.metrics.map(metricText) : this.data.metrics,
      canConfirm: draftStatus === 'RESULT_PENDING',
      statusText: currentQueueItem
        ? `${patientProfile(currentQueueItem).maskedName} 已在队列中`
        : valueText(station.status, 'OPEN') === 'OPEN'
          ? '等待下一位患者'
          : '场次已关闭'
    }, () => this.drawCheckinQr())
  },

  /**
   * 结束当前检测会话（设计 §8）：停表计时、清空 BLE 帧缓冲与 metricAccumulator、
   * 使旧 measurementSessionId 失效——上一位患者的延迟帧不再可能污染新草稿。
   * 会话键自阶段二起为【服务端下发的 UUID】（v2 callNext 响应），本地不再有客户端生成 ID。
   */
  abortMeasurementSession (reasonText) {
    this.stopMeasurementTimeout()
    this.measurementSessionId = ''
    this.measurementSessionQueueItemId = ''
    this.measurementSessionStartedAt = 0
    this.metricAccumulator = {}
    this.measurementCompleteReceived = false
    this.draftSnapshot = null
    // 幂等 key（§14）：草稿失败后的手动重试沿用同一 key（abort 不清）；
    // 「明确成功」与「会话终结动作」（换人叫号/跳过/重排/关闭/410）由调用方显式清或本方法按 reason 清。
    if (this.scale) { try { this.scale.reset() } catch (_) { /* BLE 层异常不阻塞清态 */ } }
    if (reasonText) this.setData({ errorText: reasonText })
  },

  /**
   * 装载服务端下发的新检测会话（设计 §8 第 5 步：叫号成功后保存新会话 ID）。
   * 前置条件：必须携带非空的服务端 measurementSessionId —— 缺失时返回 false，页面保持
   * 「无会话」态（不收任何 BLE 数据、不提交草稿），绝不用客户端占位 ID 顶替。
   */
  adoptMeasurementSession (serverSessionId, queueItemId) {
    const sessionId = valueText(serverSessionId, '')
    if (!sessionId) return false
    this.stopMeasurementTimeout()
    this.measurementSessionId = sessionId
    this.measurementSessionQueueItemId = valueText(queueItemId, '')
    this.measurementSessionStartedAt = Date.now()
    this.metricAccumulator = {}
    this.measurementCompleteReceived = false
    this.draftSnapshot = null
    this.measurementIdempotencyKey = createActionKey('station-draft')
    // 超时保护：60s 无完成帧即判为未完成，保留本地提示、禁止提交草稿。
    this.measurementTimer = setTimeout(() => {
      this.measurementTimer = null
      if (!this.data.measuring || this.measurementCompleteReceived) return
      this.setData({
        measuring: false,
        canConfirm: false,
        statusText: '测量未完成或已超时：数据仅作现场提示，不能提交草稿，请让患者重新上秤'
      })
    }, 60000)
    return true
  },

  /**
   * v1 灰度回退入口：v1 响应不下发会话 ID，这里生成的只是【本地窗口标记】，
   * 绝不写入草稿载荷；v2 通道一律走 adoptMeasurementSession（服务端 UUID 为键）。
   */
  beginMeasurementSession (queueItemId) {
    if (stationApi.getStationApiVersion() === 'v2') {
      // v2 下拒绝本地建会话：宁可无会话（收不到数据）也不能用假 ID 冒充服务端会话
      this.abortMeasurementSession()
      return false
    }
    this.stopMeasurementTimeout()
    this.measurementSessionId = stationApi.createIdempotencyKey(`scale-session-local-${valueText(queueItemId, 'na')}`)
    this.measurementSessionQueueItemId = valueText(queueItemId, '')
    this.measurementSessionStartedAt = Date.now()
    this.metricAccumulator = {}
    this.measurementCompleteReceived = false
    this.draftSnapshot = null
    this.measurementIdempotencyKey = createActionKey('station-draft')
    this.measurementTimer = setTimeout(() => {
      this.measurementTimer = null
      if (!this.data.measuring || this.measurementCompleteReceived) return
      this.setData({
        measuring: false,
        canConfirm: false,
        statusText: '测量未完成或已超时：数据仅作现场提示，不能提交草稿，请让患者重新上秤'
      })
    }, 60000)
    return true
  },

  stopMeasurementTimeout () {
    if (this.measurementTimer) { clearTimeout(this.measurementTimer); this.measurementTimer = null }
  },

  drawCheckinQr () {
    if (!this.qrReady || !this.data.qrPayload || typeof wx.createCanvasContext !== 'function') return
    try {
      const matrix = buildQrMatrix(this.data.qrPayload)
      drawQr(wx.createCanvasContext('stationQr', this), matrix, { size: 240, quiet: 4 })
    } catch (error) {
      this.setData({ errorText: error.message || '二维码生成失败' })
    }
  },

  async callNext () {
    if (this.data.deviceTypeMismatch) {
      wx.showToast({ title: '请扫描正确的设备二维码', icon: 'none' })
      return
    }
    // 已有活动患者时先拒：防止叫号请求在途期间旧患者的帧落进刚清空的会话（服务端同样会 409）
    if (this.data.measuring && this.data.currentQueueItem) {
      wx.showToast({ title: '当前患者测量中，请先完成或跳过', icon: 'none' })
      return
    }
    if (!this.data.stationId) {
      wx.showToast({ title: '请先创建场次', icon: 'none' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    // 切换患者六步（设计 §8）第 1~3 步：停止采集 → 清 BLE 缓冲与累积器 → 旧会话失效。
    // 放在叫号请求发出【之前】：任何在途旧帧都进不了新窗口。旧测量动作的幂等 key 一并终结。
    this.abortMeasurementSession()
    this.measurementIdempotencyKey = ''
    try {
      // TODO(阶段三): 网络超时重试应复用本动作的 callNext key 直到明确成功/失败（设计 §14）；
      // 后端幂等表未上线前保持每次调用生成新 key。
      const station = await stationApi.callNext(this.data.stationId, {
        idempotencyKey: createActionKey('station-next')
      })
      if (!isStationDeviceTypeAllowed('SCALE', station.deviceType)) {
        this.applyStation(station)
        return
      }
      // 第 5 步：服务端叫号成功后保存新会话 ID —— v2 由 callNext 响应下发 measurementSessionId(UUID)。
      // 先走统一渲染入口（含设备类型隔离校验），再装载会话；v2 下响应缺少该 ID 即视为契约异常：
      // 保持无会话态并提示重新叫号，绝不用本地占位 ID 顶替。
      this.applyStation(station)
      if (this.data.deviceTypeMismatch) return
      const serverSessionId = serverMeasurementSessionIdFrom(station) || serverMeasurementSessionIdFrom(station.currentQueueItem)
      let sessionReady = false
      if (station.currentQueueItem) {
        if (serverSessionId) {
          sessionReady = this.adoptMeasurementSession(serverSessionId, station.currentQueueItem.id)
        } else if (stationApi.getStationApiVersion() === 'v2') {
          this.abortMeasurementSession()
        } else {
          // v1 灰度回退：仅本地窗口标记，绝不进草稿载荷
          sessionReady = this.beginMeasurementSession(station.currentQueueItem.id)
        }
      }
      const nextPatient = patientProfile(station.currentQueueItem || {})
      this.setData({
        measuring: !!sessionReady,
        canConfirm: false,
        metrics: [],
        currentDraft: null,
        statusText: station.currentQueueItem
          ? (sessionReady
            ? `已叫号：${nextPatient.maskedName}，请上秤测量`
            : '检测会话未就绪：服务端未下发会话标识，请重新叫号')
          : '暂无待测患者'
      })
      // 第 4 步：检查设备连接与患者配置资料；无有效会话不下发参数、不进入采集。
      if (this.scale && this.data.connected && sessionReady && station.currentQueueItem.patientSummary) {
        try {
          await this.scale.configurePatient({
            gender: Number(nextPatient.gender),
            age: Number(nextPatient.age),
            height: Number(nextPatient.height)
          })
        } catch (configError) {
          this.setData({ errorText: (configError.message || '体脂秤参数下发失败') + '，请检查身高/年龄/性别资料后重试叫号', measuring: false })
        }
      }
    } catch (error) {
      this.handleStationError(error, '下一位失败')
    } finally {
      this.setData({ loading: false })
    }
  },

  /**
   * 统一错误处置（设计 §17）：
   * - 410 二维码/检测会话过期 → 清空本地会话态 + 固定文案，绝不自动重放旧会话；
   * - 409 状态冲突 → 若响应回传当前服务端状态则据此刷新恢复页面，否则仅提示；
   * - 其他 → 原始 message 提示。
   */
  handleStationError (error, fallbackText) {
    const kind = classifyStationError(error)
    if (kind === 'expired') {
      // 会话彻底作废：停采集、清缓冲/累积器、清幂等 key（下一次叫号是新动作，绝不自动重放）
      this.abortMeasurementSession()
      this.measurementIdempotencyKey = ''
      this.setData({
        measuring: false,
        canConfirm: false,
        saving: false,
        errorText: SESSION_EXPIRED_TEXT,
        statusText: SESSION_EXPIRED_TEXT
      })
      wx.showToast({ title: SESSION_EXPIRED_TEXT, icon: 'none' })
      return
    }
    if (kind === 'conflict') {
      // 冲突时保留幂等 key：修正前置状态（如刷新后重试）仍属同一用户动作，不得中途换 key（§14）。
      const stale = error && error.stationState
      let conflictText = '操作冲突：该患者队列状态已变化'
      if (stale) {
        this.applyStation(stale)
        conflictText += '，已按服务端最新状态刷新'
      } else {
        conflictText += '，请刷新后重试'
      }
      this.setData({ errorText: conflictText, measuring: false, canConfirm: false })
      return
    }
    this.setData({ errorText: (error && error.message) || fallbackText })
  },

  async skipCurrent () {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId || !this.data.currentQueueItem) return
    // 换人前先清采集态，丢弃在途延迟帧；旧测量动作幂等 key 一并终结
    this.abortMeasurementSession()
    this.measurementIdempotencyKey = ''
    try {
      const station = await stationApi.skipQueueItem(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: createActionKey('station-skip')
      })
      this.applyStation(station)
    } catch (error) {
      this.handleStationError(error, '跳过失败')
    }
  },

  async requeueCurrent () {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId || !this.data.currentQueueItem) return
    // 重排即换人：先清采集态与帧缓冲；旧测量动作幂等 key 一并终结
    this.abortMeasurementSession()
    this.measurementIdempotencyKey = ''
    try {
      const station = await stationApi.requeueQueueItem(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: createActionKey('station-requeue')
      })
      this.applyStation(station)
    } catch (error) {
      this.handleStationError(error, '重排失败')
    }
  },

  /**
   * 多帧累积主流程（设计 §9.1）：
   * - 稳定体重帧 / 身体指标分段帧 → 只更新 metricAccumulator；
   * - 0x30 完成帧 → 只触发完成判断，不覆盖任何已积累指标；
   * - 完成时复制累积器形成不可变草稿快照并保存。
   */
  async onScaleResult (result) {
    // 类型闸门：deviceType 不匹配后不得再消费任何 BLE 数据
    if (this.data.deviceTypeMismatch || !this.measurementSessionId) return
    // 第 6 步：只接收属于当前【服务端会话】且晚于其启动时间的数据 ——
    // 帧上带旧 measurementSessionId 的迟到结果一律丢弃；无标记时退回时间窗防护。
    if (!acceptsFrameForSession(
      { measurementSessionId: this.measurementSessionId, startedAt: this.measurementSessionStartedAt },
      result
    )) return
    if (!result || !Array.isArray(result.metrics)) return
    accumulateScaleMetric(this.metricAccumulator, result)
    const complete = !!result.complete
    if (complete) {
      this.measurementCompleteReceived = true
      this.stopMeasurementTimeout()
    }
    const snapshot = snapshotScaleMetrics(this.metricAccumulator)
    const readiness = evaluateDraftReadiness(this.metricAccumulator, this.measurementCompleteReceived)
    if (!readiness.ready) {
      // 未完成/缺体重：只作为本地提示展示，绝不提交草稿
      this.setData({
        metrics: snapshot,
        measuring: !complete,
        canConfirm: false,
        statusText: complete ? readiness.reason : '采集中：等待体脂秤稳定完成信号…'
      })
      return
    }
    // 冻结的不可变草稿快照：即使后续再进帧也不会污染本次提交
    const draftSnapshot = Object.freeze(snapshot)
    this.draftSnapshot = draftSnapshot
    this.setData({
      metrics: draftSnapshot,
      measuring: false,
      canConfirm: false,
      statusText: '测量完成，正在生成草稿…'
    })
    await this.saveMeasurementDraft(draftSnapshot)
  },

  onScaleState (state) {
    if (state.state === 'connected') {
      this.setData({ connected: true, statusText: '体脂秤已连接' })
      return
    }
    if (state.state === 'reconnecting') {
      this.setData({ statusText: '体脂秤重连中…' })
      return
    }
    if (state.state === 'error') {
      this.setData({ connected: false, errorText: state.detail || '体脂秤连接失败' })
    }
  },

  async scanDevice () {
    if (this.data.deviceTypeMismatch) {
      wx.showToast({ title: '请扫描正确的设备二维码', icon: 'none' })
      return
    }
    if (this.data.scanning) return
    this.setData({ scanning: true, errorText: '', statusText: '正在扫描体脂秤…' })
    try {
      const devices = await this.scale.startScan({ timeoutMs: 8000 })
      this.setData({
        devices,
        deviceNames: devices.map(item => item.name || item.localName || item.deviceId),
        deviceIndex: devices.length ? 0 : -1,
        statusText: devices.length ? '请选择体脂秤并连接' : '未发现体脂秤'
      })
    } catch (error) {
      this.setData({ errorText: error.message || '蓝牙扫描失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ scanning: false })
    }
  },

  onDeviceChange (event) {
    this.setData({ deviceIndex: Number(event.detail.value) })
  },

  async connectDevice () {
    if (this.data.deviceTypeMismatch) {
      wx.showToast({ title: '请扫描正确的设备二维码', icon: 'none' })
      return
    }
    const device = this.data.devices[this.data.deviceIndex]
    if (!device) {
      wx.showToast({ title: '请先扫描并选择体脂秤', icon: 'none' })
      return
    }
    this.setData({ connecting: true, errorText: '' })
    try {
      await this.scale.connect(device)
      this.setData({ connected: true, statusText: '已连接体脂秤' })
    } catch (error) {
      this.setData({ errorText: error.message || '体脂秤连接失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  async saveMeasurementDraft (metrics = this.data.metrics) {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId || !this.data.currentQueueItem) return
    // 未完成/超时/断连的数据禁止提交草稿（设计 §9.1）：只允许携带完成快照进入。
    const readiness = evaluateDraftReadiness(this.metricAccumulator || {}, this.measurementCompleteReceived === true)
    if (!readiness.ready || !Array.isArray(metrics) || !metrics.length) {
      this.setData({ measuring: false, canConfirm: false, statusText: `${readiness.reason}；数据仅作现场提示，未提交` })
      return
    }
    const profile = patientProfile(this.data.currentQueueItem)
    this.setData({ saving: true, errorText: '' })
    try {
      // v2 硬前提（设计 §8）：没有服务端下发的会话 ID 绝不允许提交草稿。
      if (stationApi.getStationApiVersion() === 'v2' && !this.measurementSessionId) {
        this.setData({ measuring: false, canConfirm: false, statusText: SESSION_EXPIRED_TEXT })
        return
      }
      // 幂等复用（§14 客户端部分）：本次测量动作固定用建会话时生成的 key，
      // 失败重试沿用同一 key 直到服务端明确成功/失败，绝不中途换 key。
      const station = await stationApi.saveMeasurementDraft(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: this.measurementIdempotencyKey || createActionKey('station-draft'),
        // v2 必填：服务端 callNext 下发的 measurementSessionId（v1 通道由 api 层剥离，不进请求体）
        measurementSessionId: stationApi.getStationApiVersion() === 'v2' ? (this.measurementSessionId || '') : '',
        deviceId: this.scale?.deviceId || '',
        measuredAt: currentTimestamp(),
        gender: profile.gender,
        age: profile.age,
        height: profile.height,
        metrics: metrics.map(item => ({
          type: item.name,
          value: item.value,
          unit: item.unit
        }))
      })
      if (station.deviceType && !isStationDeviceTypeAllowed('SCALE', station.deviceType)) {
        // 服务端返回了不匹配类型的场次：停止 BLE 并清态
        this.applyStation(station)
        return
      }
      // 明确成功：结束会话上下文并消费本次幂等 key（同一动作不再复用）
      this.stopMeasurementTimeout()
      this.measurementIdempotencyKey = ''
      this.draftSnapshot = null
      this.setData({
        currentDraft: station.currentDraft || currentDraftFromQueueItem(station.currentQueueItem || this.data.currentQueueItem),
        canConfirm: true,
        measuring: false,
        statusText: '草稿已保存，等待医生确认'
      })
    } catch (error) {
      // 410 → handleStationError 清态并提示重新叫号；409 → 按服务端回传状态刷新恢复。
      // 网络层错误（含超时/结果未知）保留 measurementIdempotencyKey，重试沿用同一 key（§14）。
      if (classifyStationError(error) === 'generic') {
        this.setData({ errorText: (error.message || '草稿保存失败') + '，请重试提交' })
      } else {
        this.handleStationError(error)
      }
    } finally {
      this.setData({ saving: false })
    }
  },

  async confirmMeasurement () {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId || !this.data.currentQueueItem || !this.data.currentDraft) return
    // v2 必填 measurementSessionId（设计 §8）：会话已失效/过期时不得再发起确认
    if (stationApi.getStationApiVersion() === 'v2' && !this.measurementSessionId) {
      this.setData({ errorText: SESSION_EXPIRED_TEXT, canConfirm: false, measuring: false })
      return
    }
    this.setData({ saving: true, errorText: '' })
    try {
      const station = await stationApi.confirmMeasurement(this.data.stationId, this.data.currentQueueItem.id, this.data.currentDraft.id, {
        idempotencyKey: createActionKey('station-confirm'),
        measurementSessionId: this.measurementSessionId || ''
      })
      this.applyStation(station)
      // 确认后本次检测会话闭环：清会话与幂等 key，等待下一次叫号下发新会话
      this.abortMeasurementSession()
      this.setData({
        currentDraft: station.currentDraft || this.data.currentDraft,
        canConfirm: false,
        measuring: false,
        statusText: '测量已确认'
      })
    } catch (error) {
      this.handleStationError(error, '确认失败')
    } finally {
      this.setData({ saving: false })
    }
  },

  async closeStation () {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId) return
    const discardDraftIds = this.data.currentDraft?.id ? [this.data.currentDraft.id] : []
    this.setData({ loading: true, errorText: '' })
    try {
      const station = await stationApi.closeStation(this.data.stationId, {
        idempotencyKey: createActionKey('station-close'),
        discardDraftIds
      })
      this.applyStation(station)
      this.abortMeasurementSession()
      this.measurementIdempotencyKey = ''
      this.setData({ statusText: '场次已关闭', canConfirm: false, measuring: false })
    } catch (error) {
      this.handleStationError(error, '关闭场次失败')
    } finally {
      this.setData({ loading: false })
    }
  },

  copyToken () {
    if (!this.data.qrPayload) return
    wx.setClipboardData({
      data: this.data.qrPayload,
      success: () => wx.showToast({ title: '签到信息已复制', icon: 'success' })
    })
  },

  async retry () {
    // 设备类型不匹配时唯一正确动作是扫正确的码，不得借重试加载错误场次
    if (this.data.deviceTypeMismatch) {
      wx.showToast({ title: '请扫描正确的设备二维码', icon: 'none' })
      return
    }
    try {
      if (!this.data.stationId) {
        await this.createStation()
        return
      }
      await this.refreshStation(this.data.stationId)
      this.setData({ errorText: '' })
    } catch (error) {
      this.handleStationError(error, '场次加载失败')
    }
  },

  onReady () {
    this.qrReady = true
    this.drawCheckinQr()
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
