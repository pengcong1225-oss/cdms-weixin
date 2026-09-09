const { ensureSession } = require('../../../utils/auth-guard')

Page({
  data: { errorText: '' },

  async onLoad () {
    try {
      await ensureSession({ role: 'DOCTOR' })
    } catch (error) {
      this.setData({ errorText: error.message || '请先使用医生账号登录' })
    }
  },

  openStation () {
    if (this.data.errorText) return
    wx.navigateTo({ url: '/pages/device-mfa1/index' })
  },

  openDirect () {
    if (this.data.errorText) return
    wx.navigateTo({ url: '/pages/device-mfa1/direct/index' })
  },

  goBack () { wx.navigateBack({ delta: 1 }) }
})
