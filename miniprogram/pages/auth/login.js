const api = require('../../utils/api')
const { getRoleEntry } = require('../../utils/role-entry')

Page({
  data: { mode: 'doctor', username: '', password: '', phone: '', loading: false, roleSelectionRequired: false, roles: [] },
  onLoad (query) {
    const app = getApp()
    if (query?.cdmsBaseUrl) app.globalData.cdmsBaseUrl = query.cdmsBaseUrl
  },
  selectMode (event) { this.setData({ mode: event.currentTarget.dataset.mode, roleSelectionRequired: false, roles: [] }) },
  onUsername (e) { this.setData({ username: e.detail.value }) },
  onPassword (e) { this.setData({ password: e.detail.value }) },
  onPhone (e) { this.setData({ phone: e.detail.value }) },
  async login () {
    if (this.data.mode === 'doctor' && (!this.data.username.trim() || !this.data.password)) {
      wx.showToast({ title: '请输入医生账号和密码', icon: 'none' }); return
    }
    if (this.data.mode === 'patient' && !/^1\d{10}$/.test(this.data.phone)) {
      wx.showToast({ title: '请输入已建档的 11 位手机号', icon: 'none' }); return
    }
    this.setData({ loading: true })
    try {
      const response = this.data.mode === 'doctor'
        ? await api.loginDoctor({ username: this.data.username, password: this.data.password })
        : await api.loginWithWechat({ phone: this.data.phone })
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
