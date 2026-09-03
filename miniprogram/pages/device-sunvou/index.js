const sunvouApi = require('../../utils/sunvou-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function formatDateTime (value) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}

function formatReport (item) {
  return Object.assign({}, item, {
    id: String(item.reportId || item.id || ''),
    reportId: String(item.reportId || item.id || ''),
    patientId: String(item.patientId || ''),
    fileId: valueText(item.fileId, ''),
    reportNo: valueText(item.reportNo, '标准报告'),
    categoryText: valueText(item.category, '标准报告'),
    createdAtText: formatDateTime(item.createdAt),
    statusText: item.downloadAvailable ? '可下载' : '已归档'
  })
}

function isImageFile (name) {
  return /\.(png|jpe?g|gif|webp)$/i.test(String(name || ''))
}

function downloadFile (url) {
  return new Promise((resolve, reject) => {
    wx.downloadFile({
      url,
      success: resolve,
      fail: reject
    })
  })
}

function openDocument (filePath) {
  return new Promise((resolve, reject) => {
    wx.openDocument({
      filePath,
      showMenu: true,
      success: resolve,
      fail: reject
    })
  })
}

function previewImage (url) {
  return new Promise((resolve, reject) => {
    wx.previewImage({
      urls: [url],
      current: url,
      success: resolve,
      fail: reject
    })
  })
}

async function openTransientUrl (url, fileName) {
  if (!url) throw new Error('缺少访问地址')
  if (isImageFile(fileName)) {
    await previewImage(url)
    return
  }
  const result = await downloadFile(url)
  const filePath = result?.tempFilePath || result?.filePath || ''
  if (!filePath) throw new Error('文件下载失败')
  await openDocument(filePath)
}

Page({
  data: {
    activeRole: 'DOCTOR',
    patientId: '',
    loading: false,
    loadingMore: false,
    opening: false,
    errorText: '',
    page: 1,
    pageSize: 20,
    hasMore: false,
    reports: [],
    selectedReport: null,
    accessStateText: '未请求',
    accessExpiresAtText: '-'
  },

  async onLoad (query = {}) {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (session.activeRole !== 'DOCTOR') {
        this.setData({ errorText: '请先使用医生账号登录' })
        return
      }
      this.setData({
        activeRole: session.activeRole || 'DOCTOR',
        patientId: valueText(query.patientId || query.patientRef || session.patientRef || session.patientId || '')
      })
      if (this.data.patientId) {
        await this.loadReports(true)
      }
    } catch (error) {
      this.setData({ errorText: error.message || '医生会话校验失败' })
    }
  },

  clearTransientAccess () {
    this.currentAccessUrl = ''
    this.currentFileUrl = ''
    this.currentAccessExpiresAt = ''
    this.setData({
      accessStateText: '未请求',
      accessExpiresAtText: '-'
    })
  },

  applyReports (response, reset = false) {
    const list = Array.isArray(response?.items)
      ? response.items
      : Array.isArray(response?.list)
        ? response.list
        : Array.isArray(response?.records)
          ? response.records
          : []
    const reports = list.map(formatReport)
    const selectedId = this.data.selectedReport?.reportId || ''
    const selectedReport = reports.find(item => item.reportId === selectedId) || reports[0] || null
    this.setData({
      reports: reset ? reports : this.data.reports.concat(reports),
      selectedReport,
      page: Number(response?.page || this.data.page),
      pageSize: Number(response?.pageSize || this.data.pageSize),
      hasMore: !!response?.hasMore || !!response?.nextCursor,
      errorText: '',
      loading: false,
      loadingMore: false
    })
  },

  async loadReports (reset = false) {
    const patientId = valueText(this.data.patientId).trim()
    if (!patientId) {
      this.setData({ errorText: '请选择患者后再查看报告' })
      return
    }
    this.clearTransientAccess()
    this.setData({ loading: true, errorText: '' })
    try {
      const response = await sunvouApi.listReports({
        patientId,
        page: reset ? 1 : this.data.page,
        pageSize: this.data.pageSize
      })
      this.applyReports(response, reset)
    } catch (error) {
      this.setData({
        loading: false,
        loadingMore: false,
        errorText: error.message || '报告加载失败'
      })
    }
  },

  async loadMore () {
    if (!this.data.hasMore || this.data.loading || this.data.loadingMore) return
    this.setData({ loadingMore: true })
    try {
      const response = await sunvouApi.listReports({
        patientId: this.data.patientId,
        page: this.data.page + 1,
        pageSize: this.data.pageSize
      })
      this.applyReports(response, false)
    } catch (error) {
      this.setData({
        loadingMore: false,
        errorText: error.message || '报告加载失败'
      })
    }
  },

  selectReport (event) {
    const reportId = String(event.currentTarget.dataset.reportId || '')
    if (!reportId) return
    const selectedReport = this.data.reports.find(item => item.reportId === reportId) || null
    this.setData({ selectedReport })
    this.clearTransientAccess()
  },

  async openReport () {
    if (!this.data.selectedReport) return
    this.setData({ opening: true, errorText: '' })
    try {
      const result = await sunvouApi.getReportAccessUrl(this.data.selectedReport.reportId, {
        patientId: this.data.patientId,
        expirySeconds: 300
      })
      this.currentAccessUrl = result?.url || ''
      this.currentAccessExpiresAt = result?.expiresInSeconds ? `${result.expiresInSeconds} 秒` : ''
      this.currentFileUrl = ''
      this.setData({
        accessStateText: this.currentAccessUrl ? '已签发' : '未签发',
        accessExpiresAtText: this.currentAccessExpiresAt || '-'
      })
      await openTransientUrl(this.currentAccessUrl, this.data.selectedReport.fileObjectKey || this.data.selectedReport.reportNo)
    } catch (error) {
      this.setData({ errorText: error.message || '报告打开失败' })
    } finally {
      this.setData({ opening: false })
    }
  },

  async openAttachment () {
    if (!this.data.selectedReport) return
    const fileId = String(this.data.selectedReport.fileId || '').trim()
    if (!fileId) {
      wx.showToast({ title: '暂无附件', icon: 'none' })
      return
    }
    this.setData({ opening: true, errorText: '' })
    try {
      const result = await sunvouApi.getFileAccessUrl(fileId, {
        patientId: this.data.patientId,
        expirySeconds: 300
      })
      this.currentFileUrl = result?.url || ''
      this.currentAccessUrl = ''
      this.currentAccessExpiresAt = result?.expiresInSeconds ? `${result.expiresInSeconds} 秒` : ''
      this.setData({
        accessStateText: this.currentFileUrl ? '已签发' : '未签发',
        accessExpiresAtText: this.currentAccessExpiresAt || '-'
      })
      await openTransientUrl(this.currentFileUrl, this.data.selectedReport.fileObjectKey || fileId)
    } catch (error) {
      this.setData({ errorText: error.message || '附件打开失败' })
    } finally {
      this.setData({ opening: false })
    }
  },

  updatePatientId (event) {
    this.setData({ patientId: String(event.detail.value || '') })
  },

  async retry () {
    this.clearTransientAccess()
    return this.loadReports(true)
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})

module.exports = { formatReport, openTransientUrl }
