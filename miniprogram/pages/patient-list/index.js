const patientApi = require('../../utils/patient-api')
const { ensureSession } = require('../../utils/auth-guard')

const pageSize = 20

const QUICK_FILTERS = [
  { value: 'all', label: '全部患者' },
  { value: 'pending', label: '待随访' },
  { value: 'upcoming', label: '即将随访' },
  { value: 'completed', label: '已随访' },
  { value: 'high', label: '高危' },
  { value: 'critical', label: '极高危' },
  { value: 'attention', label: '重点关注' }
]

const RISK_OPTIONS = [
  { label: '低危', value: 1 },
  { label: '中危', value: 2 },
  { label: '高危', value: 3 },
  { label: '极高危', value: 4 }
]

const VISIT_STATUS_OPTIONS = [
  { label: '待随访', value: 0 },
  { label: '已随访', value: 1 }
]

const PENDING_DOCTOR_ENTRY_ROUTES = {
  followups: '/pages/followups/index',
  monitoring: '/pages/monitoring/index',
  reports: '/pages/reports/index'
}

function friendlyError (error) {
  if (error?.statusCode === 403) return '无权访问患者列表'
  if (error?.statusCode === 401) return '登录状态已失效，请重新登录'
  return '患者列表加载失败，请稍后重试'
}

function maskOrgName (value) {
  const text = String(value || '')
  if (!text) return '机构已隐藏'
  return text.length <= 4 ? `${text.slice(0, 1)}***` : `${text.slice(0, 4)}***`
}

function normalizePatient (patient) {
  const id = String(patient?.id || patient?.patientId || '')
  return Object.assign({}, patient, {
    id,
    orgName: maskOrgName(patient?.serveOrgName || patient?.orgName || patient?.createOrgName),
    statusText: '状态已脱敏',
    statusTone: 'neutral'
  })
}

function isSensitiveKeyword (keyword) {
  const text = String(keyword || '').trim()
  return /^1\d{10}$/.test(text) || /^\d{15}$/.test(text) || /^\d{17}[\dXx]$/.test(text)
}

function consumePendingDoctorEntry () {
  const app = typeof getApp === 'function' ? getApp() : null
  const key = String(app?.globalData?.pendingDoctorEntry || '').trim()
  if (app?.globalData) delete app.globalData.pendingDoctorEntry
  return key
}

Page({
  data: {
    loading: false,
    refreshing: false,
    keyword: '',
    patients: [],
    page: 1,
    hasMore: true,
    error: '',
    empty: false,
    selectionMode: false,
    subtitle: '服务端按当前医生机构范围返回患者',
    quickFilters: QUICK_FILTERS,
    currentFilter: 'all',
    riskOptions: RISK_OPTIONS,
    visitStatusOptions: VISIT_STATUS_OPTIONS,
    riskLevels: [],
    visitStatus: '',
    showAdvancedFilter: false
  },

  async onLoad (query = {}) {
    const selectionMode = String(query.selection || '') === '1'
    this.setData({
      selectionMode,
      subtitle: selectionMode ? '请选择患者后继续进入对应工作内容' : '服务端按当前医生机构范围返回患者'
    })
    try {
      await ensureSession({ role: 'DOCTOR' })
      await this.loadPatients({ reset: true })
    } catch (error) {
      this.setData({ error: friendlyError(error), loading: false, refreshing: false })
    }
  },

  onKeywordInput (event) {
    this.setData({ keyword: event.detail.value || '' })
  },

  async onSearch () {
    if (isSensitiveKeyword(this.data.keyword)) {
      this.setData({ error: '请使用姓名等非敏感关键词搜索', patients: [], empty: false })
      return
    }
    await this.loadPatients({ reset: true })
  },

  async onQuickFilter (event) {
    const currentFilter = String(event.currentTarget.dataset.value || 'all')
    this.setData({ currentFilter, riskLevels: [], visitStatus: '' })
    await this.loadPatients({ reset: true })
  },

  toggleAdvancedFilter () {
    this.setData({ showAdvancedFilter: !this.data.showAdvancedFilter })
  },

  onAdvancedFilterChange (event) {
    const field = String(event.currentTarget.dataset.field || '')
    if (!['riskLevels', 'visitStatus'].includes(field)) return
    this.setData({ [field]: event.detail.value })
  },

  async onApplyFilter () {
    this.setData({ showAdvancedFilter: false })
    await this.loadPatients({ reset: true })
  },

  async resetFilters () {
    this.setData({ currentFilter: 'all', riskLevels: [], visitStatus: '', showAdvancedFilter: false })
    await this.loadPatients({ reset: true })
  },

  async onPullDownRefresh () {
    this.setData({ refreshing: true })
    await this.loadPatients({ reset: true })
    if (wx.stopPullDownRefresh) wx.stopPullDownRefresh()
  },

  async onReachBottom () {
    if (!this.data.hasMore || this.data.loading || this.data.error) return
    await this.loadPatients({ reset: false })
  },

  async retry () {
    await this.loadPatients({ reset: true })
  },

  async loadPatients ({ reset }) {
    const nextPage = reset ? 1 : this.data.page + 1
    this.setData({ loading: true, error: reset ? '' : this.data.error })
    try {
      const result = await patientApi.listPatients({
        page: nextPage,
        pageSize,
        keyword: String(this.data.keyword || '').trim(),
        ...this.buildFilterParams()
      })
      const nextList = (result.list || []).map(normalizePatient)
      const patients = reset ? nextList : this.data.patients.concat(nextList)
      const total = Number(result.total || patients.length)
      this.setData({
        patients,
        page: nextPage,
        hasMore: patients.length < total && nextList.length > 0,
        loading: false,
        refreshing: false,
        empty: patients.length === 0,
        error: ''
      })
    } catch (error) {
      this.setData({
        loading: false,
        refreshing: false,
        error: friendlyError(error),
        empty: false
      })
    }
  },

  onPatientSelect (event) {
    const id = String(event.currentTarget.dataset.id || '')
    if (!id) return
    const app = typeof getApp === 'function' ? getApp() : null
    if (app?.globalData) {
      app.globalData.currentPatientId = id
    }
    const pendingEntry = consumePendingDoctorEntry()
    wx.navigateTo({ url: PENDING_DOCTOR_ENTRY_ROUTES[pendingEntry] || '/pages/patient-detail/index' })
  },

  buildFilterParams () {
    const params = {}
    const quickFilter = this.data.currentFilter
    if (quickFilter === 'pending') params.visitStatus = 0
    if (quickFilter === 'upcoming') params.upcoming = true
    if (quickFilter === 'completed') params.visitStatus = 1
    if (quickFilter === 'high') params.riskLevels = [3]
    if (quickFilter === 'critical') params.riskLevels = [4]
    if (quickFilter === 'attention') params.attentionOnly = true
    if (Array.isArray(this.data.riskLevels) && this.data.riskLevels.length) params.riskLevels = this.data.riskLevels
    if (this.data.visitStatus !== '' && this.data.visitStatus !== null && this.data.visitStatus !== undefined) params.visitStatus = Number(this.data.visitStatus)
    return params
  },

  createPatient () {
    wx.navigateTo({ url: '/pages/patient-detail/index' })
  },

  backWorkspace () {
    const app = typeof getApp === 'function' ? getApp() : null
    if (app?.globalData) delete app.globalData.pendingDoctorEntry
    wx.navigateBack ? wx.navigateBack() : wx.switchTab({ url: '/pages/home/home' })
  }
})

module.exports = { PENDING_DOCTOR_ENTRY_ROUTES, consumePendingDoctorEntry, friendlyError, maskOrgName, normalizePatient }
