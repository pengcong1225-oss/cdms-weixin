/* MFA-1 血糖仪单人直接测量（无场次直测，V58）：选患者 → 连设备 → 采血 → 设备推结果 → 确认落库。
   与体脂秤单人直测页（pages/device-scale/index）同构：患者 keyword 搜索 + picker 选择；
   与 MFA-1 扫码轮测工作站（pages/device-mfa1/index）共用 Mfa1Ble 通道与 v2 指标契约；
   差异：直测无场次/草稿——创建直测会话后设备结果直接进入本地确认，服务端以
   measurementSessionId 幂等落库（POST /api/v2/miniapp/mfa1/direct）。 */
const api = require('../../../utils/api')
const mfa1DirectApi = require('../../../utils/mfa1-direct-api')
const { ensureSession } = require('../../../utils/auth-guard')
const { Mfa1Ble } = require('../../../services/mfa1Ble')
const idempotency = require('../../../utils/idempotency')

const PARTIAL_RESULT_TEXT = '部分血脂结果'
const LIPID_METRIC_NAMES = ['tc', 'hdl', 'tg', 'ldl']
/** 协议 D5 只区分 1=空腹 / 2=餐后；直测无医生语境选择器，无回显归一 UNKNOWN（服务端合法语境）。 */
const CONTEXT_BY_FAST_STATE = { 1: 'FASTING', 2: 'POSTPRANDIAL' }

