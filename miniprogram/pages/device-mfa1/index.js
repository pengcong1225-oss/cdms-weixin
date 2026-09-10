/* MFA-1 多参数检测仪工作站（血糖/尿酸/血脂/血压）：复用体脂秤场次机制（deviceType=MFA1），扫码签到 → 叫号 → 测量 → 0x78 结果 → 草稿 → 确认。 */
const stationApi = require('../../utils/station-api')
const { ensureSession } = require('../../utils/auth-guard')
const { Mfa1Ble } = require('../../services/mfa1Ble')
const { buildQrMatrix, createCheckinPayload, drawQr } = require('../../utils/scale-qr')
const idempotency = require('../../utils/idempotency')

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function metricLabel (name) {
  const labels = {
    glucose: '血糖',
    uricAcid: '血尿酸',
    tc: '总胆固醇',
    hdl: '高密度脂蛋白',
    tg: '甘油三酯',
    ldl: '低密度脂蛋白',
    systolic: '收缩压',
    diastolic: '舒张压',
    heartRate: '心率',
    battery: '电量'
  }
  return labels[name] || name
}

function metricText (metric) {
  return {
    name: valueText(metric?.name || metric?.type),
    value: metric?.value,
    unit: valueText(metric?.unit),
    state: valueText(metric?.state),
    partial: !!metric?.partial, // 血脂多帧未凑满时降级上报的标记（透传给 wxml）
    fastState: metric?.fastState, // 设备回显 D5：草稿序列化时映射血糖 context
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
    genderText: valueText(summary.genderText, valueText(summary.gender)),
    ageText: valueText(summary.age)
  }
}

function currentDraftFromQueueItem (item) {
  if (!item) return null
  if (!item.draftId) return null
  return {
    id: valueText(item.draftId),
    status: valueText(item.draftStatus, 'RESULT_PENDING')
  }
}

/**
 * 设备类型隔离（设计 §11）：MFA-1 工作站仅接受 MFA1 场次。
 * normalizeStation 对缺失 deviceType 回填 'SCALE'，故 SCALE/老数据在 MFA1 页面一律拒绝——
 * 这是阶段一止血预期：MFA1 场次由后端显式返回 deviceType=MFA1 后才可用。
 */
function isStationDeviceTypeAllowed (expected, actual) {
  const text = String(actual === null || actual === undefined || actual === '' ? expected : actual).toUpperCase()
  return text === String(expected).toUpperCase()
}

/**
 * 阶段二 MFA1 v2 上线开关（设计 §10.1 / §20 阶段二）：true = 恢复血脂(TC/HDL/TG/LDL)、
 * 血压(收缩压/舒张压)、心率入口并正常入草稿（含 context/partial）；
 * false = 回退到阶段一收口形态（隐藏血脂/血压、结果层丢弃），供灰度快速回退。
 */
const USE_V2 = true

/**
 * 阶段一临时收口（已由上方 USE_V2 取代其常态语义，仅在 USE_V2=false 回退时生效）：
 * 血脂/血压入口隐藏并在结果层丢弃。解析层 mfa1Ble.js 两态都不改。
 */
const MEASUREMENT_ITEMS_V1 = [
  { key: 'glucose', label: '血糖', enabled: true, note: '' },
  { key: 'uricAcid', label: '血尿酸', enabled: true, note: '' },
  { key: 'lipid', label: '血脂（TC/HDL/TG/LDL）', enabled: false, note: '即将开放' },
  { key: 'bloodPressure', label: '血压', enabled: false, note: '即将开放' }
]
// v2 全量项目：血糖带上下文选择，血脂/血压/心率全部开放
const MEASUREMENT_ITEMS_V2 = [
  { key: 'glucose', label: '血糖（空腹/餐后/随机）', enabled: true, note: '' },
  { key: 'uricAcid', label: '血尿酸', enabled: true, note: '' },
  { key: 'lipid', label: '血脂（TC/HDL/TG/LDL）', enabled: true, note: '' },
  { key: 'bloodPressure', label: '血压 / 心率', enabled: true, note: '' }
]
// 收口期间禁止进入草稿的指标（血脂四件套 + 血压两项；v2 下不再使用 heartRate 阻断）
const BLOCKED_METRIC_NAMES = ['tc', 'hdl', 'tg', 'ldl', 'systolic', 'diastolic']

/** 收口过滤（USE_V2=false 生效）：true = 允许展示/提交；false = 阶段一隐藏项目，丢弃并提示。 */
function measurementItemAllowedUnderFreeze (name) {
  if (USE_V2) return true
  return !BLOCKED_METRIC_NAMES.includes(String(name || ''))
}

/**
 * 血糖上下文（设计 §10.1）：FASTING 空腹 / POSTPRANDIAL 餐后 / RANDOM 随机 / UNKNOWN。
 * 协议依据：《MFA-1 BLE 蓝牙通讯协议》0x78 T1=1 的 D5 只区分 1=空腹、2=餐后，
 * 无「随机」编码 → 设备回显仅能映射 FASTING/POSTPRANDIAL；RANDOM 只能由医生界面显式选择。
 * 默认 UNKNOWN，且要求医生在叫号后【显式确认】过本次测量语境才允许提交草稿。
 */
