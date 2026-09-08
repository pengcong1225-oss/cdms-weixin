const stationApi = require('../../utils/station-api')
const api = require('../../utils/api')
const { ensureSession } = require('../../utils/auth-guard')
const checkinQr = require('../../utils/checkin-qrcode')
const idempotency = require('../../utils/idempotency')

// 患者排队轮询间隔（my-queue 专用接口）
const QUEUE_POLL_INTERVAL_MS = 10000

// 阶段三签到错误文案（交付项 4 / 设计 §17）：
// 410 = token/会话过期；403 = 跨机构/错场景；404 = token 不存在（客户端按失效码处理）。
// 其余错误原样透出（网络层错误由调用方在下方按场景给通用文案）。
const TOKEN_EXPIRED_TEXT = '签到二维码已过期，请联系工作人员重新出示'
const TOKEN_SCOPE_TEXT = '二维码与当前机构或设备不匹配，请重新扫码'

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

// 仅使用患者 DTO 的 waitingAhead 生成"前面还有 N 人"文案；未知时留空
function waitingAheadText (waitingAhead) {
  if (waitingAhead === '' || waitingAhead === null || waitingAhead === undefined) return ''
  const n = Number(waitingAhead)
  if (!Number.isFinite(n) || n < 0) return ''
  return n === 0 ? '前面没有等待人数，请留意叫号' : `前面还有 ${n} 人`
}

