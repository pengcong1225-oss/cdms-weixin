Page({
  data: { src: '' },
  onLoad (query) {
    if (!query?.url) { wx.showToast({ title: '缺少 H5 地址', icon: 'none' }); return }
    try {
      this.setData({ src: decodeURIComponent(query.url) })
    } catch (_) {
      wx.showToast({ title: 'H5 地址无效', icon: 'none' })
    }
  }
  // 注意：不再在 onShow 改写 web-view src。web-view 的 src 一旦变化会整页重载，
  // 导致 H5 内存 token 丢失、返回时跳登录。保持 src 不变，返回只恢复已有页面状态。
})