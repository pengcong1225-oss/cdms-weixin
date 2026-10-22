const paragraphs = require('./content')
// 2026-10-22：页面不再提供「撤回同意」，故只引用同意/查询相关函数（utils 里的撤回函数保留给其它入口）。
const { PRIVACY_VERSION, isPrivacyAgreed, rememberPrivacyAgreed } = require('../../utils/privacy')

const LOGIN_URL = '/pages/auth/login'

Page({
  data: { paragraphs, version: PRIVACY_VERSION, agreed: false, reachedBottom: false },

  onLoad () {
    this.setData({ agreed: isPrivacyAgreed() })
  },

  // 2026-10-22：必须滑到最底部才能点「我已阅读并同意」。
  // 边界：正文不足一屏时 scroll-view 永远不会触发 scrolltolower → 按钮永远点不了。
  // 这里用 createSelectorQuery 对比「内容高度」与「可视高度」，内容 ≤ 容器则直接视为已读到底。
  onReady () {
    this.ensureReachability()
  },

  ensureReachability () {
    if (typeof wx.createSelectorQuery !== 'function') return
    let query
    try { query = wx.createSelectorQuery() } catch (_) { return }
    if (!query || typeof query.select !== 'function') return
    query.select('.content').boundingClientRect()
    query.select('.content-inner').boundingClientRect()
    try {
      query.exec((rects) => {
        const viewport = rects && rects[0]
        const inner = rects && rects[1]
        if (!viewport || !inner) return
        // +1 容差：避免 padding/取整造成的误判
        if (inner.height <= viewport.height + 1) this.setData({ reachedBottom: true })
      })
    } catch (_) { /* 查询失败则回退到用户滑动触发 */ }
  },

  // 滑动到底部 → 允许点同意（幂等）
  onReachBottom () {
    if (this.data.reachedBottom) return
    this.setData({ reachedBottom: true })
  },

  // 「我已阅读并同意」：写同意记录 → 返回登录页（登录页 onShow 重读 storage → 自动勾选）。
  agree () {
    rememberPrivacyAgreed()
    this.setData({ agreed: true })
    wx.showToast({ title: '已同意隐私政策', icon: 'none' })
    this.goBack()
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
