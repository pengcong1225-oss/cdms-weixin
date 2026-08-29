const api = require('../../../utils/api')
const bleManager = require('../../../services/bleManager')
const { ensureSession } = require('../../../utils/auth-guard')

Page({
  data: {
    stats: [
      { key: 'patients', title: '患者', value: '--', caption: '服务端患者列表', tone: 'success' },
      { key: 'followups', title: '随访', value: '--', caption: '后续原生页面接入', tone: 'neutral' }
    ],
    entries: [
      { key: 'patients', title: '患者管理', subtitle: '查看患者列表、新增档案和患者360', icon: '患', disabled: false },
      { key: 'station', title: '体脂秤工作站', subtitle: '创建场次、扫码签到和轮测确认', icon: '秤', disabled: false },
      { key: 'followups', title: '随访工作', subtitle: '继续使用服务端权限，后续迁移原生表单', icon: '访', disabled: true },
      { key: 'devices', title: '设备工作站', subtitle: '体脂秤、MFA-1 和 Sunvou 后续开放', icon: '设', disabled: true }
    ]
  },

  async onLoad () {
    await this.ensureDoctor()
  },

  async onShow () {
    await this.ensureDoctor()
  },

  async ensureDoctor () {
    try {
      await ensureSession({ role: 'DOCTOR' })
    } catch (_) {}
  },

  onEntrySelect (event) {
    const entry = this.data.entries[event.currentTarget.dataset.index]
    if (entry?.key === 'patients' && !entry.disabled) {
      wx.navigateTo({ url: '/pages/patient-list/index' })
      return
    }
    if (entry?.key === 'station' && !entry.disabled) {
      wx.navigateTo({ url: '/pages/device-scale/station/index' })
      return
    }
    wx.showToast({ title: '功能准备中', icon: 'none' })
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
