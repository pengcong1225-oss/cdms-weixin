const api = require('../../utils/api')
const { ensureSession } = require('../../utils/auth-guard')
const { buildQrMatrix, createGenericCheckinPayload, drawQr } = require('../../utils/scale-qr')

function unwrapData (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

function statusLabel (status) {
  const value = String(status || '').toUpperCase()
  if (value === 'WAITING') return '待处理'
  if (value === 'IN_PROGRESS') return '进行中'
  if (value === 'COMPLETED') return '已完成'
  return String(status || '')
}

Page({
  data: {
    loading: true,
    refreshing: false,
    errorText: '',
    orgId: '',
    qrPayload: '',
    queue: [],
    // 是否已尝试拉取过今日签到队列（区分“加载中”与“暂无记录”）
    queueFetched: false
  },

  async onLoad () {
    this.setData({ loading: true, errorText: '' })
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (session.activeRole !== 'DOCTOR') {
        this.setData({ loading: false, errorText: '请先使用医生账号登录' })
        return
      }
      await this.refresh()
      this.loadTodayQueue()
    } catch (error) {
      this.setData({ errorText: error.message || '签到码加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  onShow () {
    // 已取得机构信息后，每次回到页面刷新今日签到队列
    if (this.data.orgId) this.loadTodayQueue()
  },

  onReady () {
    this.qrReady = true
    this.drawCheckinQr()
  },

  async loadMe () {
    const app = typeof getApp === 'function' ? getApp() : null
    if (!app || !app.globalData.cdmsBaseUrl || !app.globalData.accessToken) {
      throw new Error('登录状态已失效，请重新登录')
    }
    const response = await api.cdmsRequest('/api/v1/miniapp/auth/me', 'GET', null, app.globalData.accessToken)
    return unwrapData(response) || {}
  },

  async refresh () {
    this.setData({ refreshing: true, errorText: '' })
    try {
      const me = await this.loadMe()
      const orgId = String(me && me.orgId ? me.orgId : '').trim()
      if (!orgId) throw new Error('未取得机构信息')
      const qrPayload = createGenericCheckinPayload(orgId)
      this.setData({ orgId, qrPayload }, () => this.drawCheckinQr())
    } catch (error) {
      this.setData({ errorText: error.message || '签到码加载失败' })
    } finally {
      this.setData({ refreshing: false })
    }
  },

  drawCheckinQr () {
    if (!this.qrReady || !this.data.qrPayload || typeof wx.createCanvasContext !== 'function') return
    try {
      const matrix = buildQrMatrix(this.data.qrPayload)
      drawQr(wx.createCanvasContext('checkinQr', this), matrix, { size: 240, quiet: 4 })
    } catch (error) {
      this.setData({ errorText: error.message || '二维码生成失败' })
    }
  },

  copyPayload () {
    if (!this.data.qrPayload) return
    wx.setClipboardData({
      data: this.data.qrPayload,
      success: () => wx.showToast({ title: '签到码文本已复制', icon: 'success' })
    })
  },

  async loadTodayQueue () {
    const app = typeof getApp === 'function' ? getApp() : null
    if (!app || !app.globalData.cdmsBaseUrl || !app.globalData.accessToken) return
    try {
      const response = await api.cdmsRequest('/api/v1/checkins/today', 'GET', null, app.globalData.accessToken)
      const data = unwrapData(response)
      const list = Array.isArray(data)
        ? data
        : Array.isArray(data && data.items)
          ? data.items
          : []
      this.setData({
        queueFetched: true,
        queue: list.map((item, index) => ({
          key: String(item && item.patientId ? item.patientId : 'row-' + index),
          patientName: String(item && (item.patientName || item.maskedName) ? (item.patientName || item.maskedName) : '未知患者'),
          status: String(item && item.status || ''),
          statusText: statusLabel(item && item.status),
          checkinDate: item && item.checkinDate ? String(item.checkinDate) : '',
          createTime: item && item.createTime ? String(item.createTime) : ''
        }))
      })
    } catch (error) {
      // 队列为医生端附加信息：拉取失败静默展示为空，不打断展码主功能
      this.setData({ queueFetched: true, queue: [] })
    }
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
