Page({
  data: { src: '', isDoctor: false },
  hasShown: false,
  onLoad (query) {
    this.syncRole()
    if (!query?.url) { wx.showToast({ title: '缺少 H5 地址', icon: 'none' }); return }
    try {
      this.setData({ src: decodeURIComponent(query.url) })
    } catch (_) {
      wx.showToast({ title: 'H5 地址无效', icon: 'none' })
    }
  },
  onShow () {
    this.syncRole()
    if (!this.data.src) return
    if (!this.hasShown) { this.hasShown = true; return }
    const source = this.data.src
    const hashIndex = source.indexOf('#')
    const base = hashIndex >= 0 ? source.slice(0, hashIndex) : source
    const hash = hashIndex >= 0 ? source.slice(hashIndex) : ''
    const separator = base.includes('?') ? '&' : '?'
    this.setData({ src: `${base}${separator}scaleRefreshAt=${Date.now()}${hash}` })
  },
  syncRole () {
    try {
      const app = typeof getApp === 'function' ? getApp() : null
      this.setData({ isDoctor: app?.globalData?.activeRole === 'DOCTOR' })
    } catch (_) { this.setData({ isDoctor: false }) }
  },
  // 医生业务工作台在 H5（web-view 无 tabBar），设备中心是原生 TabBar 页，从这里浮层进入。
  goDeviceCenter () {
    wx.switchTab({ url: '/pages/device/device' })
  }
})