const GLUCOSE_CONTEXT_OPTIONS = [
  { code: 'UNKNOWN', label: '未指定（需医生确认）' },
  { code: 'FASTING', label: '空腹' },
  { code: 'POSTPRANDIAL', label: '餐后' },
  { code: 'RANDOM', label: '随机' }
]
const CONTEXT_BY_FAST_STATE = { 1: 'FASTING', 2: 'POSTPRANDIAL' }

/** 草稿用血糖 context：优先医生显式选择；否则取设备回显；两者皆无 → UNKNOWN。 */
function resolveGlucoseContext (doctorCode, fastState) {
  const doctor = String(doctorCode || '').toUpperCase()
  if (GLUCOSE_CONTEXT_OPTIONS.some(item => item.code === doctor) && doctor !== 'UNKNOWN') return doctor
  const device = CONTEXT_BY_FAST_STATE[Number(fastState)]
  return device || 'UNKNOWN'
}

/**
 * 草稿指标序列化（设计 §10.1）：
 * - glucose 必带 context；
 * - tc/hdl/tg/ldl 在本批血脂未凑齐四项时统一标记 partial=true（UI 显示「部分血脂结果」）；
 * - battery 不是患者检测结果，调用方负责剔除。
 */
const LIPID_METRIC_NAMES = ['tc', 'hdl', 'tg', 'ldl']
function buildDraftMetrics (metrics, options = {}) {
  const list = Array.isArray(metrics) ? metrics : []
  const lipidNames = new Set(list.filter(item => item && LIPID_METRIC_NAMES.includes(String(item.name))).map(item => String(item.name)))
  const lipidPartial = lipidNames.size > 0 && lipidNames.size < LIPID_METRIC_NAMES.length
  const out = []
  for (const item of list) {
    if (!item || !item.name || item.name === 'battery') continue
    const metric = { type: String(item.name), value: item.value, unit: String(item.unit || '') }
    if (metric.type === 'glucose') {
      metric.context = resolveGlucoseContext(options.glucoseContext, item.fastState)
    }
    if (LIPID_METRIC_NAMES.includes(metric.type) && (lipidPartial || item.partial === true)) {
      metric.partial = true
    }
    out.push(metric)
  }
  return out
}

/** 本批指标是否构成「部分血脂结果」（任一血脂项缺失或带 partial 标记）。 */
function hasPartialLipid (metrics) {
  const list = Array.isArray(metrics) ? metrics : []
  const present = new Set(list.filter(item => item && LIPID_METRIC_NAMES.includes(String(item.name))).map(item => String(item.name)))
  if (!present.size) return false
  if (present.size < LIPID_METRIC_NAMES.length) return true
  return list.some(item => item && LIPID_METRIC_NAMES.includes(String(item.name)) && item.partial === true)
}

// 页面实际暴露的项目配置按 USE_V2 选取（wxml 直接渲染 data.measurementItems）
const MEASUREMENT_ITEMS = USE_V2 ? MEASUREMENT_ITEMS_V2 : MEASUREMENT_ITEMS_V1

// 统一措辞（交付项 4，与体脂秤工作站同一句）：会话过期 / 部分结果提示。
const SESSION_EXPIRED_TEXT = '本次检测会话已过期，请重新叫号'
const PARTIAL_RESULT_TEXT = '部分血脂结果'

/**
 * 错误语义分类（设计 §17）：expired=410 会话/二维码过期（清态不可重放）；
 * conflict=409 状态冲突（按服务端回传状态刷新恢复）；generic=其他。
 */
function classifyStationError (error) {
  const code = Number(error && (error.statusCode || error.code))
  if ((error && error.expiredSession === true) || code === 410) return 'expired'
  if ((error && error.stateConflict === true) || code === 409) return 'conflict'
  return 'generic'
}

/** v2 callNext/getStation 响应中的服务端检测会话 ID。 */
function serverMeasurementSessionIdFrom (station) {
  if (!station || typeof station !== 'object') return ''
  if (station.measurementSessionId) return String(station.measurementSessionId)
  const item = station.currentQueueItem || station.currentDraft
  return item && item.measurementSessionId ? String(item.measurementSessionId) : ''
}

/** 会话归属判定（设计 §8 第 6 步）：旧 sessionId 迟到帧丢弃；无标记退回时间窗。 */
function acceptsFrameForSession (session, frameResult) {
  if (!session || !session.measurementSessionId) return false
  const frameSession = frameResult && frameResult.measurementSessionId
  if (frameSession && String(frameSession) !== String(session.measurementSessionId)) return false
  const receivedAt = frameResult && Number(frameResult.receivedAt)
  if (Number.isFinite(receivedAt) && receivedAt < Number(session.startedAt || 0)) return false
  return true
}

