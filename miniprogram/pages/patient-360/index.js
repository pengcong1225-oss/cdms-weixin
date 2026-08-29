const patientApi = require('../../utils/patient-api')
const { ensureSession } = require('../../utils/auth-guard')

function value (item) {
  return item === null || item === undefined || item === '' ? '-' : String(item)
}

function withSuffix (item, suffix) {
  return item === null || item === undefined || item === '' ? '-' : `${item}${suffix}`
}

function date (item) {
  return item ? String(item).replace('T', ' ').slice(0, 16) : '-'
}

function maskOrgName (item) {
  const text = String(item || '')
  if (!text) return '-'
  return text.length <= 4 ? `${text.slice(0, 1)}***` : `${text.slice(0, 4)}***`
}

function maskPhone (item) {
  const text = String(item || '')
  return /^1\d{10}$/.test(text) ? `${text.slice(0, 3)}****${text.slice(7)}` : (text ? '手机号已脱敏' : '-')
}

function maskIdCard (item) {
  const text = String(item || '')
  return text.length >= 8 ? `${text.slice(0, 6)}********${text.slice(-4)}` : (text ? '证件号已脱敏' : '-')
}

function firstFollowup (data) {
  const followups = data?.followups
  if (Array.isArray(followups)) return followups[0] || null
  return followups?.list?.[0] || null
}

function normalizeDeviceMetrics (data) {
  if (Array.isArray(data?.deviceMetrics)) return data.deviceMetrics
  const summary = data?.detail?.monitoringSummary || data?.monitoringSummary
  if (!summary) return []
  return [
    {
      type: summary.primaryAlertType || '设备状态',
      value: summary.primaryAlertValue || summary.dataStatus || summary.attentionLevelText,
      unit: summary.primaryAlertUnit || '',
      measuredAt: summary.lastMeasurementAt
    }
  ].filter(item => item.value)
}

function normalizeRiskTips (data) {
  if (Array.isArray(data?.riskTips)) return data.riskTips
  const summary = data?.detail?.monitoringSummary || data?.monitoringSummary
  if (!summary?.primaryAlertReason && !summary?.attentionLevelText) return []
  return [{ levelText: summary.attentionLevelText || '服务端提示', message: summary.primaryAlertReason || summary.disclaimer || '-' }]
}

function buildSections (data) {
  const detail = data?.detail || data?.summary || {}
  const basic = detail.basicInfo || {}
  const org = detail.orgInfo || {}
  const lung = detail.lungFunction || {}
  const smoke = detail.smokeInfo || {}
  const copd = detail.copdInfo || {}
  const latest = firstFollowup(data)
  const deviceMetrics = normalizeDeviceMetrics(data)
  const riskTips = normalizeRiskTips(data)
  return {
    basicInfo: {
      title: '基本信息',
      items: [
        { label: '姓名', value: value(basic.name) },
        { label: '性别年龄', value: `${value(basic.genderText)} · ${withSuffix(basic.age, '岁')}` },
        { label: '手机号', value: maskPhone(basic.phone) },
        { label: '证件号', value: maskIdCard(basic.idCard) },
        { label: '机构', value: maskOrgName(org.serveOrgName || org.orgName || org.createOrgName) }
      ]
    },
    copd: {
      title: 'COPD 专档',
      items: [
        { label: '吸烟状态', value: value(smoke.smokeStatusText) },
        { label: 'GOLD', value: value(lung.goldGradeText) },
        { label: 'CAT', value: value(lung.catScore) },
        { label: 'mMRC', value: value(lung.mmrcGradeText) },
        { label: '症状', value: value(copd.symptom) }
      ]
    },
    latestFollowup: {
      title: '最近随访',
      items: latest ? [
        { label: '状态', value: value(latest.patientStatusText || latest.patientStatus) },
        { label: '日期', value: date(latest.visitDate) },
        { label: '下次随访', value: date(latest.nextVisitDate) }
      ] : []
    },
    deviceMetrics: {
      title: '设备指标',
      items: deviceMetrics.map(item => ({
        label: value(item.type || item.name),
        value: `${value(item.value)}${item.unit ? ` ${item.unit}` : ''}`,
        caption: date(item.measuredAt || item.occurredAt)
      }))
    },
    riskTips: {
      title: '风险提示',
      items: riskTips.map(item => ({
        label: value(item.levelText || item.level || item.title),
        value: value(item.message || item.reason || item.content),
        caption: date(item.updatedAt || item.occurredAt)
      }))
    }
  }
}

function friendlyError (error) {
  if (error?.statusCode === 403) return '无权查看患者360'
  if (error?.statusCode === 404) return '患者360不存在'
  return '患者360加载失败，请稍后重试'
}

Page({
  data: {
    patientId: '',
    loading: false,
    error: '',
    data: null,
    sections: buildSections(null),
    quickActions: [
      { key: 'monitoring', title: '监测中心', subtitle: '查看监测摘要、趋势和告警', icon: '测', disabled: false },
      { key: 'reports', title: '报告中心', subtitle: '查看标准报告和 AI 报告', icon: '报', disabled: false }
    ]
  },

  async onLoad (query = {}) {
    const patientId = String(query.patientId || query.id || '')
    this.setData({ patientId })
    await ensureSession({ role: 'DOCTOR' })
    await this.load360()
  },

  async load360 () {
    if (!this.data.patientId) {
      this.setData({ error: '缺少患者 ID' })
      return
    }
    this.setData({ loading: true, error: '' })
    try {
      const data = await patientApi.getPatient360(this.data.patientId)
      this.setData({ data, sections: buildSections(data), loading: false })
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error) })
    }
  },

  retry () {
    return this.load360()
  },

  onQuickActionSelect (event) {
    const key = String(event.currentTarget.dataset.key || '')
    if (!key || !this.data.patientId) return
    if (key === 'monitoring') {
      wx.navigateTo({ url: `/pages/monitoring/index?patientId=${encodeURIComponent(this.data.patientId)}` })
      return
    }
    if (key === 'reports') {
      wx.navigateTo({ url: `/pages/reports/index?patientId=${encodeURIComponent(this.data.patientId)}` })
    }
  },

  backDetail () {
    wx.navigateBack ? wx.navigateBack() : wx.navigateTo({ url: `/pages/patient-detail/index?id=${encodeURIComponent(this.data.patientId)}` })
  }
})

module.exports = { buildSections }
