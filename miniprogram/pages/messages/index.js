const api = require('../../utils/api')

function unwrapData (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

function pad (value) { return String(value).padStart(2, '0') }

function formatMessageTime (value) {
  if (!value) return ''
  const numeric = typeof value === 'number' || /^\d{10,13}$/.test(String(value))
  const date = numeric ? new Date(Number(value)) : new Date(String(value).replace(/-/g, '/'))
  if (isNaN(date.getTime())) return String(value)
  return date.getFullYear() + '-' + pad(date.getMonth() + 1) + '-' + pad(date.getDate()) + ' ' + pad(date.getHours()) + ':' + pad(date.getMinutes())
}

function messageTypeLabel (type) {
  const text = String(type || '').toUpperCase()
  if (text.indexOf('FOLLOWUP') >= 0 || text.indexOf('VISIT') >= 0 || text.indexOf('随访') >= 0) return '随访提醒'
  if (text.indexOf('ALERT') >= 0 || text.indexOf('WARN') >= 0 || text.indexOf('预警') >= 0) return '健康预警'
  if (text.indexOf('SYSTEM') >= 0 || text.indexOf('系统') >= 0) return '系统通知'
  return '微信消息'
}

Page({
  data: {
    loading: false,
    messages: [],
    total: 0,
    reminderText: '',
    hasReminder: false
  },
  loadedOnce: false,

  onLoad () {
    this.loadMessages()
    this.loadFollowupReminder()
  },

  onShow () {
    if (this.loadedOnce) this.loadMessages()
  },

  async loadMessages () {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) return
    this.loadedOnce = true
    this.setData({ loading: true })
    try {
      const response = await api.cdmsRequest('/api/v1/messages?page=1&pageSize=20', 'GET', null, app.globalData.accessToken)
      const data = unwrapData(response)
      const list = Array.isArray(data && data.list) ? data.list : []
      this.setData({
        messages: list.map((item) => Object.assign({}, item, {
          read: !!item.read,
          typeLabel: messageTypeLabel(item.messageType),
          timeText: formatMessageTime(item.createTime)
        })),
        total: data && data.total
      })
    } catch (error) {
      wx.showToast({ title: error.message || '消息加载失败', icon: 'none' })
    } finally {
      this.setData({ loading: false })
    }
  },

  // 随访提醒摘要：取患者 360 的 followupSummary.nextVisitDate，距下次随访 ≤ 7 天时显示提醒条
  async loadFollowupReminder () {
    const app = getApp()
    if (!app.globalData.cdmsBaseUrl || !app.globalData.accessToken) return
    let nextVisitDate = ''
    try {
      const meResponse = await api.cdmsRequest('/api/v1/miniapp/auth/me', 'GET', null, app.globalData.accessToken)
      const me = unwrapData(meResponse)
      const patientId = me && me.patientId
      if (!patientId) return
      const response = await api.cdmsRequest('/api/v1/patients/' + encodeURIComponent(String(patientId)) + '/360', 'GET', null, app.globalData.accessToken)
      const data = unwrapData(response)
      const followupSummary = data && data.detail && data.detail.followupSummary
      nextVisitDate = followupSummary && followupSummary.nextVisitDate
    } catch (error) {
      console.warn('[CDMS] 获取随访计划失败', error)
      return
    }
    if (!nextVisitDate) return
    const parsed = new Date(String(nextVisitDate).replace(/-/g, '/'))
    if (isNaN(parsed.getTime())) return
    const now = new Date()
    now.setHours(0, 0, 0, 0)
    const target = new Date(parsed.getFullYear(), parsed.getMonth(), parsed.getDate())
    const diffDays = Math.round((target.getTime() - now.getTime()) / 86400000)
    if (diffDays >= 0 && diffDays <= 7) {
      this.setData({
        hasReminder: true,
        reminderText: '您下周有一次随访安排（' + pad(parsed.getMonth() + 1) + '-' + pad(parsed.getDate()) + '）'
      })
    }
  },

  async markRead (event) {
    const id = event.currentTarget.dataset.id
    this.setData({
      messages: this.data.messages.map((item) => String(item.id) === String(id)
        ? Object.assign({}, item, { read: true })
        : item)
    })
    const app = getApp()
    try {
      await api.cdmsRequest('/api/v1/messages/' + encodeURIComponent(String(id)) + '/read', 'POST', null, app.globalData.accessToken)
    } catch (error) {
      console.warn('[CDMS] 标记已读失败', error)
    }
  },

  async readAll () {
    const app = getApp()
    const remaining = this.data.messages.filter((item) => !item.read)
    if (!remaining.length) {
      wx.showToast({ title: '没有未读消息', icon: 'none' })
      return
    }
    try {
      await api.cdmsRequest('/api/v1/messages/read-all', 'POST', null, app.globalData.accessToken)
      this.setData({ messages: this.data.messages.map((item) => Object.assign({}, item, { read: true })) })
      wx.showToast({ title: '已全部标记为已读', icon: 'success' })
    } catch (error) {
      wx.showToast({ title: error.message || '操作失败', icon: 'none' })
    }
  }
})