const METRIC_LABELS = {
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

function metricLabel (name) {
  return METRIC_LABELS[name] || name
}

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function metricText (metric) {
  return {
    name: valueText(metric?.name || metric?.type),
    value: metric?.value,
    unit: valueText(metric?.unit),
    state: valueText(metric?.state),
    partial: !!metric?.partial,
    fastState: metric?.fastState,
    label: metricLabel(metric?.name || metric?.type)
  }
}

/** 血糖语境：直测只取设备回显（D5=1 空腹 / 2 餐后），其余 UNKNOWN。 */
function resolveGlucoseContextFromEcho (fastState) {
  return CONTEXT_BY_FAST_STATE[Number(fastState)] || 'UNKNOWN'
}

/** 本批指标是否构成「部分血脂结果」（任一血脂项缺失或带 partial 标记）。 */
function hasPartialLipid (metrics) {
  const list = Array.isArray(metrics) ? metrics : []
  const present = new Set(list.filter(item => item && LIPID_METRIC_NAMES.includes(String(item.name))).map(item => String(item.name)))
  if (!present.size) return false
  if (present.size < LIPID_METRIC_NAMES.length) return true
  return list.some(item => item && LIPID_METRIC_NAMES.includes(String(item.name)) && item.partial === true)
}

/** 确认落库指标序列化：glucose 必带 context；未齐血脂统一 partial=true；电量由调用方剔除。 */
function buildDirectMetrics (metrics) {
  const list = Array.isArray(metrics) ? metrics : []
  const lipidNames = new Set(list.filter(item => item && LIPID_METRIC_NAMES.includes(String(item.name))).map(item => String(item.name)))
  const lipidPartial = lipidNames.size > 0 && lipidNames.size < LIPID_METRIC_NAMES.length
  const out = []
  for (const item of list) {
    if (!item || !item.name || item.name === 'battery') continue
    const metric = { type: String(item.name), value: item.value, unit: String(item.unit || '') }
    if (metric.type === 'glucose') {
      metric.context = resolveGlucoseContextFromEcho(item.fastState)
    }
    if (LIPID_METRIC_NAMES.includes(metric.type) && (lipidPartial || item.partial === true)) {
      metric.partial = true
    }
    out.push(metric)
  }
  return out
}

/** 结果帧归属判定：直测会话建立前的迟到/残留帧一律丢弃（与轮测工作站 §8 第 6 步同语义）。 */
function acceptsFrameForSession (session, frameResult) {
  if (!session || !session.measurementSessionId) return false
  const frameSession = frameResult && frameResult.measurementSessionId
  if (frameSession && String(frameSession) !== String(session.measurementSessionId)) return false
  const receivedAt = frameResult && Number(frameResult.receivedAt)
  if (Number.isFinite(receivedAt) && receivedAt < Number(session.startedAt || 0)) return false
  return true
}

function currentTimestamp () {
  return new Date().toISOString().slice(0, 19)
}

// 纯函数导出供 node 测试驱动（与 device-mfa1/index.js 的 testables 同款机制）
globalThis.__cdmsMfa1DirectTestables = {
  metricLabel, metricText, buildDirectMetrics, hasPartialLipid, LIPID_METRIC_NAMES,
  PARTIAL_RESULT_TEXT, CONTEXT_BY_FAST_STATE, resolveGlucoseContextFromEcho,
  acceptsFrameForSession, METRIC_LABELS
}

Page({
  ensureActionTracker () {
    if (!this.actionTracker) {
      this.actionTracker = idempotency.createIdempotencyTracker({ generator: mfa1DirectApi.createIdempotencyKey })
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

  data: {
    patients: [], patientNames: [], patientIndex: -1, selectedPatient: null,
    keyword: '', searching: false, patientPage: 1, patientHasMore: true,
    devices: [], deviceNames: [], deviceIndex: -1,
    scanning: false, connecting: false, connected: false, batteryText: '',
    measuring: false, saving: false, metrics: [], partialLipidText: '', canConfirm: false,
    statusText: '待连接设备', errorText: ''
  },

  async onLoad () {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (!session || session.activeRole !== 'DOCTOR') {
        this.setData({ errorText: '请先使用医生账号登录' })
        return
      }
    } catch (error) {
      this.setData({ errorText: error.message || '请先使用医生账号登录' })
      return
    }
    this.mfa1 = new Mfa1Ble({
      onState: state => this.onMfa1State(state),
      onResult: result => this.onMfa1Result(result)
    })
    // 直测会话级状态（不进 data）：服务端会话 UUID 是确认落库的幂等锚点
    this.measurementSessionId = ''
    this.measurementSessionStartedAt = 0
    this.measurementIdempotencyKey = ''
    this.batteryLevel = undefined
    this.loadPatients()
  },

  onUnload () {
    this.releaseAllActions()
    if (this.mfa1) {
      this.mfa1.disconnect().catch(() => {})
      this.mfa1.destroy()
    }
  },

  goBack () { wx.navigateBack({ delta: 1 }) },

  // ---- 患者搜索选择（照抄体脂秤单人直测页：keyword 搜索 + picker + 加载更多 + 按 id 去重） ----

  async loadPatients (reset = true) {
    if (this.data.searching) return
    const nextPage = reset ? 1 : this.data.patientPage + 1
    this.setData({ searching: true, errorText: '', patientPage: nextPage })
    try {
      const response = await api.listDoctorPatients({ page: nextPage, pageSize: 20, keyword: this.data.keyword })
      const page = response?.data || response || {}
      const incoming = (page.list || []).filter(item => item?.id != null)
      const patients = reset ? incoming : this.data.patients.concat(incoming)
      // 去重（按 id，字符串化比较，禁止 Number 化雪花/业务 id）
      const seen = new Set()
      const deduped = patients.filter(item => { const k = String(item.id); if (seen.has(k)) return false; seen.add(k); return true })
      const hasMore = incoming.length === 20
      const patch = { patients: deduped, patientNames: deduped.map(item => item.name || `患者${item.id}`), patientHasMore: hasMore }
      this.setData(patch)
    } catch (error) { this.setData({ errorText: error.message || '患者列表加载失败' }) } finally { this.setData({ searching: false }) }
  },

  onKeyword (event) { this.setData({ keyword: String(event.detail.value || '') }) },

  searchPatients () {
    this.setData({ patientHasMore: true })
    this.loadPatients(true)
  },

  loadMorePatients () {
    if (this.data.patientHasMore && !this.data.searching) this.loadPatients(false)
  },

  selectPatient (event) {
    const index = Number(event.detail.value)
    const patient = this.data.patients[index]
    if (!patient) return
    this.setData({
      patientIndex: index,
      selectedPatient: patient,
      metrics: [],
      partialLipidText: '',
      canConfirm: false,
      measuring: false,
      statusText: this.data.connected ? '已连接，开始测量后请患者采血' : '已选择患者，请连接 MFA-1'
    })
  },

  // ---- 设备连接（Mfa1Ble：名称含 mfa 或服务 FFF0） ----

  async scan () {
    if (this.data.scanning) return
    this.setData({ scanning: true, statusText: '正在扫描 MFA-1…', errorText: '' })
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

  onDeviceChange (event) { this.setData({ deviceIndex: Number(event.detail.value) }) },

  async connect () {
    const device = this.data.devices[this.data.deviceIndex]
    if (!device) { wx.showToast({ title: '请先扫描并选择 MFA-1', icon: 'none' }); return }
    this.setData({ connecting: true, errorText: '' })
    try {
      await this.mfa1.connect(device)
      // 连接成功后同步设备时间并读取电量（电量经 onResult 展示）
      await this.mfa1.syncTime()
      await this.mfa1.getBattery()
      this.setData({ connected: true, statusText: this.data.selectedPatient ? '已连接，开始测量后请患者采血' : '已连接 MFA-1' })
    } catch (error) {
      this.setData({ errorText: error.message || 'MFA-1 连接失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  onMfa1State (state) {
    if (state.state === 'connected') this.setData({ connected: true, statusText: 'MFA-1 已连接' })
    if (state.state === 'reconnecting') this.setData({ connected: false, statusText: 'MFA-1 重连中…' })
    if (state.state === 'error') this.setData({ connected: false, errorText: state.detail || 'MFA-1 连接失败' })
  },

  // ---- 测量：创建直测会话 → 请患者采血 → 设备推结果 ----

  async startMeasure () {
    const patient = this.data.selectedPatient
    if (!patient || !this.data.connected) {
      wx.showToast({ title: '请先选择患者并连接 MFA-1', icon: 'none' })
      return
    }
    // 新测量 = 新会话：先消费旧会话的确认 key，再为本次创建动作生成 key（§14）
    this.settleAction('direct-confirm')
    this.setData({ measuring: true, metrics: [], partialLipidText: '', canConfirm: false, errorText: '', statusText: '正在创建直测会话…' })
    try {
      const session = await mfa1DirectApi.createSession({
        patientId: patient.id,
        deviceId: this.mfa1?.deviceId || '',
        idempotencyKey: this.actionKey('direct-session')
      })
      if (!session.measurementSessionId) {
        throw new Error('直测会话创建异常：服务端未下发会话标识')
      }
      // 明确成功：消费创建动作 key，并为本次确认落库生成固定 key（重试复用，成功后消费）
      this.settleAction('direct-session')
      this.measurementSessionId = session.measurementSessionId
      this.measurementSessionStartedAt = Date.now()
      this.measurementIdempotencyKey = this.actionKey('direct-confirm')
      this.setData({ measuring: true, statusText: '请患者采血' })
      wx.showToast({ title: '请患者采血', icon: 'none' })
    } catch (error) {
      this.settleActionIfRejected('direct-session', error)
      this.measurementSessionId = ''
      this.measurementSessionStartedAt = 0
      this.setData({ measuring: false, canConfirm: false, statusText: '待开始测量', errorText: error.message || '直测会话创建失败' })
    }
  },

  onMfa1Result (result) {
    if (result?.type === 'battery') {
      this.batteryLevel = Number(result.level)
      this.setData({ batteryText: `${Number(result.level)}%` })
      return
    }
    if (result?.type === 'timeSyncAck' || result?.type === 'time') {
      this.setData({ statusText: this.data.measuring ? '设备时间已同步，请患者采血' : '设备时间已同步' })
      return
    }
    if (result?.type === 'error') {
      this.setData({ errorText: '设备返回错误应答，请重新测量' })
      return
    }
    if (result?.type === 'lipidPending') {
      this.setData({ statusText: '血脂分段采集中：等待设备续帧…' })
      return
    }
    if (result?.type !== 'result') return
    // 无直测会话（未开始/已保存清态）时的结果一律不消费
    if (!acceptsFrameForSession(
      { measurementSessionId: this.measurementSessionId, startedAt: this.measurementSessionStartedAt },
      result
    )) return
    const incoming = Array.isArray(result.metrics) && result.metrics.length ? result.metrics : [result.metric]
    if (!incoming.length || !incoming[0]) return
    if (result.metric && result.metric.name === 'battery') {
      this.batteryLevel = Number(result.metric.value)
      this.setData({ batteryText: `${result.metric.value}%` })
      return
    }
    const metrics = incoming.map(metricText)
    const partialLipid = hasPartialLipid(metrics)
    const suffix = metrics.length > 1 ? `${metrics.length} 项指标` : metrics[0].label
    this.setData({
      metrics,
      measuring: false,
      canConfirm: true,
      partialLipidText: partialLipid ? PARTIAL_RESULT_TEXT : '',
      statusText: `测量完成（${suffix}${metrics[0].state ? ' · ' + metrics[0].state : ''}${partialLipid ? ' · ' + PARTIAL_RESULT_TEXT : ''}），请确认落库`
    })
  },

  // ---- 确认落库：对患者与指标摘要二次确认后提交直测端点 ----

  confirmSummary () {
    const patient = this.data.selectedPatient
    const summary = (this.data.metrics || []).map(item => `${item.label} ${item.value}${item.unit ? ' ' + item.unit : ''}`).join('；')
    return `患者：${patient ? patient.name : ''}\n结果：${summary || '无'}`
  },

  confirmSave () {
    if (!this.data.canConfirm || !this.data.selectedPatient || !this.measurementSessionId) return
    wx.showModal({
      title: '确认落库测量结果',
      content: this.confirmSummary(),
      confirmColor: '#0c9b6c',
      success: result => { if (result.confirm) this.saveMeasurement() }
    })
  },

  async saveMeasurement () {
    if (!this.measurementSessionId || !this.data.selectedPatient) return
    this.setData({ saving: true, errorText: '' })
    try {
      const result = await mfa1DirectApi.confirmDirect({
        measurementSessionId: this.measurementSessionId,
        patientId: this.data.selectedPatient.id,
        deviceId: this.mfa1?.deviceId || '',
        measuredAt: currentTimestamp(),
        metrics: buildDirectMetrics(this.data.metrics),
        batteryLevel: this.batteryLevel,
        // 幂等复用（§14）：本次确认动作固定用会话建立时生成的 key；失败重试沿用同一 key
        idempotencyKey: this.measurementIdempotencyKey || this.actionKey('direct-confirm')
      })
      // 明确成功：消费确认动作 key
      this.measurementIdempotencyKey = ''
      this.settleAction('direct-confirm')
      this.resetForNextPatient()
      if (result.id) this.setData({ statusText: `已落库（记录 ${result.id}），连接保持中，可继续下一位` })
      wx.showToast({ title: '已落库，可继续下一位', icon: 'success' })
    } catch (error) {
      // 410 会话过期 → 清态；其余保留 key 供重试（网络/5xx/409），业务拒绝(4xx)消费 key
      const code = Number(error && (error.statusCode || error.code))
      if (code === 410) {
        this.resetForNextPatient('检测会话已过期，请重新开始测量')
        wx.showToast({ title: '检测会话已过期，请重新开始测量', icon: 'none' })
        return
      }
      this.settleActionIfRejected('direct-confirm', error)
      this.setData({ errorText: error.message || '落库失败，请重试' })
      wx.showToast({ title: error.message || '落库失败，请重试', icon: 'none' })
    } finally {
      this.setData({ saving: false })
    }
  },

  /** 保存成功/会话终结后复位测量态：连接与患者选择保持，可继续下一位（新会话新 key）。 */
  resetForNextPatient (reasonText) {
    this.measurementSessionId = ''
    this.measurementSessionStartedAt = 0
    this.measurementIdempotencyKey = ''
    this.setData({
      metrics: [],
      partialLipidText: '',
      canConfirm: false,
      measuring: false,
      statusText: reasonText || '已落库，连接保持中，可继续下一位'
    })
  }
})
