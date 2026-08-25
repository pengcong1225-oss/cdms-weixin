const api = require('../../utils/api')
const { getRoleEntry } = require('../../utils/role-entry')

Page({
  data: { phone: '', loading: false, roleSelectionRequired: false, roles: [] },
  onLoad (query) {
    const app = getApp()
    if (query?.cdmsBaseUrl) app.globalData.cdmsBaseUrl = query.cdmsBaseUrl
  },
  onPhone (e) { this.setData({ phone: e.detail.value }) },
  async login () {
    if (!/^1\d{10}$/.test(this.data.phone)) {
      wx.showToast({ title: '请输入已建档的 11 位手机号', icon: 'none' }); return
    }
    this.setData({ loading: true })
    try {
      const response = await api.loginWithWechat({ phone: this.data.phone })
      const session = response?.data || response
      const app = getApp()
      app.saveAuth(session)
      if (session.roleSelectionRequired) {
        this.setData({ roleSelectionRequired: true, roles: session.roles || [] })
      } else {
        await this.enterRole(session)
      }
    } catch (error) {
      wx.showToast({ title: error.message || '登录失败', icon: 'none' })
    } finally { this.setData({ loading: false }) }
  },
  async selectRole (event) {
    const roleType = event.currentTarget.dataset.role
    try {
      const response = await api.switchRole(roleType)
      const session = response?.data || response
      getApp().saveAuth(session)
      await this.enterRole(session)
    } catch (error) { wx.showToast({ title: error.message || '角色切换失败', icon: 'none' }) }
  },
  async enterRole (session) {
    const entry = getRoleEntry(session?.activeRole)
    if (entry.type === 'H5') {
      const response = await api.createHandoff(entry.targetPath)
      const handoff = response?.data || response
      if (!handoff?.handoffUrl) throw new Error('未取得医生工作台地址')
      wx.redirectTo({ url: `/pages/h5/index?url=${encodeURIComponent(handoff.handoffUrl)}` })
      return
    }
    if (entry.type === 'HOME') {
      wx.reLaunch({ url: '/pages/home/home' })
      return
    }
    wx.reLaunch({ url: '/pages/auth/login' })
  }
})