// 导出纯函数与配置供 node 测试直接驱动：挂到 globalThis 命名空间槽位，小程序运行时与 Page 注册均不受影响。
globalThis.__cdmsMfa1StationTestables = {
  isStationDeviceTypeAllowed, MEASUREMENT_ITEMS, MEASUREMENT_ITEMS_V1, MEASUREMENT_ITEMS_V2,
  BLOCKED_METRIC_NAMES, measurementItemAllowedUnderFreeze, USE_V2,
  GLUCOSE_CONTEXT_OPTIONS, CONTEXT_BY_FAST_STATE, resolveGlucoseContext,
  buildDraftMetrics, hasPartialLipid, LIPID_METRIC_NAMES,
  SESSION_EXPIRED_TEXT, PARTIAL_RESULT_TEXT, classifyStationError,
  serverMeasurementSessionIdFrom, acceptsFrameForSession
}

Page({
  // ---- 动作级幂等 key（§14 客户端部分）：一次用户动作一个 key，成功/业务拒绝才消费 ----
  ensureActionTracker () {
    if (!this.actionTracker) {
      this.actionTracker = idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey })
    }
    return this.actionTracker
  },

  actionKey (name) {
    return this.ensureActionTracker().key(name)
  },

  settleAction (name) {
    this.ensureActionTracker().release(name)
  },

  releaseAllActions () {
    if (this.actionTracker) this.actionTracker.releaseAll()
  },

  settleActionIfRejected (name, error) {
    // 网络超时/5xx/409 保留 key 等待重试；明确业务拒绝(4xx)才消费（§14）
    if (idempotency.isRejectedFailure(error)) this.settleAction(name)
  },

  // 新检测会话 = 新动作：先消费旧草稿 key，再生成本次测量动作的 key（§8 切换患者）
  beginDraftActionKey () {
    this.settleAction('station-draft')
    return this.actionKey('station-draft')
  },

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
    measurementItems: MEASUREMENT_ITEMS,
    glucoseContextOptions: GLUCOSE_CONTEXT_OPTIONS.map(item => item.label),
    glucoseContextIndex: 0,
    glucoseContextCode: 'UNKNOWN',
    glucoseContextConfirmed: false,
    glucoseContextText: '未指定（需医生确认）',
    partialLipidText: '',
    devices: [],
    deviceNames: [],
    deviceIndex: -1,
    connected: false,
    batteryText: ''
  },

  async onLoad (query = {}) {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (session.activeRole !== 'DOCTOR') {
        this.setData({ errorText: '请先使用医生账号登录' })
        return
      }
      this.mfa1 = new Mfa1Ble({
        onState: state => this.onMfa1State(state),
        onResult: result => this.onMfa1Result(result)
      })
      // 会话级状态（不进 data）：检测会话上下文（阶段二起 measurementSessionId 为服务端 v2 下发 UUID）
      this.measurementSessionId = ''
      this.measurementSessionQueueItemId = ''
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
      this.setData({ loading: false, creating: false, errorText: error?.statusCode === 401 ? '登录状态已失效，请重新登录' : 'MFA-1 工作站加载失败，请稍后重试' })
    }
  },

  onUnload () {
    this.stopMeasurementTimeout()
    this.releaseAllActions()
    if (this.mfa1) {
      this.mfa1.disconnect().catch(() => {})
      this.mfa1.destroy()
    }
  },

  async createStation () {
    this.setData({ creating: true, loading: true, errorText: '' })
    try {
      const station = await stationApi.createStation({
        stationName: 'MFA-1 测量轮测场次',
        deviceType: 'MFA1',
        idempotencyKey: this.actionKey('station-create')
      })
      // 明确成功：消费本次创建动作的 key（§14）
      this.settleAction('station-create')
      const stationId = valueText(station.id || station.stationId, '')
      if (stationId) {
        this.setData({ stationId })
      }
      this.applyStation(station)
      await this.refreshStation(stationId || station.id || station.stationId)
      // v2：医生视图不再下发明文 checkinToken，二维码须走 /qr 端点签发一次（§12.2）
      await this.issueQrForStation(stationId || station.id || station.stationId)
    } catch (error) {
      this.settleActionIfRejected('station-create', error)
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

  applyStation (station = {}) {
    // 设备类型隔离（设计 §11）：MFA-1 工作站仅接受 MFA1 场次，不匹配时停止一切 BLE 操作。
    if (!isStationDeviceTypeAllowed('MFA1', station.deviceType)) {
      // 不匹配：先停 BLE/清态，再显式提示“请扫描正确的设备二维码”（设计 §11）
      this.resetMeasurementState('设备类型不匹配：请扫描正确的设备二维码')
      this.setData({ deviceTypeMismatch: true, measuring: false, canConfirm: false, statusText: '请扫描正确的设备二维码（本页面仅支持 MFA-1 场次）' })
      return
    }
    if (this.data.deviceTypeMismatch) {
      // 类型恢复匹配后同样先清采集态（换场次即新会话），再复用页面状态
      this.resetMeasurementState()
      this.setData({ deviceTypeMismatch: false })
      wx.showToast({ title: '已切换到 MFA-1 场次', icon: 'none' })
    }
    const queue = Array.isArray(station.queue) ? station.queue : []
    const currentQueueItem = station.currentQueueItem || queue.find(item => ['CALLED', 'MEASURING', 'RESULT_PENDING'].includes(String(item.status || ''))) || null
    const currentDraft = station.currentDraft || currentDraftFromQueueItem(currentQueueItem)
    const nextStationId = valueText(station.id || station.stationId, this.data.stationId)
    const nextToken = valueText(station.checkinToken, this.data.checkinToken)
    this.setData({
      stationId: nextStationId,
      stationStatus: valueText(station.status, 'OPEN'),
      checkinToken: nextToken,
      // v2 场次视图无明文 token，二维码由 /qr 端点签发（issueQrForStation 管理 qrPayload）；
      // v1 灰度响应仍带 checkinToken 时才本地拼接，避免 v2 下把已签发的 payload 清空。
      qrPayload: nextToken ? createCheckinPayload(nextStationId, nextToken) : this.data.qrPayload,
      tokenExpiresAt: valueText(station.tokenExpiresAt),
      queue,
      currentQueueItem,
      currentDraft,
      // 仅当服务端回传了指标快照（草稿恢复场景）才覆盖本地展示；无快照时保留当前采集结果，
      // 避免叫号/刷新后的 applyStation 把已到达的 BLE 结果清空。
      metrics: currentQueueItem && Array.isArray(currentQueueItem.metrics) && currentQueueItem.metrics.length
        ? currentQueueItem.metrics.map(metricText)
        : this.data.metrics,
      canConfirm: valueText(currentDraft?.status || currentQueueItem?.draftStatus) === 'RESULT_PENDING',
      statusText: currentQueueItem
        ? `${patientProfile(currentQueueItem).maskedName} 已在队列中`
        : valueText(station.status, 'OPEN') === 'OPEN'
          ? '等待下一位患者'
          : '场次已关闭'
    }, () => this.drawCheckinQr())
  },

  /**
   * 签发并渲染场次二维码（v2 §12.2）：调 /qr 端点拿一次性 qrPayload 后绘制。
   * v1 灰度（响应带 checkinToken）时沿用本地拼接；两者都不可得则保持面板隐藏并提示。
   */
  async issueQrForStation (stationId) {
    const target = valueText(stationId, this.data.stationId)
    if (!target) return
    try {
      if (stationApi.getStationApiVersion() === 'v2') {
        const issued = await stationApi.issueStationQr(target)
        if (issued.qrPayload) {
          this.setData({ qrPayload: issued.qrPayload, tokenExpiresAt: issued.tokenExpiresAt || this.data.tokenExpiresAt }, () => this.drawCheckinQr())
          return
        }
        // v2 但签发为空：清掉旧 payload 让面板隐藏，避免展示过期码
        this.setData({ qrPayload: '' }, () => this.drawCheckinQr())
        this.setData({ statusText: '二维码签发失败，请重试' })
        return
      }
      // v1 灰度：从场次视图取 checkinToken 本地拼接
      const station = this.data.stationId ? await stationApi.getStation(target) : null
      const token = valueText(station && station.checkinToken, this.data.checkinToken)
      this.setData({ qrPayload: createCheckinPayload(target, token) }, () => this.drawCheckinQr())
    } catch (error) {
      this.setData({ errorText: error.message || '二维码签发失败' })
    }
  },

  drawCheckinQr () {
    if (!this.qrReady || !this.data.qrPayload || typeof wx.createCanvasContext !== 'function') return
    try {
      const matrix = buildQrMatrix(this.data.qrPayload)
      drawQr(wx.createCanvasContext('mfa1Qr', this), matrix, { size: 240, quiet: 4 })
    } catch (error) {
      this.setData({ errorText: error.message || '二维码生成失败' })
    }
  },

  /** 仅在有扫描进行中时停止它，避免叫号/切人与 BLE 发现并发；已结束的扫描不清设备列表。 */
  stopActiveScan () {
    try {
      if (this.data.scanning && this.mfa1 && typeof this.mfa1.stopScan === 'function') this.mfa1.stopScan().catch(() => {})
    } catch (_) { /* 忽略 */ }
  },

  /**
   * 丢弃 BLE 通知残留半帧，旧连接周期的数据不再进入新会话。
   * 保留【同一个】FrameAssembler 实例：Mfa1Ble 的值监听器按 this.assembler 动态取用，
   * 替换实例字段会造成“页面清一个、监听器写另一个”的分裂缓冲；这里逐项复位即可。
   */
  clearBleParseBuffer () {
    this.stopActiveScan()
    const assembler = this.mfa1 && this.mfa1.assembler
    if (!assembler) return
    assembler.buffer = new Uint8Array(0)
  },

  /**
   * 切换患者六步（设计 §8）第 1~3 步的实现：停止采集 → 清 BLE 帧缓冲/血脂挂起态 →
   * 旧服务端会话失效；同时复位血糖上下文选择（语境属于上一位患者，不得带入新会话）。
   */
  resetMeasurementState (reasonText) {
    this.stopMeasurementTimeout()
    this.measurementSessionId = ''
    this.measurementSessionQueueItemId = ''
    this.measurementSessionStartedAt = 0
    this.draftSnapshot = null
    // 幂等 key（§14）由「会话终结动作」（叫号前清场/跳过/重排/关闭/确认成功/410）显式作废；
    // resetMeasurementState 保留 key —— callNext 成功后 adoptMeasurementSession 会重新生成，
    // 草稿失败后的手动重试沿用同一 key。
    try { this.clearBleParseBuffer() } catch (_) { /* BLE 层异常不阻塞清态 */ }
    this.setData({
      glucoseContextIndex: 0,
      glucoseContextCode: 'UNKNOWN',
      glucoseContextConfirmed: false,
      glucoseContextText: GLUCOSE_CONTEXT_OPTIONS[0].label,
      partialLipidText: ''
    })
    if (reasonText) this.setData({ errorText: reasonText })
  },

  /**
   * 装载服务端下发的新检测会话（§8 第 5 步：v2 callNext 响应携带 measurementSessionId UUID）。
   * 必须非空才建会话；缺失返回 false，页面保持无会话态（不收数据、不提交草稿）。
   */
  adoptMeasurementSession (serverSessionId, queueItemId) {
    const sessionId = valueText(serverSessionId, '')
    if (!sessionId) return false
    // 注意顺序：先复位（清旧会话/缓冲/血糖语境），再写入新会话与其幂等 key ——
    // resetMeasurementState 会清空 measurementIdempotencyKey，因此 key 必须在复位之后生成。
    this.resetMeasurementState()
    this.measurementSessionId = sessionId
    this.measurementSessionQueueItemId = valueText(queueItemId, '')
    this.measurementSessionStartedAt = Date.now()
    this.measurementIdempotencyKey = this.beginDraftActionKey()
    // 超时保护：60s 无任何结果即判未完成，保留本地提示、禁止确认（与体脂秤工作站一致）
    this.measurementTimer = setTimeout(() => {
      this.measurementTimer = null
      if (!this.data.measuring || this.data.currentDraft) return
      this.setData({ measuring: false, canConfirm: false, statusText: '测量未完成或已超时：数据仅作现场提示，不能提交草稿，请重新测量' })
    }, 60000)
    return true
  },

  stopMeasurementTimeout () {
    if (this.measurementTimer) { clearTimeout(this.measurementTimer); this.measurementTimer = null }
  },

  /**
   * v1 灰度回退入口：v1 不下发会话 ID，这里生成的只是【本地窗口标记】，绝不写入草稿载荷；
   * v2 通道一律走 adoptMeasurementSession（服务端 UUID 为键）。
   */
  beginMeasurementSession (queueItemId) {
    if (stationApi.getStationApiVersion() === 'v2') {
      this.resetMeasurementState()
      return false
    }
    this.resetMeasurementState()
    this.measurementSessionId = stationApi.createIdempotencyKey(`mfa1-session-local-${valueText(queueItemId, 'na')}`)
    this.measurementSessionQueueItemId = valueText(queueItemId, '')
    this.measurementSessionStartedAt = Date.now()
    this.measurementIdempotencyKey = this.beginDraftActionKey()
    return true
  },

  /** 医生显式选择血糖上下文（picker）；UNKNOWN 之外的选择即视为已确认（设计 §10.1）。 */
  onGlucoseContextChange (event) {
    const index = Number(event?.detail?.value)
    const option = GLUCOSE_CONTEXT_OPTIONS[Number.isFinite(index) ? index : -1] || GLUCOSE_CONTEXT_OPTIONS[0]
    this.setData({
      glucoseContextIndex: Number.isFinite(index) ? index : 0,
      glucoseContextCode: option.code,
      glucoseContextText: option.label,
      glucoseContextConfirmed: option.code !== 'UNKNOWN'
    })
    // 医生显式确认语境后，若结果已到但草稿因 UNKNOWN 门禁挂起 → 立即补交（同一次动作、同一幂等 key）
    if (option.code !== 'UNKNOWN' && !this.data.currentDraft && Array.isArray(this.data.metrics) && this.data.metrics.length) {
      this.saveMeasurementDraft(this.data.metrics).catch(() => {})
    }
  },

  async callNext () {
    if (this.data.deviceTypeMismatch) {
      wx.showToast({ title: '请扫描正确的设备二维码', icon: 'none' })
      return
    }
    if (!this.data.stationId) {
      wx.showToast({ title: '请先创建场次', icon: 'none' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    // 切换患者六步（设计 §8）第 1~3 步：停采集 → 清帧缓冲/血脂挂起态 → 旧会话失效（含血糖语境复位）。
    // 旧测量动作的幂等 key 一并终结；新 key 由叫号成功后的 adoptMeasurementSession 生成。
    this.resetMeasurementState()
    this.measurementIdempotencyKey = ''
    // 本次叫号动作固定一个 key（§14）：网络超时/5xx/409 重试复用，明确成功或业务拒绝才消费
    const callNextKey = this.actionKey('station-next')
    try {
      const station = await stationApi.callNext(this.data.stationId, {
        idempotencyKey: callNextKey
      })
      // 明确成功：消费叫号动作 key（§14）
      this.settleAction('station-next')
      // 第 5 步：叫号成功后保存服务端下发的新会话 ID；v2 缺失即契约异常，保持无会话态。
      const serverSessionId = serverMeasurementSessionIdFrom(station)
      let sessionReady = false
      if (station.currentQueueItem) {
        if (serverSessionId) {
          sessionReady = this.adoptMeasurementSession(serverSessionId, station.currentQueueItem.id)
        } else if (stationApi.getStationApiVersion() === 'v2') {
          this.resetMeasurementState()
        } else {
          sessionReady = this.beginMeasurementSession(station.currentQueueItem.id)
        }
      }
      this.applyStation(station)
      if (this.data.deviceTypeMismatch) return
      // MFA-1 无需 configurePatient（设备侧只要求 0x01 时间同步）：叫号后直接提示测量
      this.setData({
        measuring: !!sessionReady,
        canConfirm: false,
        metrics: [],
        currentDraft: null,
        statusText: station.currentQueueItem
          ? (sessionReady
            ? `已叫号：${patientProfile(station.currentQueueItem || {}).maskedName}，请开始测量`
            : '检测会话未就绪：服务端未下发会话标识，请重新叫号')
          : '暂无待测患者'
      })
    } catch (error) {
      this.handleStationError(error, '下一位失败')
      this.settleActionIfRejected('station-next', error)
    } finally {
      this.setData({ loading: false })
    }
  },

  /**
   * 统一错误处置（设计 §17，与体脂秤工作站同一措辞）：
   * - 410 会话/二维码过期 → 清空本地会话态 + 「本次检测会话已过期，请重新叫号」，不自动重放；
   * - 409 状态冲突 → 若响应回传当前服务端状态则据此刷新恢复；
   * - 其他 → 原始 message。
   */
  handleStationError (error, fallbackText) {
    const kind = classifyStationError(error)
    if (kind === 'expired') {
      this.resetMeasurementState()
      this.measurementIdempotencyKey = ''
      this.releaseAllActions()
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
    this.resetMeasurementState()
    this.measurementIdempotencyKey = ''
    try {
      const station = await stationApi.skipQueueItem(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: this.actionKey('station-skip')
      })
      // 明确成功：消费本次跳过动作 key（§14）
      this.settleAction('station-skip')
      this.applyStation(station)
    } catch (error) {
      this.handleStationError(error, '跳过失败')
      this.settleActionIfRejected('station-skip', error)
    }
  },

  async requeueCurrent () {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId || !this.data.currentQueueItem) return
    this.resetMeasurementState()
    this.measurementIdempotencyKey = ''
    try {
      const station = await stationApi.requeueQueueItem(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: this.actionKey('station-requeue')
      })
      // 明确成功：消费本次重排动作 key（§14）
      this.settleAction('station-requeue')
      this.applyStation(station)
    } catch (error) {
      this.handleStationError(error, '重排失败')
      this.settleActionIfRejected('station-requeue', error)
    }
  },

  async onMfa1Result (result) {
    if (result?.type === 'battery') {
      this.batteryLevel = Number(result.level)
      this.setData({ batteryText: `${Number(result.level)}%` })
      return
    }
    if (result?.type === 'timeSyncAck' || result?.type === 'time') {
      this.setData({ statusText: '设备时间已同步' })
      return
    }
    if (result?.type === 'error') {
      this.setData({ errorText: '设备返回错误应答，请重新测量' })
      return
    }
    // 设备类型闸门：不匹配场次不得消费任何 BLE 结果（设计 §11）
    if (this.data.deviceTypeMismatch) {
      try { console.log('[MFA1-STATION][DROP-FRAME]', 'deviceTypeMismatch', result?.type) } catch (_) {}
      return
    }
    // 挂起进度提示不涉及数据归属，任何会话下都只做文案展示
    if (result?.type === 'lipidPending') {
      // v2：血脂多帧聚合挂起中 —— 明确提示等待续帧，不产生可提交状态
      this.setData({ statusText: USE_V2 ? '血脂分段采集中：等待设备续帧…' : '血脂项目即将开放（回退模式暂不接入），请忽略该结果' })
      return
    }
    // 第 6 步：只接收属于当前服务端会话的数据 —— 带旧 measurementSessionId 的迟到结果丢弃，
    // 无标记的历史帧退回「晚于会话启动时间」窗口防护（设计 §8）。
    if (!acceptsFrameForSession(
      { measurementSessionId: this.measurementSessionId, startedAt: this.measurementSessionStartedAt },
      result
    )) {
      // 调试（真机定位「设备连上了但无数据」）：被会话归属闸门丢弃的帧此前没有任何痕迹。
      try {
        console.log('[MFA1-STATION][DROP-FRAME]', JSON.stringify({
          currentSession: this.measurementSessionId || null,
          startedAt: this.measurementSessionStartedAt || 0,
          frameSession: result?.measurementSessionId || null,
          receivedAt: result?.receivedAt || 0,
          metrics: (result?.metrics || [result?.metric]).filter(Boolean).map(item => item.name)
        }))
      } catch (_) {}
      return
    }
    if (result?.type !== 'result') return
    // v2：血压/血脂完整结果带 metrics 数组；GLU/UA 单 metric 保持兼容
    const incoming = Array.isArray(result.metrics) && result.metrics.length ? result.metrics : [result.metric]
    if (!incoming.length || !incoming[0]) return
    if (result.metric && result.metric.name === 'battery') {
      this.batteryLevel = Number(result.metric.value)
      this.setData({ batteryText: `${result.metric.value}%` })
      return
    }
    // 回退模式（USE_V2=false）：保留阶段一收口 —— 血脂、血压结果整笔丢弃，绝不进入草稿
    if (incoming.some(item => item && !measurementItemAllowedUnderFreeze(item.name))) {
      this.setData({ errorText: '血脂/血压项目即将开放，当前批次结果未录入', measuring: true, canConfirm: false })
      return
    }
    // 无活动检测会话（未叫号/会话已过期被清空）时的结果一律不消费、不提交
    if (!this.measurementSessionId) return
    const metrics = incoming.map(metricText)
    const partialLipid = hasPartialLipid(metrics)
    const suffix = metrics.length > 1 ? `${metrics.length} 项指标` : metrics[0].label
    // 血糖语境联动：设备回显 D5=1/2 映射空腹/餐后，医生显式选择优先；UNKNOWN 需确认（§10.1）
    const glucoseMetric = metrics.find(item => item.name === 'glucose')
    const contextPatch = {}
    if (glucoseMetric) {
      const resolved = resolveGlucoseContext(this.data.glucoseContextCode, glucoseMetric.fastState)
      const index = Math.max(0, GLUCOSE_CONTEXT_OPTIONS.findIndex(option => option.code === resolved))
      contextPatch.glucoseContextIndex = index
      contextPatch.glucoseContextCode = resolved
      contextPatch.glucoseContextText = GLUCOSE_CONTEXT_OPTIONS[index].label
      contextPatch.glucoseContextConfirmed = resolved !== 'UNKNOWN'
    }
    this.setData(Object.assign({
      metrics,
      measuring: false,
      canConfirm: false,
      partialLipidText: partialLipid ? PARTIAL_RESULT_TEXT : ''
    }, contextPatch))
    // 自动草稿门禁：含血糖且语境仍 UNKNOWN → 等医生显式选择后再提交（不静默入库）
    const blockedByContext = !!glucoseMetric && contextPatch.glucoseContextCode === 'UNKNOWN'
    this.setData({
      statusText: blockedByContext
        ? '血糖结果已到：请先选择血糖测量语境（空腹/餐后/随机）再提交草稿'
        : `测量完成（${suffix}${metrics[0].state ? ' · ' + metrics[0].state : ''}${partialLipid ? ' · ' + PARTIAL_RESULT_TEXT : ''}），正在生成草稿…`
    })
    if (!blockedByContext) await this.saveMeasurementDraft(metrics)
  },

  onMfa1State (state) {
    if (state.state === 'connected') {
      this.setData({ connected: true, statusText: 'MFA-1 已连接' })
      return
    }
    if (state.state === 'reconnecting') {
      this.setData({ connected: false, statusText: 'MFA-1 重连中…' })
      return
    }
    if (state.state === 'error') {
      this.setData({ connected: false, errorText: state.detail || 'MFA-1 连接失败' })
    }
  },

  async scanDevice () {
    if (this.data.deviceTypeMismatch) {
      wx.showToast({ title: '请扫描正确的设备二维码', icon: 'none' })
      return
    }
    if (this.data.scanning) return
    this.setData({ scanning: true, errorText: '', statusText: '正在扫描 MFA-1…' })
    try {
      const devices = await this.mfa1.startScan({ timeoutMs: 8000 })
      this.setData({
        devices,
        deviceNames: devices.map(item => item.name || item.localName || item.deviceId),
        deviceIndex: devices.length ? 0 : -1,
        statusText: devices.length ? '请选择 MFA-1 并连接' : '未发现 MFA-1'
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
      wx.showToast({ title: '请先扫描并选择 MFA-1', icon: 'none' })
      return
    }
    this.setData({ connecting: true, errorText: '' })
    try {
      await this.mfa1.connect(device)
      this.setData({ connected: true, statusText: '已连接 MFA-1，等待设备推送结果…' })
      // 连接成功后：同步设备时间并读取电量。尽力而为：失败只提示，不回滚「已连接」状态。
      try {
        await this.mfa1.syncTime()
        await this.mfa1.getBattery()
      } catch (syncError) {
        this.setData({ errorText: '设备时间/电量读取失败，不影响测量：' + (syncError.message || '') })
      }
    } catch (error) {
      this.setData({ errorText: error.message || 'MFA-1 连接失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  async saveMeasurementDraft (metrics = this.data.metrics) {
    if (this.data.deviceTypeMismatch) return
    if (!this.data.stationId || !this.data.currentQueueItem) return
    // v2 硬前提（设计 §8）：无服务端会话 ID 绝不提交草稿
    if (stationApi.getStationApiVersion() === 'v2' && !this.measurementSessionId) {
      this.setData({ measuring: false, canConfirm: false, statusText: SESSION_EXPIRED_TEXT })
      return
    }
    // 自动草稿门禁：本批含血糖且语境仍 UNKNOWN → 必须医生显式选择后才允许提交（§10.1）。
    // 医生手动点击「重新提交草稿」时带 force=true 放行 UNKNOWN（仍可审计，语义由服务端兜底）。
    const list = Array.isArray(metrics) ? metrics : []
    const hasGlucose = list.some(item => item && item.name === 'glucose')
    if (!hasGlucose || this.data.glucoseContextCode === 'UNKNOWN') {
      const needsExplicit = list.some(item => item && item.name === 'glucose')
        && String(this.data.glucoseContextCode || 'UNKNOWN').toUpperCase() === 'UNKNOWN'
      if (needsExplicit) {
        this.setData({ canConfirm: false, statusText: '请先选择血糖测量语境（空腹/餐后/随机）后再提交草稿' })
        return
      }
    }
    this.setData({ saving: true, errorText: '' })
    try {
      // 回退模式双保险：USE_V2=false 时血脂/血压依旧不入草稿
      const resultMetrics = list.filter(item => item.name && item.name !== 'battery' && measurementItemAllowedUnderFreeze(item.name))
      if (!resultMetrics.length) {
        this.setData({ canConfirm: false, statusText: '无可录入指标（血糖/尿酸测量未完成）' })
        return
      }
      // 幂等复用（§14 客户端部分）：本次动作固定用建会话时生成的 key；
      // 失败/超时后页面重试沿用同一 key，明确成功后才清空换新。
      const payload = {
        idempotencyKey: this.measurementIdempotencyKey || this.actionKey('station-draft'),
        // v2 必填：服务端 callNext 下发的检测会话 UUID（v1 通道由 api 层剥离不进请求体）
        measurementSessionId: stationApi.getStationApiVersion() === 'v2' ? (this.measurementSessionId || '') : '',
        deviceId: this.mfa1?.deviceId || '',
        measuredAt: currentTimestamp(),
        // MFA-1 草稿不要求性别/年龄/身高，服务端按 deviceType 分支校验；
        // v2 指标 DTO：glucose 必带 context、未齐血脂标 partial=true（设计 §10.1）
        metrics: buildDraftMetrics(resultMetrics, { glucoseContext: this.data.glucoseContextCode })
      }
      if (Number.isFinite(this.batteryLevel)) {
        // 电量只作设备状态随主记录审计，不作为患者临床检测结果（§10.1 表尾注）
        payload.batteryLevel = this.batteryLevel
        payload.metrics.push({ type: 'battery', value: this.batteryLevel, unit: '%' })
      }
      const station = await stationApi.saveMeasurementDraft(this.data.stationId, this.data.currentQueueItem.id, payload)
      if (station.deviceType && !isStationDeviceTypeAllowed('MFA1', station.deviceType)) {
        this.applyStation(station)
        return
      }
      // 明确成功：消费本次幂等 key
      this.measurementIdempotencyKey = ''
      this.settleAction('station-draft')
      this.draftSnapshot = null
      const partialLipid = hasPartialLipid(resultMetrics)
      this.setData({
        currentDraft: station.currentDraft || currentDraftFromQueueItem(station.currentQueueItem || this.data.currentQueueItem),
        canConfirm: true,
        measuring: false,
        partialLipidText: partialLipid ? PARTIAL_RESULT_TEXT : '',
        statusText: partialLipid ? '草稿已保存（部分血脂结果），等待医生确认' : '草稿已保存，等待医生确认'
      })
    } catch (error) {
      // 410 → 清态并提示重新叫号；409 → 按服务端回传状态刷新恢复。
      // 网络层错误（含超时/结果未知）保留 measurementIdempotencyKey，重试沿用同一 key（§14）；
      // 明确业务拒绝（4xx 非 409）则消费本次草稿 key（§14）。
      if (classifyStationError(error) === 'generic') {
        this.settleActionIfRejected('station-draft', error)
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
    // v2 必填 measurementSessionId：会话失效/过期时不得再发起确认（设计 §8）
    if (stationApi.getStationApiVersion() === 'v2' && !this.measurementSessionId) {
      this.setData({ errorText: SESSION_EXPIRED_TEXT, canConfirm: false, measuring: false })
      return
    }
    this.setData({ saving: true, errorText: '' })
    try {
      const station = await stationApi.confirmMeasurement(this.data.stationId, this.data.currentQueueItem.id, this.data.currentDraft.id, {
        idempotencyKey: this.actionKey('station-confirm'),
        measurementSessionId: this.measurementSessionId || ''
      })
      // 明确成功：消费本次确认动作 key（§14）
      this.settleAction('station-confirm')
      this.settleAction('station-draft')
      this.applyStation(station)
      // 确认后本会话闭环：清会话与幂等 key，等待下一次叫号下发新会话
      this.resetMeasurementState()
      this.setData({
        currentDraft: station.currentDraft || this.data.currentDraft,
        canConfirm: false,
        measuring: false,
        statusText: '测量已确认'
      })
    } catch (error) {
      this.handleStationError(error, '确认失败')
      this.settleActionIfRejected('station-confirm', error)
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
        idempotencyKey: this.actionKey('station-close'),
        discardDraftIds
      })
      // 明确成功：消费本次关闭动作 key（§14）
      this.settleAction('station-close')
      this.applyStation(station)
      this.resetMeasurementState()
      this.measurementIdempotencyKey = ''
      this.setData({ statusText: '场次已关闭', canConfirm: false, measuring: false })
    } catch (error) {
      this.handleStationError(error, '关闭场次失败')
      this.settleActionIfRejected('station-close', error)
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