const messageApi = require('../../utils/message-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '-') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function formatTime (value) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}

function formatMessage (item) {
  return Object.assign({}, item, {
    id: String(item.id || ''),
    patientId: String(item.patientId || ''),
    alertId: String(item.alertId || ''),
    title: valueText(item.title, '通知'),
    content: valueText(item.content, '服务端消息'),
    read: !!item.read,
    readText: item.read ? '已读' : '未读',
    readTone: item.read ? 'neutral' : 'warning',
    timeText: formatTime(item.createTime)
  })
}

function friendlyError (error, action = 'load') {
  if (action === 'read' && error?.statusCode === 403) return '无权更新消息状态'
  if (action === 'read' && error?.statusCode === 401) return '登录状态已失效，请重新登录'
  if (error?.statusCode === 401) return '登录状态已失效，请重新登录'
  return '消息加载失败'
}

function normalizeList (result) {
  if (Array.isArray(result?.list)) return result.list
  if (Array.isArray(result?.records)) return result.records
  if (Array.isArray(result?.items)) return result.items
  return []
}

Page({
  data: {
    loading: false,
    error: '',
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    unreadCount: 0,
    messages: [],
    empty: false
  },

  async onLoad () {
    try {
      await ensureSession({ role: getApp()?.globalData?.activeRole || 'PATIENT' })
      await this.loadMessages(true)
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error) })
    }
  },

  async loadMessages (reset = false) {
    const page = reset ? 1 : this.data.page
    const pageSize = this.data.pageSize
    this.setData({ loading: true, error: '', empty: false })
    try {
      const [messagesResult, unreadResult] = await Promise.all([
        messageApi.listMessages({ page, pageSize }),
        messageApi.getUnreadCount()
      ])
      const list = normalizeList(messagesResult)
      const messages = list.map(formatMessage)
      const total = Number(messagesResult?.total || messages.length || 0)
      const unreadCount = Number(unreadResult?.count ?? unreadResult ?? 0)
      this.setData({
        loading: false,
        page,
        total,
        unreadCount,
        messages: reset ? messages : this.data.messages.concat(messages),
        hasMore: page * pageSize < total,
        empty: messages.length === 0 && page === 1
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: friendlyError(error),
        empty: false
      })
    }
  },

  async onReachBottom () {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ page: this.data.page + 1 })
    await this.loadMessages(false)
  },

  async onMessageTap (event) {
    const id = String(event.currentTarget.dataset.id || '')
    if (!id) return
    this.setData({ error: '', readingId: id })
    try {
      await messageApi.markMessageRead(id)
      await this.loadMessages(true)
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error, 'read') })
    } finally {
      this.setData({ readingId: '' })
    }
  },

  async markAllRead () {
    this.setData({ error: '', markingAll: true })
    try {
      await messageApi.markAllMessagesRead()
      await this.loadMessages(true)
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error, 'read') })
    } finally {
      this.setData({ markingAll: false })
    }
  },

  retry () {
    return this.loadMessages(true)
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
