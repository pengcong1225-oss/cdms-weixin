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

function formatReport (item) {
  return Object.assign({}, item, {
    id: String(item.reportId || item.id || ''),
    reportId: String(item.reportId || item.id || ''),
    patientId: String(item.patientId || ''),
    fileId: valueText(item.fileId, ''),
    reportNo: valueText(item.reportNo, '未命名报告'),
    categoryText: valueText(item.category, '标准报告'),
    createdAtText: formatDateTime(item.createdAt),
    statusText: item.downloadAvailable ? '可下载' : '已归档'
  })
}

function buildAiActions (scope) {
  return scope === 'DOCTOR'
    ? [
        { key: 'org-ai', title: '机构 AI 报告', subtitle: '查看或生成机构 AI 报告', icon: '智', disabled: false }
      ]
    : [
        { key: 'patient-ai', title: 'AI 报告', subtitle: '查看或生成个人 AI 报告', icon: '智', disabled: false }
      ]
}

function friendlyError (error) {
  if (error?.statusCode === 401) return '登录状态已失效，请重新登录'
  if (error?.statusCode === 403) return '无权查看报告'
  if (error?.statusCode === 404) return '报告不存在'
  return '报告加载失败，请稍后重试'
}

function missingPatientMessage (scope) {
  return scope === 'DOCTOR' ? '请选择患者后再查看报告' : '请先完成建档后再查看报告'
}

function consumeDoctorPatientId (query = {}) {
  const app = typeof getApp === 'function' ? getApp() : null
  const transientPatientId = String(app?.globalData?.currentPatientId || '').trim()
  if (app?.globalData) {
    delete app.globalData.currentPatientId
  }
  return transientPatientId
}

function persistDoctorPatientId (patientId) {
  const app = typeof getApp === 'function' ? getApp() : null
  if (!app?.globalData) return
  const nextPatientId = String(patientId || '').trim()
  if (nextPatientId) {
    app.globalData.currentPatientId = nextPatientId
    return
  }
  delete app.globalData.currentPatientId
}

Page({
  data: {
    scope: 'PATIENT',
    patientId: '',
    loading: false,
    error: '',
    empty: false,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    reports: [],
    aiActions: []
  },

  async onLoad (query = {}) {
    try {
      const session = await ensureSession({ role: getApp()?.globalData?.activeRole || 'PATIENT' })
      const scope = session.activeRole === 'DOCTOR' ? 'DOCTOR' : 'PATIENT'
      const patientId = scope === 'DOCTOR'
        ? consumeDoctorPatientId(query)
        : String(session.patientRef || session.patientId || '')
      this.setData({
        scope,
        patientId,
        aiActions: buildAiActions(scope)
      })
      if (!patientId) {
        this.setData({
          error: missingPatientMessage(scope),
          loading: false,
          empty: false
        })
        return
      }
      await this.loadReports(true)
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error), empty: false })
    }
  },

  async loadReports (reset = false) {
    if (!this.data.patientId) {
      this.setData({
        loading: false,
        error: missingPatientMessage(this.data.scope),
        empty: false
      })
      return
    }
    const page = reset ? 1 : this.data.page
    const pageSize = this.data.pageSize
    this.setData({ loading: true, error: '', empty: false })
    try {
      const response = await reportApi.listPatientReports(this.data.patientId, { page, pageSize })
      const list = Array.isArray(response?.items)
        ? response.items
        : Array.isArray(response?.list)
          ? response.list
          : Array.isArray(response?.records)
            ? response.records
            : []
      const reports = list.map(formatReport)
      const total = Number(response?.total || reports.length || 0)
      this.setData({
        loading: false,
        page,
        reports: reset ? reports : this.data.reports.concat(reports),
        total,
        hasMore: page * pageSize < total,
        empty: reports.length === 0 && page === 1
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: friendlyError(error),
        empty: false
      })
    }
  },

  onReportTap (event) {
    const reportId = String(event.currentTarget.dataset.reportId || '')
    if (!reportId) return
    if (this.data.scope === 'DOCTOR') {
      persistDoctorPatientId(this.data.patientId)
    }
    wx.navigateTo({
      url: reportApi.buildReportRoute({
        reportId
      })
    })
  },

  onAiActionTap (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key) return
    if (key === 'org-ai') {
      wx.navigateTo({ url: `/pages/reports/detail?mode=org&period=${encodeURIComponent(this.currentPeriod())}` })
      return
    }
    if (this.data.scope === 'DOCTOR') {
      persistDoctorPatientId(this.data.patientId)
    }
    wx.navigateTo({ url: '/pages/reports/detail?mode=patient' })
  },

  currentPeriod () {
    const now = new Date()
    const pad = value => String(value).padStart(2, '0')
    return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
  },

  onReachBottom () {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ page: this.data.page + 1 })
    return this.loadReports(false)
  },

  retry () {
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

module.exports = { buildAiActions, formatReport }

