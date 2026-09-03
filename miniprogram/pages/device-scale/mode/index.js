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
    wx.navigateTo({ url: '/pages/device-scale/station/index' })
  },

  openDirect () {
    if (this.data.errorText) return
    wx.navigateTo({ url: '/pages/device-scale/index' })
  },

  goBack () { wx.navigateBack({ delta: 1 }) }
})
