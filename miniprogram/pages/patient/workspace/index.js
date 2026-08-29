const api = require('../../../utils/api')
const messageApi = require('../../../utils/message-api')
const statsApi = require('../../../utils/stats-api')
const bleManager = require('../../../services/bleManager')
const { ensureSession } = require('../../../utils/auth-guard')
const { PUBLIC_SCREENING_URL } = require('../../../utils/workspace-entry')

Page({
  data: {
    publicScreeningUrl: PUBLIC_SCREENING_URL,
    hasPatientRef: false,
    showWorkspaceContent: false,
    stats: [
      { key: 'followups', title: '随访总数', value: '--', caption: '本人累计随访', tone: 'success' },
      { key: 'messages', title: '未读消息', value: '--', caption: '来自服务端的消息', tone: 'warning' },
      { key: 'month', title: '本月随访', value: '--', caption: '最近 30 天/本月', tone: 'neutral' }
    ],
    entries: [
      { key: 'followups', title: '随访记录', subtitle: '查看本人随访历史和草稿', icon: '访', disabled: false },
      { key: 'messages', title: '消息中心', subtitle: '查看服务端消息并标记已读', icon: '信', disabled: false },
      { key: 'reports', title: '健康报告', subtitle: '标准和 AI 报告后续开放', icon: '报', disabled: true },
      { key: 'device', title: '指环设备', subtitle: '连接设备并同步健康数据', icon: '戒', disabled: false }
    ]
  },

  async onLoad () {
    await this.ensurePatient()
  },

  async onShow () {
    await this.ensurePatient()
  },

  async ensurePatient () {
    try {
      const session = await ensureSession({ role: 'PATIENT' })
      const hasPatientRef = !!String(session.patientRef || '').trim()
      this.setData({
        hasPatientRef,
        showWorkspaceContent: hasPatientRef
      })
      if (hasPatientRef) {
        await this.loadWorkspaceSummary()
      }
    } catch (_) {}
  },

  async loadWorkspaceSummary () {
    try {
      const [stats, unread] = await Promise.all([
        statsApi.getMyStats(),
        messageApi.getUnreadCount()
      ])
      this.setData({
        stats: [
          {
            key: 'followups',
            title: '随访总数',
            value: String(stats?.totalFollowups ?? '--'),
            caption: '本人累计随访',
            tone: 'success'
          },
          {
            key: 'messages',
            title: '未读消息',
            value: String(unread?.count ?? unread ?? '--'),
            caption: '来自服务端的消息',
            tone: 'warning'
          },
          {
            key: 'month',
            title: '本月随访',
            value: String(stats?.thisMonth ?? '--'),
            caption: '最近 30 天/本月',
            tone: 'neutral'
          }
        ]
      })
    } catch (error) {
      console.warn('[CDMS] patient workspace summary load failed', error)
    }
  },

  onEntrySelect (event) {
    const entry = this.data.entries[event.currentTarget.dataset.index]
    if (!this.data.showWorkspaceContent || !entry || entry.disabled) {
      wx.showToast({ title: '功能准备中', icon: 'none' })
      return
    }
    if (entry.key === 'followups') wx.navigateTo({ url: '/pages/followups/index' })
    if (entry.key === 'messages') wx.navigateTo({ url: '/pages/messages/index' })
    if (entry.key === 'device') wx.switchTab({ url: '/pages/device/device' })
  },

  copyQuestionnaire () {
    wx.setClipboardData({
      data: PUBLIC_SCREENING_URL,
      success: () => wx.showToast({ title: '问卷地址已复制', icon: 'success' })
    })
  },

  backHome () {
    wx.switchTab({ url: '/pages/home/home' })
  },

  logout () {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录，当前设备连接会断开。',
      confirmText: '退出',
      confirmColor: '#0c9b6c',
      success: async result => {
        if (!result.confirm) return
        try {
          await api.logout()
        } catch (error) {
          console.warn('[CDMS] logout request failed', error)
        }
        try {
          await bleManager.unbind()
        } catch (error) {
          console.warn('[CDMS BLE] disconnect on logout failed', error)
        }
        getApp().clearAuth()
        wx.reLaunch({ url: '/pages/auth/login' })
      }
    })
  }
})
