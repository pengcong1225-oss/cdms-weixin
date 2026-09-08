const stationApi = require('../../utils/station-api')
const api = require('../../utils/api')
const { ensureSession } = require('../../utils/auth-guard')
const { parseCheckinPayload } = require('../../utils/scale-qr')

// 患者排队轮询间隔（my-queue 专用接口）
const QUEUE_POLL_INTERVAL_MS = 10000

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

  async onLoad () {
    try {
      await ensureSession({ role: 'PATIENT' })
    } catch (error) {
      this.setData({ errorText: error.message || '请先使用患者账号登录' })
    }
  },

  async scanCode () {
    if (this.data.scanning || this.data.submitting || this.data.checkedIn) return
    this.setData({ scanning: true, errorText: '', statusText: '正在打开扫码能力…' })
    try {
      const result = await new Promise((resolve, reject) => wx.scanCode({ onlyFromCamera: true, scanType: ['qrCode'], success: resolve, fail: reject }))
      const payload = parseCheckinPayload(result?.result)
      if (!payload) throw new Error('请扫描 CDMS 签到二维码（医生工作站或机构签到码）')
      if (payload.kind === 'STATION') await this.submitCheckin(payload)
      else await this.submitGenericCheckin(payload)
    } catch (error) {
      this.setData({ errorText: error.message || '扫码签到失败', statusText: '请重新扫描签到二维码' })
    } finally {
      this.setData({ scanning: false })
    }
  },

  // 场次签到：后端对【患者】返回 MiniappScaleStationPatientQueueDTO（本人 queueNo/queueStatus/
  // waitingAhead/message），不再返回完整场次视图；这里只取患者可见字段，不读 currentQueueItem/queue。
  async submitCheckin (payload) {
    this.setData({ submitting: true, stationId: payload.stationId, statusText: '正在加入测量队列…' })
    try {
      const view = await stationApi.createCheckin(payload.stationId, payload.checkinToken)
      this.setData({
        checkedIn: true,
        checkinKind: 'STATION',
        queueNo: view.queueNo === '' ? '' : String(view.queueNo),
        waitingAheadText: waitingAheadText(view.waitingAhead),
        queueMessage: view.message || '',
        stationStatus: view.status || '',
        // §5.1 两级签到：设备场次只写队列，主状态行固定为“设备排队签到成功”，
        // 后端 message（到场确认 / 设备排队两类语义）作为补充提示单独展示。
        statusText: '设备排队签到成功，请留意医生叫号',
        errorText: ''
      })
      this.startQueuePolling()
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
  },

  onUnload () {
    this.stopQueuePolling()
  },

  // 通用签到：/me 拿 patientId 后调 POST /api/v1/checkins?patientId=
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
        checkinKind: 'GENERIC',
        // §5.1 两级签到：通用码为机构到场签到（ORG_CHECKIN），文案与设备排队签到区分
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