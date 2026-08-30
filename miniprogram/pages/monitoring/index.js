const monitoringApi = require('../../utils/monitoring-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '-') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function formatDate (value) {
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

function buildRangeOptions (scope) {
  return scope === 'DOCTOR'
    ? [
        { label: '30 天', value: '30d' },
        { label: '7 天', value: '7d' }
      ]
    : [
        { label: '7 天', value: '7d' },
        { label: '30 天', value: '30d' }
      ]
}

function formatSummaryCards (summary) {
  return [
    {
      key: 'attentionLevel',
      title: '关注等级',
      value: valueText(summary?.attentionLevelText || summary?.attentionLevel),
      caption: valueText(summary?.primaryAlertReason || summary?.disclaimer || '服务端监测结果'),
      tone: 'warning'
    },
    {
      key: 'dataStatus',
      title: '数据状态',
      value: valueText(summary?.dataStatus),
      caption: valueText(summary?.primaryAlertType || '由服务端返回'),
      tone: 'neutral'
    },
    {
      key: 'activeAlertCount',
      title: '当前告警',
      value: valueText(summary?.activeAlertCount),
      caption: valueText(summary?.latestAlertAt ? formatDate(summary.latestAlertAt) : '当前统计'),
      tone: 'warning'
    },
    {
      key: 'deviceName',
      title: '设备',
      value: valueText(summary?.deviceName),
      caption: valueText(summary?.deviceBatteryLevel === null || summary?.deviceBatteryLevel === undefined ? '电量未知' : `${summary.deviceBatteryLevel}%`),
      tone: 'success'
    }
  ]
}

function formatSeries (label, series) {
  return {
    key: label,
    title: label,
    points: (Array.isArray(series) ? series : []).map(point => ({
      dateText: formatDate(point?.date || point?.measuredAt || point?.createdAt),
      value: `${valueText(point?.value)}${point?.unit ? ` ${point.unit}` : ''}`,
      caption: valueText(point?.caption || point?.note || '')
    }))
  }
}

function formatTrendSections (trend) {
  return [
    formatSeries('血氧', trend?.bloodOxygen),
    formatSeries('心率', trend?.heartRate),
    formatSeries('步数', trend?.steps),
    formatSeries('睡眠时长', trend?.sleepDuration)
  ]
}

function formatAlerts (response) {
  const list = Array.isArray(response?.list) ? response.list : []
  return list.map(item => ({
    id: String(item.id || ''),
    patientId: String(item.patientId || ''),
    levelText: valueText(item.levelText || item.level, '提示'),
    levelTone: 'warning',
    alertType: valueText(item.alertType, '监测提醒'),
    alertValueText: item.alertValue === null || item.alertValue === undefined || item.alertValue === ''
      ? '-'
      : `${item.alertValue}${item.alertUnit ? ` ${item.alertUnit}` : ''}`,
    reason: valueText(item.reason || item.alertReason || '服务端提醒'),
    active: Number(item.active) !== 0,
    acknowledgedAt: item.acknowledgedAt ? formatDate(item.acknowledgedAt) : '',
    occurredAt: formatDate(item.occurredAt)
  }))
}

function friendlyError (error) {
  if (error?.statusCode === 401) return '登录状态已失效，请重新登录'
  if (error?.statusCode === 403) return '无权查看监测'
  if (error?.statusCode === 404) return '监测数据不存在'
  return '监测加载失败，请稍后重试'
}

function missingPatientMessage (scope) {
  return scope === 'DOCTOR' ? '请选择患者后再查看监测' : '请先完成建档后再查看监测'
}

function consumeDoctorPatientId (query = {}) {
  const app = typeof getApp === 'function' ? getApp() : null
  const transientPatientId = String(app?.globalData?.currentPatientId || '').trim()
  if (app?.globalData) {
    delete app.globalData.currentPatientId
  }
  return transientPatientId
}

Page({
  data: {
    scope: 'PATIENT',
    patientId: '',
    loading: false,
    error: '',
    empty: false,
    rangeKey: '7d',
    rangeOptions: buildRangeOptions('PATIENT'),
    summaryCards: [],
    trendSections: [],
    alerts: [],
    page: 1,
    pageSize: 20,
    total: 0,
    hasMore: false,
    acknowledgingId: ''
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
        rangeKey: scope === 'DOCTOR' ? '30d' : '7d',
        rangeOptions: buildRangeOptions(scope)
      })
      if (!patientId) {
        this.setData({
          error: missingPatientMessage(scope),
          loading: false,
          empty: false
        })
        return
      }
      await this.loadMonitoring(true)
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error), empty: false })
    }
  },

  async loadMonitoring (reset = false) {
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
      const [summary, trend, alerts] = await Promise.all([
        monitoringApi.getMonitoringSummary(this.data.patientId),
        monitoringApi.getMonitoringTrends(this.data.patientId, { range: this.data.rangeKey }),
        monitoringApi.getMonitoringAlerts(this.data.patientId, { page, pageSize })
      ])
      const alertList = formatAlerts(alerts)
      this.setData({
        loading: false,
        page,
        total: Number(alerts?.total || alertList.length || 0),
        hasMore: page * pageSize < Number(alerts?.total || alertList.length || 0),
        summaryCards: formatSummaryCards(summary),
        trendSections: formatTrendSections(trend),
        alerts: reset ? alertList : this.data.alerts.concat(alertList),
        empty: false
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: friendlyError(error),
        empty: false
      })
    }
  },

  async onRangeChange (event) {
    const rangeKey = String(event.detail.value || event.currentTarget.dataset.value || this.data.rangeKey)
    this.setData({ rangeKey })
    await this.loadMonitoring(true)
  },

  async acknowledgeAlert (event) {
    const id = String(event.currentTarget.dataset.id || '')
    if (!id) return
    this.setData({ acknowledgingId: id })
    try {
      await monitoringApi.acknowledgeAlert(id)
      await this.loadMonitoring(true)
    } catch (error) {
      this.setData({ error: friendlyError(error) })
    } finally {
      this.setData({ acknowledgingId: '' })
    }
  },

  retry () {
    return this.loadMonitoring(true)
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})

module.exports = { buildRangeOptions, currentMonth, formatAlerts, formatSummaryCards, formatTrendSections }

