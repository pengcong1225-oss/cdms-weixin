const paragraphs = require('./content')
const { PRIVACY_VERSION, isPrivacyAgreed, rememberPrivacyAgreed, forgetPrivacyAgreed } = require('../../utils/privacy')

const LOGIN_URL = '/pages/auth/login'

Page({
  data: { paragraphs, version: PRIVACY_VERSION, agreed: false },

  onLoad () {
    this.setData({ agreed: isPrivacyAgreed() })
  },

  // 「我已阅读并同意」：写同意记录 → 返回登录页（登录页 onShow 重读 storage → 自动勾选）。
  agree () {
    rememberPrivacyAgreed()
    this.setData({ agreed: true })
    wx.showToast({ title: '已同意隐私政策', icon: 'none' })
    this.goBack()
  },

  // 已同意过时可撤回：清记录，登录页返回后不再自动勾选，登录前需重新同意。
  withdraw () {
    forgetPrivacyAgreed()
    this.setData({ agreed: false })
    wx.showToast({ title: '已撤回同意', icon: 'none' })
  },

  goBack () {
    const fallback = () => {
      try { wx.reLaunch({ url: LOGIN_URL }) } catch (_) { /* best-effort */ }
    }
    try {
      wx.navigateBack({ delta: 1, fail: fallback })
    } catch (_) {
      fallback()
    }
  }
})
