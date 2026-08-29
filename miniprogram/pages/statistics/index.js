const statsApi = require('../../utils/stats-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '-') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function pad (value) {
  return String(value).padStart(2, '0')
}

function currentMonth () {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}`
}

function todayDate () {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function startOfMonth () {
  const now = new Date()
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-01`
}

function startDaysAgo (days) {
  const now = new Date()
  now.setDate(now.getDate() - days)
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`
}

function formatNumber (value) {
  if (value === null || value === undefined || value === '') return '-'
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return String(value)
  return Number.isInteger(numeric) ? String(numeric) : numeric.toFixed(1)
}

function buildPatientCards (stats, followupStats) {
  return [
    { key: 'totalFollowups', title: '随访总数', value: formatNumber(stats?.totalFollowups), caption: '本人累计随访', tone: 'success' },
    { key: 'myPatients', title: '服务患者', value: formatNumber(stats?.myPatients), caption: '当前服务患者数', tone: 'neutral' },
    { key: 'thisMonth', title: '本月随访', value: formatNumber(stats?.thisMonth), caption: '本月已完成', tone: 'warning' },
    { key: 'avgPerDay', title: '日均随访', value: formatNumber(stats?.avgPerDay), caption: '来自服务端统计', tone: 'success' }
  ]
}

function buildDoctorCards (homeStats) {
  return [
    { key: 'totalPatients', title: '在管患者', value: formatNumber(homeStats?.totalPatients), caption: '服务端患者数', tone: 'success' },
    { key: 'todayPending', title: '今日待办', value: formatNumber(homeStats?.todayPending), caption: '今日待随访', tone: 'warning' },
    { key: 'todayCompleted', title: '今日完成', value: formatNumber(homeStats?.todayCompleted), caption: '今日已完成', tone: 'neutral' },
    { key: 'highRiskCount', title: '高危患者', value: formatNumber(homeStats?.highRiskCount), caption: '服务端风险分层', tone: 'danger' }
  ]
}

function buildTrendRows (items, labelKey = 'month', valueKey = 'count') {
  return (Array.isArray(items) ? items : []).map(item => ({
    label: valueText(item?.[labelKey], '未命名'),
    value: formatNumber(item?.[valueKey]),
    caption: valueText(item?.name || item?.type, '')
  }))
}

function buildHighlightRows (items) {
  return (Array.isArray(items) ? items : []).map(item => ({
    label: valueText(item?.name || item?.riskLevelText || item?.levelText, '重点患者'),
    value: [valueText(item?.catScore, '-'), valueText(item?.age, '-'), valueText(item?.riskLevelText || item?.riskLevel, '-')].join(' · '),
    caption: item?.patientId ? `患者ID ${item.patientId}` : ''
  }))
}

function rangeLabel (mode, key) {
  if (mode === 'DOCTOR') {
    return key === 'prevMonth' ? '上月' : '本月'
  }
  if (key === '7d') return '近7天'
  if (key === 'month') return '本月'
  return '近30天'
}

function buildRangeOptions (mode) {
  return mode === 'DOCTOR'
    ? [
        { label: '本月', value: 'month' },
        { label: '上月', value: 'prevMonth' }
      ]
    : [
        { label: '近7天', value: '7d' },
        { label: '近30天', value: '30d' },
        { label: '本月', value: 'month' }
      ]
}

Page({
  data: {
    mode: 'PATIENT',
    rangeKey: '30d',
    rangeLabel: '近30天',
    rangeOptions: buildRangeOptions('PATIENT'),
    summaryCards: [],
    trendRows: [],
    detailRows: [],
    highlightRows: [],
    trendTitle: '随访趋势',
    trendCaption: '统计由服务端返回',
    detailTitle: '类型分布',
    highlightTitle: '重点患者',
    loading: false,
    error: ''
  },

  async onLoad () {
    const session = await ensureSession({ role: getApp()?.globalData?.activeRole || 'PATIENT' })
    const mode = session.activeRole === 'DOCTOR' ? 'DOCTOR' : 'PATIENT'
    const rangeKey = mode === 'DOCTOR' ? 'month' : '30d'
    this.setData({
      mode,
      rangeKey,
      rangeLabel: rangeLabel(mode, rangeKey),
      rangeOptions: buildRangeOptions(mode)
    })
    await this.loadStats(true)
  },

  async loadStats (reset = false) {
    const mode = this.data.mode
    this.setData({ loading: true, error: '' })
    try {
      if (mode === 'DOCTOR') {
        const [homeStats, detail] = await Promise.all([
          statsApi.getHomeStats(),
          statsApi.getStatsDetail({
            month: this.data.rangeKey === 'prevMonth'
              ? (() => {
                  const current = new Date()
                  current.setMonth(current.getMonth() - 1)
                  return `${current.getFullYear()}-${pad(current.getMonth() + 1)}`
                })()
              : currentMonth(),
            orgId: getApp()?.globalData?.orgId || ''
          })
        ])
        this.setData({
          summaryCards: buildDoctorCards(homeStats),
          trendRows: buildTrendRows(detail?.riskDistribution || [], 'name', 'count'),
          detailRows: buildTrendRows(detail?.patientStats ? [
            { name: '患者总数', count: detail.patientStats.total },
            { name: '本月新增', count: detail.patientStats.newThisMonth },
            { name: '高危患者', count: detail.patientStats.highRisk },
            { name: '7 日待办', count: detail.patientStats.pending7days }
          ] : [], 'name', 'count'),
          highlightRows: buildHighlightRows(detail?.highRiskPatients || []),
          trendTitle: '风险分布',
          trendCaption: `时间范围：${this.data.rangeLabel}`,
          detailTitle: '随访概览',
          highlightTitle: '高危患者',
          loading: false
        })
        return
      }

      const [stats, followupStats] = await Promise.all([
        statsApi.getMyStats(),
        statsApi.getMyFollowupStats(this.data.rangeKey === 'month'
          ? { startDate: startOfMonth(), endDate: todayDate() }
          : this.data.rangeKey === '7d'
            ? { startDate: startDaysAgo(6), endDate: todayDate() }
            : { startDate: startDaysAgo(29), endDate: todayDate() })
      ])
      this.setData({
        summaryCards: buildPatientCards(stats, followupStats),
        trendRows: buildTrendRows(followupStats?.byMonth || [], 'month', 'count'),
        detailRows: buildTrendRows(followupStats?.byType || [], 'name', 'count'),
        highlightRows: [],
        trendTitle: '随访趋势',
        trendCaption: `时间范围：${this.data.rangeLabel}`,
        detailTitle: '类型分布',
        highlightTitle: '重点患者',
        loading: false
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: error?.statusCode === 403 ? '无权查看统计' : '统计加载失败'
      })
    }
  },

  async onRangeChange (event) {
    const rangeKey = String(event.detail.value || event.currentTarget.dataset.value || this.data.rangeKey)
    this.setData({
      rangeKey,
      rangeLabel: rangeLabel(this.data.mode, rangeKey)
    })
    await this.loadStats(true)
  },

  retry () {
    return this.loadStats(true)
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})

module.exports = {
  buildDoctorCards,
  buildHighlightRows,
  buildPatientCards,
  buildRangeOptions,
  buildTrendRows,
  currentMonth,
  rangeLabel,
  startDaysAgo
}
