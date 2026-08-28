const patientApi = require('../../utils/patient-api')
const { ensureSession } = require('../../utils/auth-guard')

const pageSize = 20

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
    statusTone: patient?.attentionLevel === 2 || patient?.riskLevel === 2 ? 'danger'
      : patient?.attentionLevel === 1 || patient?.riskLevel === 1 ? 'warning' : 'success'
  })
}

function isSensitiveKeyword (keyword) {
  const text = String(keyword || '').trim()
  return /^1\d{10}$/.test(text) || /^\d{15}$/.test(text) || /^\d{17}[\dXx]$/.test(text)
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
    empty: false
  },

  async onLoad () {
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
        keyword: String(this.data.keyword || '').trim()
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
    wx.navigateTo({ url: `/pages/patient-detail/index?id=${encodeURIComponent(id)}` })
  },

  createPatient () {
    wx.navigateTo({ url: '/pages/patient-detail/index' })
  },

  backWorkspace () {
    wx.navigateBack ? wx.navigateBack() : wx.switchTab({ url: '/pages/home/home' })
  }
})
