const stationApi = require('../../utils/station-api')
const { ensureSession } = require('../../utils/auth-guard')
const { parseCheckinPayload } = require('../../utils/scale-qr')

Page({
  data: { scanning: false, submitting: false, checkedIn: false, queueNo: '', stationId: '', errorText: '', statusText: '请扫描医生工作站二维码' },

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
      if (!payload) throw new Error('请扫描 CDMS 体脂秤工作站二维码')
      await this.submitCheckin(payload)
    } catch (error) {
      this.setData({ errorText: error.message || '扫码签到失败', statusText: '请重新扫描医生工作站二维码' })
    } finally {
      this.setData({ scanning: false })
    }
  },

  async submitCheckin (payload) {
    this.setData({ submitting: true, stationId: payload.stationId, statusText: '正在加入测量队列…' })
    try {
      const station = await stationApi.createCheckin(payload.stationId, payload.checkinToken)
      const current = station.currentQueueItem || (station.queue || []).find(item => item.status === 'WAITING')
      this.setData({ checkedIn: true, queueNo: current?.queueNo ? String(current.queueNo) : '', statusText: '签到成功，请留意医生叫号', errorText: '' })
    } finally {
      this.setData({ submitting: false })
    }
  },

  scanAgain () { this.setData({ checkedIn: false, queueNo: '', stationId: '', errorText: '', statusText: '请扫描医生工作站二维码' }) },
  goBack () { wx.navigateBack({ delta: 1 }) }
})
