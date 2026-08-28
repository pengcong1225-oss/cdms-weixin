const api = require('../../../utils/api')
const bleManager = require('../../../services/bleManager')
const { ensureSession } = require('../../../utils/auth-guard')
const { PUBLIC_SCREENING_URL } = require('../../../utils/workspace-entry')

Page({
  data: {
    publicScreeningUrl: PUBLIC_SCREENING_URL,
    hasPatientRef: false,
    stats: [
      { key: 'followups', title: '随访', value: '--', caption: '本人随访记录', tone: 'success' },
      { key: 'reports', title: '报告', value: '--', caption: '标准与 AI 报告', tone: 'neutral' }
    ],
    entries: [
      { key: 'followups', title: '随访记录', subtitle: '后续任务接入原生随访列表', icon: '访', disabled: true },
      { key: 'reports', title: '健康报告', subtitle: '后续任务接入原生报告查看', icon: '报', disabled: true },
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
      this.setData({ hasPatientRef: !!String(session.patientRef || '').trim() })
    } catch (_) {}
  },

  onEntrySelect (event) {
    const entry = this.data.entries[event.currentTarget.dataset.index]
    if (!entry || entry.disabled) {
      wx.showToast({ title: '功能准备中', icon: 'none' })
      return
    }
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
