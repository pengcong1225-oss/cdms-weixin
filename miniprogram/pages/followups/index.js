const followupApi = require('../../utils/followup-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '-') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function formatDateTime (value) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}

function formatFollowup (item) {
  const visitTypeText = valueText(item.visitTypeText || item.visitType)
  const statusText = valueText(item.patientStatusText || item.patientStatus)
  const catScoreText = item.catScore === null || item.catScore === undefined || item.catScore === ''
    ? '-'
    : `CAT ${item.catScore}`
  const mmrcText = item.mmrcGradeText || (item.mmrcOption ? `mMRC ${item.mmrcOption}` : '-')
  const photoCount = Array.isArray(item.photos) ? item.photos.length : Number(item.photoCount || 0)
  return Object.assign({}, item, {
    id: String(item.id || ''),
    patientId: String(item.patientId || ''),
    visitDateText: formatDateTime(item.visitDate),
    statusTone: String(item.patientStatus) === '2' || /加重|高危|恶化/.test(statusText) ? 'warning' : 'success',
    summaryText: [visitTypeText, catScoreText, mmrcText].filter(Boolean).join(' · '),
    metaText: [valueText(item.operator, '服务端返回'), photoCount ? `照片 ${photoCount} 张` : '无照片'].join(' · ')
  })
}

function friendlyError (error) {
  if (error?.statusCode === 403) return '无权查看随访列表'
  if (error?.statusCode === 404) return '随访记录不存在'
  return '随访列表加载失败'
}

Page({
  data: {
    scope: 'PATIENT',
    scopeLabel: '我的随访',
    canEdit: false,
    patientId: '',
    loading: false,
    error: '',
    empty: false,
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    followups: [],
    headerSubtitle: '患者个人随访由服务端按当前登录身份返回'
  },

  async onLoad (query = {}) {
    const session = await ensureSession({ role: getApp()?.globalData?.activeRole || 'PATIENT' })
    const patientId = String(query.patientId || query.id || session.patientId || session.patientRef || '')
    const scope = session.activeRole === 'DOCTOR' ? 'DOCTOR' : 'PATIENT'
    this.setData({
      scope,
      scopeLabel: scope === 'DOCTOR' ? '患者随访' : '我的随访',
      canEdit: session.activeRole === 'DOCTOR',
      patientId: scope === 'DOCTOR' ? patientId : String(session.patientRef || session.patientId || ''),
      headerSubtitle: scope === 'DOCTOR'
        ? '医生在患者上下文中查看和新建随访'
        : '患者仅查看自己的随访历史'
    })
    await this.loadFollowups(true)
  },

  async loadFollowups (reset = false) {
    const page = reset ? 1 : this.data.page
    const pageSize = this.data.pageSize
    this.setData({ loading: true, error: '', empty: false })
    try {
      const useDoctorScope = this.data.scope === 'DOCTOR' && this.data.patientId
      const response = useDoctorScope
        ? await followupApi.listPatientFollowups(this.data.patientId, { page, pageSize })
        : await followupApi.listMyFollowups({ page, pageSize })
      const list = Array.isArray(response?.list)
        ? response.list
        : Array.isArray(response?.records)
          ? response.records
          : Array.isArray(response?.items)
            ? response.items
            : []
      const followups = list.map(formatFollowup)
      const total = Number(response?.total || response?.count || followups.length || 0)
      this.setData({
        page,
        followups: reset ? followups : this.data.followups.concat(followups),
        total,
        hasMore: page * pageSize < total,
        empty: followups.length === 0 && page === 1,
        loading: false
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: friendlyError(error),
        empty: false
      })
    }
  },

  async onReachBottom () {
    if (this.data.loading || !this.data.hasMore) return
    this.setData({ page: this.data.page + 1 })
    await this.loadFollowups(false)
  },

  onFollowupSelect (event) {
    const id = String(event.currentTarget.dataset.id || '')
    if (!id) return
    wx.navigateTo({ url: `/pages/followups/detail?id=${encodeURIComponent(id)}` })
  },

  createFollowup () {
    if (!this.data.canEdit || !this.data.patientId) {
      wx.showToast({ title: '请选择患者后再新建随访', icon: 'none' })
      return
    }
    wx.navigateTo({ url: `/pages/followups/detail?patientId=${encodeURIComponent(this.data.patientId)}` })
  },

  retry () {
    return this.loadFollowups(true)
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
