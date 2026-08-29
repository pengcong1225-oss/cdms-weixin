const reportApi = require('../../utils/report-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '-') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function formatDateTime (value) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}

function pad (value) {
  return String(value).padStart(2, '0')
}

function currentMonth () {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
}

function formatReportItem (item) {
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

function formatAiReport (report) {
  if (!report) return null
  return Object.assign({}, report, {
    reportId: String(report.reportId || report.id || ''),
    patientId: String(report.patientId || ''),
    orgId: String(report.orgId || ''),
    reportType: report.reportType === null || report.reportType === undefined ? '' : Number(report.reportType),
    createTimeText: formatDateTime(report.createTime),
    doctorConfirmed: report.doctorConfirmed === null || report.doctorConfirmed === undefined ? 0 : Number(report.doctorConfirmed)
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

function friendlyError (error) {
  if (error?.statusCode === 403) return '无权查看报告'
  if (error?.statusCode === 404) return '报告不存在'
  return '报告加载失败，请稍后重试'
}

Page({
  data: {
    scope: 'PATIENT',
    mode: 'STANDARD',
    patientId: '',
    reportId: '',
    orgId: '',
    period: currentMonth(),
    loading: false,
    generating: false,
    saving: false,
    error: '',
    empty: false,
    reports: [],
    reportItem: null,
    aiReport: null,
    doctorRemark: '',
    confirmChecked: false
  },

  async onLoad (query = {}) {
    const session = await ensureSession({ role: getApp()?.globalData?.activeRole || 'PATIENT' })
    const scope = session.activeRole === 'DOCTOR' ? 'DOCTOR' : 'PATIENT'
    const mode = query.reportId
      ? 'STANDARD'
      : String(query.mode || '').toLowerCase() === 'org'
        ? 'ORG_AI'
        : 'PATIENT_AI'
    const patientId = String(query.patientId || (scope === 'PATIENT' ? session.patientRef || session.patientId || '' : '') || '')
    const orgId = String(query.orgId || session.orgId || '')
    const period = String(query.period || currentMonth())
    this.setData({
      scope,
      mode,
      patientId,
      reportId: String(query.reportId || ''),
      orgId,
      period,
      confirmChecked: false,
      doctorRemark: ''
    })
    if (mode === 'STANDARD' && scope === 'DOCTOR' && !patientId) {
      this.setData({ error: '请选择患者后再查看报告' })
      return
    }
    if (mode === 'ORG_AI' && !orgId) {
      this.setData({ error: '缺少机构 ID' })
      return
    }
    await this.loadCurrent(true)
  },

  async loadCurrent (reset = false) {
    if (this.data.mode === 'STANDARD') {
      return this.loadStandardReport(reset)
    }
    return this.loadAiReport(reset)
  },

  async loadStandardReport (reset = false) {
    if (!this.data.patientId) {
      this.setData({ error: '请选择患者后再查看报告' })
      return
    }
    this.setData({ loading: true, error: '', empty: false })
    try {
      const response = await reportApi.listPatientReports(this.data.patientId, { page: 1, pageSize: 50 })
      const list = Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.list)
          ? response.list
          : Array.isArray(response?.records)
            ? response.records
            : []
      const reports = list.map(formatReportItem)
      const selected = reports.find(item => item.reportId === this.data.reportId) || null
      this.setData({
        loading: false,
        reports,
        reportItem: selected,
        empty: !selected && reports.length === 0
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: friendlyError(error),
        empty: false
      })
    }
  },

  async loadAiReport (reset = false) {
    this.setData({ loading: true, error: '', empty: false })
    try {
      const report = this.data.mode === 'ORG_AI'
        ? await reportApi.getOrgAiReport(this.data.orgId, this.data.period)
        : await reportApi.getAiReport(this.data.patientId)
      this.setData({
        loading: false,
        aiReport: report ? formatAiReport(report) : null,
        empty: !report
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: 'AI 报告加载失败，请稍后重试',
        empty: false
      })
    }
  },

  async openReport () {
    if (!this.data.reportItem) return
    this.setData({ saving: true, error: '' })
    try {
      const result = await reportApi.getReportAccessUrl(this.data.patientId, this.data.reportItem.reportId, { expirySeconds: 300 })
      await openTransientUrl(result.url, this.data.reportItem.fileObjectKey || this.data.reportItem.reportNo)
    } catch (error) {
      this.setData({ error: friendlyError(error) })
    } finally {
      this.setData({ saving: false })
    }
  },

  async openAttachment () {
    if (!this.data.reportItem) return
    const fileId = String(this.data.reportItem.fileId || '').trim()
    if (!fileId) {
      wx.showToast({ title: '暂无附件', icon: 'none' })
      return
    }
    this.setData({ saving: true, error: '' })
    try {
      const result = await reportApi.getFileAccessUrl(this.data.patientId, fileId, { expirySeconds: 300 })
      await openTransientUrl(result.url, this.data.reportItem.fileObjectKey || fileId)
    } catch (error) {
      this.setData({ error: friendlyError(error) })
    } finally {
      this.setData({ saving: false })
    }
  },

  async generateAiReport () {
    if (this.data.mode === 'STANDARD') return
    this.setData({ generating: true, error: '' })
    try {
      const report = this.data.mode === 'ORG_AI'
        ? await reportApi.generateOrgAiReport(this.data.orgId, this.data.period)
        : await reportApi.generatePatientAiReport(this.data.patientId)
      if (report && report.reportId) {
        this.setData({ aiReport: formatAiReport(report), empty: false })
      }
      await this.loadAiReport(true)
    } catch (error) {
      this.setData({ error: 'AI 报告生成失败，请稍后重试' })
    } finally {
      this.setData({ generating: false })
    }
  },

  async confirmReport () {
    if (!this.data.aiReport?.reportId) return
    if (!this.data.confirmChecked) {
      wx.showToast({ title: '请先确认后再提交', icon: 'none' })
      return
    }
    this.setData({ saving: true, error: '' })
    try {
      const result = await reportApi.confirmAiReport(this.data.aiReport.reportId, {
        confirmed: true,
        doctorRemark: this.data.doctorRemark
      })
      this.setData({ aiReport: formatAiReport(result) })
      await this.loadAiReport(true)
    } catch (error) {
      this.setData({ error: 'AI 报告确认失败，请稍后重试' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async retry () {
    return this.loadCurrent(true)
  },

  updateDoctorRemark (event) {
    this.setData({ doctorRemark: event.detail.value })
  },

  toggleConfirm (event) {
    this.setData({ confirmChecked: !!event.detail.value })
  },

  backList () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})

module.exports = { currentMonth, formatAiReport, formatReportItem, openTransientUrl }
