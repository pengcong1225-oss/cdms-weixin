Page({
  data: { src: '' },
  hasShown: false,
  onLoad (query) {
    if (!query?.url) { wx.showToast({ title: '缺少 H5 地址', icon: 'none' }); return }
    try {
      this.setData({ src: decodeURIComponent(query.url) })
    } catch (_) {
      wx.showToast({ title: 'H5 地址无效', icon: 'none' })
    }
  },
  onShow () {
    if (!this.data.src) return
    if (!this.hasShown) { this.hasShown = true; return }
    const source = this.data.src
    const hashIndex = source.indexOf('#')
    const base = hashIndex >= 0 ? source.slice(0, hashIndex) : source
    const hash = hashIndex >= 0 ? source.slice(hashIndex) : ''
    const separator = base.includes('?') ? '&' : '?'
    this.setData({ src: `${base}${separator}scaleRefreshAt=${Date.now()}${hash}` })
  }
})
