const stationApi = require('../../utils/station-api')
const api = require('../../utils/api')
const { ensureSession } = require('../../utils/auth-guard')
const { parseCheckinPayload } = require('../../utils/scale-qr')

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

  // 场次签到：进入医生工作站测量队列（原流程保持不变）
  async submitCheckin (payload) {
    this.setData({ submitting: true, stationId: payload.stationId, statusText: '正在加入测量队列…' })
    try {
      const station = await stationApi.createCheckin(payload.stationId, payload.checkinToken)
      const current = station.currentQueueItem || (station.queue || []).find(item => item.status === 'WAITING')
      this.setData({
        checkedIn: true,
        checkinKind: 'STATION',
        queueNo: current?.queueNo ? String(current.queueNo) : '',
        statusText: '签到成功，请留意医生叫号',
        errorText: ''
      })
    } finally {
      this.setData({ submitting: false })
    }
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
        statusText: result && result.status ? '签到状态：' + result.status : '签到成功',
        checkinDateText,
        errorText: ''
      })
    } finally {
      this.setData({ submitting: false })
    }
  },

  scanAgain () {
    this.setData({
      checkedIn: false,
      checkinKind: '',
      queueNo: '',
      stationId: '',
      errorText: '',
      statusText: '请扫描医生工作站二维码',
      checkinDateText: ''
    })
  },
  goBack () { wx.navigateBack({ delta: 1 }) }
})
