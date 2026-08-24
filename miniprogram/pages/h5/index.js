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
})