function unwrapData (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

/**
 * 新旧二维码分流（交付项 1）：parse 结果 → 路由描述。
 *  - NEW + DEVICE_STATION → 设备场次签到 v2（station checkins，body {token,idempotencyKey}）
 *  - NEW + ORG_CHECKIN    → 机构到场签到 v2（/api/v2/miniapp/checkins）
 *  - LEGACY_STATION       → 老设备场次码，原 v1 通道零改动
 *  - LEGACY_GENERIC       → 老通用机构码，原 v1 通道零改动
 */
function resolveCheckinRoute (payload) {
  if (!payload || typeof payload !== 'object') return null
  if (payload.kind === 'NEW') {
    if (payload.scene === 'DEVICE_STATION') {
      return { target: 'DEVICE', channel: 'v2', stationId: '', token: valueText(payload.token) }
    }
    if (payload.scene === 'ORG_CHECKIN') {
      return { target: 'ARRIVAL', channel: 'v2', token: valueText(payload.token) }
    }
    return null
  }
  if (payload.kind === 'LEGACY_STATION') {
    if (!payload.stationId || !payload.checkinToken) return null
    return { target: 'DEVICE', channel: 'v1', stationId: valueText(payload.stationId), token: valueText(payload.checkinToken) }
  }
  if (payload.kind === 'LEGACY_GENERIC') return { target: 'ARRIVAL', channel: 'v1' }
  // 兼容测试/旧调用方直接传入的解析对象（无 kind 标记但字段齐全）
  if (payload.stationId && payload.checkinToken) {
    return { target: 'DEVICE', channel: 'v1', stationId: valueText(payload.stationId), token: valueText(payload.checkinToken) }
  }
  if (payload.stationId && payload.token) {
    return { target: 'DEVICE', channel: 'v2', stationId: valueText(payload.stationId), token: valueText(payload.token) }
  }
  return null
}

// 错误状态码 → 固定签到文案（410/403/404 语义见 §17；其余回退原 message）
function checkinFailureText (error, fallback = '扫码签到失败') {
  if (error && error.expiredSession === true) return TOKEN_EXPIRED_TEXT
  const code = Number(error && (error.statusCode || error.code))
  if (code === 403) return TOKEN_SCOPE_TEXT
  if (code === 410 || code === 404) return TOKEN_EXPIRED_TEXT
  return (error && error.message) || fallback
}

// 导出纯函数与文案供 node 测试驱动（页面运行不受影响）
globalThis.__cdmsScaleCheckinTestables = {
  TOKEN_EXPIRED_TEXT,
  TOKEN_SCOPE_TEXT,
  checkinFailureText,
  resolveCheckinRoute,
  waitingAheadText
}

Page({
  data: {
    scanning: false,
    submitting: false,
    checkedIn: false,
    checkinKind: '',
    queueNo: '',
    waitingAheadText: '',
    queueMessage: '',
    stationStatus: '',
    stationId: '',
    errorText: '',
    statusText: '请扫描医生工作站二维码',
    checkinDateText: ''
  },

  async onLoad (query = {}) {
    // 设备场次 v2 安全码（token-only）需要场次上下文才能路由到
    // device-stations/{stationId}/checkins；支持调用方以 ?stationId= 带入（契约假设，见交付报告）。
    const contextStationId = valueText(query && query.stationId)
    if (contextStationId) this.setData({ stationId: contextStationId })
    try {
      await ensureSession({ role: 'PATIENT' })
    } catch (error) {
      this.setData({ errorText: error.message || '请先使用患者账号登录' })
    }
  },

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

  settleActionIfRejected (name, error) {
    if (idempotency.isRejectedFailure(error)) this.settleAction(name)
  },

  /**
   * 按动作内容签名取 key（§14.2）：同一动作（同一次扫码、同一个二维码内容）在成功/业务拒绝前
   * 复用同一 key；网络超时后用户重扫【同一个码】仍拿到同一 key；扫到【不同的码】（内容签名变化）
   * 视为新动作 → 先消费旧 key 再生成新 key，避免同 key 不同内容被服务端判 409。
   */
  actionKeyFor (name, signature) {
    const mark = String(signature || '')
    if (!this._actionSignatures) this._actionSignatures = {}
    const previous = this.ensureActionTracker().peek(name)
    if (previous && this._actionSignatures[name] !== undefined && this._actionSignatures[name] !== mark) {
      this.settleAction(name)
    }
    this._actionSignatures[name] = mark
    return this.actionKey(name)
  },

  // ---- token 卫生（交付项 3）：扫码载荷只在页面实例上短暂持有，不入 data/storage/log，
  //      兑换结束或页面卸载/切换即清除 ----
  holdScannedPayload (raw, token) {
    this._scannedRaw = valueText(raw)
    this._scannedToken = valueText(token)
  },

  clearScannedPayload () {
    this._scannedRaw = ''
    this._scannedToken = ''
  },

  async scanCode () {
    if (this.data.scanning || this.data.submitting || this.data.checkedIn) return
    this.setData({ scanning: true, errorText: '', statusText: '正在打开扫码能力…' })
    try {
      const result = await new Promise((resolve, reject) => wx.scanCode({ onlyFromCamera: true, scanType: ['qrCode'], success: resolve, fail: reject }))
      const raw = result && result.result ? String(result.result) : ''
      if (!raw) throw new Error('请扫描 CDMS 签到二维码（医生工作站或机构签到码）')
      const payload = checkinQr.parse(raw)
      // 未知版本/未知 scene/篡改结构 → parse 返回 null，失败关闭（§12/§17）
      if (!payload) throw new Error('请扫描 CDMS 签到二维码（医生工作站或机构签到码）')
      const route = resolveCheckinRoute(payload)
      if (!route) throw new Error('请扫描 CDMS 签到二维码（医生工作站或机构签到码）')
      this.holdScannedPayload(raw, route.token)
      if (route.target === 'DEVICE') await this.submitCheckin(payload, route)
      else await this.submitArrivalCheckin(payload, route)
    } catch (error) {
      // 410/403/404 映射为固定文案（交付项 4）；不记录 token 原文
      this.setData({ errorText: checkinFailureText(error, '扫码签到失败'), statusText: '请重新扫描签到二维码' })
    } finally {
      this.clearScannedPayload()
      this.setData({ scanning: false })
    }
  },

  // 设备场次签到（v1 老码 / v2 安全码共用）：后端对【患者】返回
  // MiniappScaleStationPatientQueueDTO（本人 queueNo/queueStatus/waitingAhead/message），
  // 不返回完整场次视图；这里只取患者可见字段。
  // 分流规则（交付项 1）：LEGACY_STATION → v1（body.checkinToken）；
  // NEW DEVICE_STATION → v2（body.token 取代明文 checkinToken）。
  async submitCheckin (payload = {}, route = null) {
    const resolved = route || resolveCheckinRoute(payload)
    if (!resolved || resolved.target !== 'DEVICE') throw new Error('请扫描医生工作站二维码')
    const token = valueText(resolved.token || payload.checkinToken || payload.token).trim()
    if (!token) throw new Error('该签到二维码缺少场次信息，请重新扫码')
    const channel = String(resolved.channel || 'v1').toLowerCase()
    const stationId = valueText(resolved.stationId || payload.stationId || this.data.stationId).trim()
    // NEW DEVICE_STATION token-only 码（无 stationId）：走 /checkins/token，场次由服务端按 token 解析；
    // 带 stationId（旧码/带场次上下文的新码）仍走 /{stationId}/checkins（v1 明文 / v2 token 按 channel 分流）。
    if (!stationId && channel !== 'v2') throw new Error('该签到二维码缺少场次信息，请重新扫码')
    const keySeed = channel === 'v2' ? 'v2|' + token : channel + '|' + stationId + '|' + token
    const key = this.actionKeyFor('station-checkin', keySeed)
    this.setData({ submitting: true, stationId, statusText: '正在加入测量队列…' })
    try {
      const view = channel === 'v2' && !stationId
        ? await stationApi.createCheckinByToken(token, { idempotencyKey: key })
        : await stationApi.createCheckin(stationId, token, { idempotencyKey: key }, { channel })
      const pollStationId = valueText(view.stationId || stationId)
      this.settleAction('station-checkin')
      this.setData({
        checkedIn: true,
        checkinKind: 'STATION',
        stationId: pollStationId,
        queueNo: view.queueNo === '' ? '' : String(view.queueNo),
        waitingAheadText: waitingAheadText(view.waitingAhead),
        queueMessage: view.message || '',
        stationStatus: view.status || '',
        // §5.1 两级签到：设备场次只写队列，主状态行固定为“设备排队签到成功”
        statusText: '设备排队签到成功，请留意医生叫号',
        errorText: ''
      })
      this.startQueuePolling()
    } catch (error) {
      this.settleActionIfRejected('station-checkin', error)
      throw error
    } finally {
      this.setData({ submitting: false })
    }
  },

  // 机构到场签到（v1 老通用码 / v2 ORG_CHECKIN 安全码）分流入口
  async submitArrivalCheckin (payload = {}, route = null) {
    const resolved = route || resolveCheckinRoute(payload)
    if (!resolved || resolved.target !== 'ARRIVAL') throw new Error('请扫描机构签到二维码')
    if (resolved.channel === 'v2') return this.submitArrivalCheckinV2(resolved.token)
    return this.submitGenericCheckin()
  },

  // 通用签到 v2（NEW ORG_CHECKIN）：POST /api/v2/miniapp/checkins，token 兑换最小 VO
  async submitArrivalCheckinV2 (token) {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      throw new Error('登录状态已失效，请重新登录')
    }
    if (!token) throw new Error('签到二维码缺少令牌，请重新扫码')
    this.setData({ submitting: true, statusText: '正在提交到场签到…' })
    try {
      const key = this.actionKeyFor('arrival-checkin', `v2|${token}`)
      const result = await stationApi.orgCheckinV2(token, { idempotencyKey: key })
      this.settleAction('arrival-checkin')
      const today = new Date()
      const checkinDateText = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
      this.setData({
        checkedIn: true,
        checkinKind: 'ARRIVAL',
        // §5.1 两级签到：机构到场签到文案与设备排队签到区分；成功文案不回退
        statusText: result.checkpointName ? `签到点：${result.checkpointName}` : '到场签到成功',
        checkinDateText,
        errorText: ''
      })
    } catch (error) {
      this.settleActionIfRejected('arrival-checkin', error)
      throw error
    } finally {
      this.setData({ submitting: false })
    }
  },

  startQueuePolling () {
    this.stopQueuePolling()
    if (!this.data.checkedIn || this.data.checkinKind !== 'STATION' || !this.data.stationId) return
    this.refreshMyQueue()
    this.queueTimer = setInterval(() => this.refreshMyQueue(), QUEUE_POLL_INTERVAL_MS)
  },

  stopQueuePolling () {
    if (this.queueTimer) {
      clearInterval(this.queueTimer)
      this.queueTimer = null
    }
  },

  // 轮询 my-queue：只刷新本人排队号、前方等待人数与消息，不引入其他患者信息
  async refreshMyQueue () {
    const stationId = this.data.stationId
    if (!stationId || !this.data.checkedIn || this.data.checkinKind !== 'STATION') return
    try {
      const view = await stationApi.getMyQueue(stationId)
      if (!this.data.checkedIn || this.data.checkinKind !== 'STATION' || this.data.stationId !== stationId) return
      this.setData({
        queueNo: view.queueNo === '' ? '' : String(view.queueNo),
        waitingAheadText: waitingAheadText(view.waitingAhead),
        queueMessage: view.message || '',
        stationStatus: view.status || ''
      })
    } catch (_) { /* 网络抖动不打断患者页面，下一轮重试 */ }
  },

  onShow () {
    if (this.data.checkedIn && this.data.checkinKind === 'STATION') this.startQueuePolling()
  },

  onHide () {
    this.stopQueuePolling()
    this.clearScannedPayload()
  },

  onUnload () {
    this.stopQueuePolling()
    this.clearScannedPayload()
    this.settleAction('station-checkin')
    this.settleAction('arrival-checkin')
  },

  // 通用签到 v1（老通用码 LEGACY_GENERIC，原 v1 通道零改动）：/me 拿 patientId 后调 POST /api/v1/checkins?patientId=
  async submitGenericCheckin () {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      throw new Error('登录状态已失效，请重新登录')
    }
    this.setData({ submitting: true, statusText: '正在提交签到…' })
    try {
      const meResponse = await api.cdmsRequest('/api/v1/miniapp/auth/me', 'GET', null, app.globalData.accessToken)
      const me = unwrapData(meResponse)
      const patientId = me && me.patientId
      if (!patientId) throw new Error('未取得患者身份，无法签到')
      const response = await api.cdmsRequest('/api/v1/checkins?patientId=' + encodeURIComponent(String(patientId)), 'POST', {}, app.globalData.accessToken)
      const result = unwrapData(response)
      const today = new Date()
      const checkinDateText = today.getFullYear() + '-' + String(today.getMonth() + 1).padStart(2, '0') + '-' + String(today.getDate()).padStart(2, '0')
      this.setData({
        checkedIn: true,
        checkinKind: 'ARRIVAL',
        // §5.1 两级签到：老通用码为机构到场签到（ORG_CHECKIN），文案与设备排队签到区分
        statusText: result && result.status ? '到场签到状态：' + result.status : '到场签到成功',
        checkinDateText,
        errorText: ''
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  scanAgain () {
    this.stopQueuePolling()
    this.clearScannedPayload()
    // 注意：不清 pending 的签到动作 key —— 网络超时/5xx 后用户「重新扫码」同一码属同一动作，
    // 必须沿用同一 key（§14）；扫到不同码时由 actionKeyFor 的内容签名差异自动消费旧 key。
    this.setData({
      checkedIn: false,
      checkinKind: '',
      queueNo: '',
      waitingAheadText: '',
      queueMessage: '',
      stationStatus: '',
      stationId: '',
      errorText: '',
      statusText: '请扫描医生工作站二维码',
      checkinDateText: ''
    })
  },

  goBack () { wx.navigateBack({ delta: 1 }) }
})
