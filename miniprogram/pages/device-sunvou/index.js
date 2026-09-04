const api = require('../../utils/api')
const sunvouApi = require('../../utils/sunvou-api')
const { ensureSession } = require('../../utils/auth-guard')

// 呼气报告 canonical 指标（iot 侧 SunvouRecordParser 产出）：FVC/FEV1 单位 L、FEV1/FVC 百分比。
const SPIRO_METRIC_LABELS = {
  FVC_L: 'FVC（用力肺活量）',
  FEV1_L: 'FEV1（第一秒用力呼气量）',
  FEV1_FVC_PCT: 'FEV1/FVC（一秒率）'
}

function metricDisplay (item) {
  const code = String(item?.name || item?.type || item?.code || '').trim()
  if (!code) return null
  // 兼容小驼峰写法（fvcL/fev1L/fev1FvcPct → FVC_L/FEV1_L/FEV1_FVC_PCT）
  const upper = code.replace(/([a-z0-9])([A-Z])/g, '$1_$2').toUpperCase()
  const label = SPIRO_METRIC_LABELS[code] || SPIRO_METRIC_LABELS[upper] || code
  const value = item?.value === null || item?.value === undefined ? '' : String(item.value)
  const unit = String(item?.unit || '')
  return { key: code, label, value, unit, text: value ? value + (unit ? ' ' + unit : '') : '-' }
}

function formatReportMetrics (report) {
  const source = Array.isArray(report?.metrics) ? report.metrics : []
  return source.map(metricDisplay).filter(Boolean)
}

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
    statusText: item.downloadAvailable ? '可下载' : '已归档',
    // 报告带 metrics 数组则渲染 FVC/FEV1/FEV1%；没有就保持原样，不编造数值
    displayMetrics: formatReportMetrics(item)
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
    keyword: '',
    patients: [],
    patientNames: [],
    patientIndex: -1,
    selectedPatient: null,
    searching: false,
    patientPage: 1,
    patientHasMore: true,
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
        patientId: valueText(query.patientId || query.patientRef || '')
      })
      // 搜索选人（与体脂秤单人直测一致）：patientId 不再手填
      await this.loadPatients(true)
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

  // ---- 患者搜索选人（复用 device-scale 单人直测模式，api.listDoctorPatients 支持 keyword）----

  async loadPatients (reset = true) {
    if (this.data.searching) return
    const nextPage = reset ? 1 : this.data.patientPage + 1
    this.setData({ searching: true, patientPage: nextPage })
    try {
      const response = await api.listDoctorPatients({ page: nextPage, pageSize: 20, keyword: this.data.keyword })
      const page = response?.data || response || {}
      const incoming = (page.list || []).filter(item => item?.id != null)
      const patients = reset ? incoming : this.data.patients.concat(incoming)
      // 去重按字符串 id（雪花 ID 一律字符串处理，不 Number 化）
      const seen = new Set()
      const deduped = patients.filter(item => { const key = String(item.id); if (seen.has(key)) return false; seen.add(key); return true })
      const hasMore = incoming.length === 20
      const initialId = this.data.patientId
      let index = initialId ? deduped.findIndex(item => String(item.id) === initialId) : -1
      if (index < 0 && deduped.length) index = reset ? 0 : -1
      const patch = { patients: deduped, patientNames: deduped.map(item => item.name || `患者${item.id}`), patientHasMore: hasMore }
      if (index >= 0) patch.patientIndex = index
      this.setData(patch, () => {
        if (index >= 0 && reset) this.selectPatient(index)
      })
    } catch (error) {
      this.setData({ errorText: error.message || '患者列表加载失败' })
    } finally {
      this.setData({ searching: false })
    }
  },

  onKeyword (event) {
    this.setData({ keyword: String(event.detail.value || '') })
  },

  searchPatients () {
    this.setData({ patientHasMore: true })
    this.loadPatients(true)
  },

  loadMorePatients () {
    if (this.data.patientHasMore && !this.data.searching) this.loadPatients(false)
  },

  selectPatient (event) {
    const index = typeof event === 'number' ? event : Number(event.detail.value)
    const patient = this.data.patients[index]
    if (!patient) return
    // patientId 保持字符串：绝不做数值转换
    this.setData({
      patientIndex: index,
      selectedPatient: patient,
      patientId: String(patient.id),
      reports: [],
      selectedReport: null
    })
    this.loadReports(true)
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
