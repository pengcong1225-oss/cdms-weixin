const api = require('../../../utils/api')
const bleManager = require('../../../services/bleManager')
const { ensureSession } = require('../../../utils/auth-guard')
const patientApi = require('../../../utils/patient-api')
const statsApi = require('../../../utils/stats-api')

const DOCTOR_ENTRY_ROUTES = [
  { key: 'patients', title: '患者管理', subtitle: '查看患者列表、新增档案和患者360', icon: '患', url: '/pages/patient-list/index' },
  { key: 'station', title: '体脂秤工作站', subtitle: '创建场次、扫码签到和轮测确认', icon: '秤', url: '/pages/device-scale/station/index' },
  { key: 'followups', title: '随访工作', subtitle: '查看患者随访列表并新建原生随访', icon: '访', url: '/pages/followups/index', requiresPatientContext: true },
  { key: 'monitoring', title: '监测中心', subtitle: '查看患者监测摘要、趋势和告警', icon: '测', url: '/pages/monitoring/index', requiresPatientContext: true },
  { key: 'messages', title: '消息中心', subtitle: '查看服务端消息并标记已读', icon: '信', url: '/pages/messages/index' },
  { key: 'statistics', title: '统计中心', subtitle: '查看服务数据、待办和风险分层统计', icon: '统', url: '/pages/statistics/index' },
  { key: 'reports', title: '报告中心', subtitle: '查看患者标准报告与 AI 报告', icon: '报', url: '/pages/reports/index', requiresPatientContext: true },
  { key: 'devices', title: '设备工作站', subtitle: '指环、MFA-1 和 Sunvou 原生入口', icon: '设', url: '/pages/device/device' }
]

const PATIENT_SCOPED_ENTRY_ROUTES = DOCTOR_ENTRY_ROUTES.reduce((routes, entry) => {
  if (entry.requiresPatientContext) routes[entry.key] = entry.url
  return routes
}, {})

const TAB_BAR_URLS = new Set(['/pages/doctor/workspace/index', '/pages/patient-list/index', '/pages/statistics/index', '/pages/device/device'])
const PRIMARY_ACTION_KEYS = ['patients', 'followups', 'monitoring', 'statistics', 'reports', 'messages']
const DEVICE_ACTION_KEYS = ['devices', 'station']

function formatNumber (value) {
  if (value === null || value === undefined || value === '') return '-'
  const numeric = Number(value)
  return Number.isFinite(numeric) ? String(numeric) : String(value)
}

function formatDate (value) {
  const text = String(value || '').trim()
  return text ? text.replace('T', ' ').slice(0, 16) : '暂无安排'
}

function buildSummaryCards (stats) {
  return [
    { key: 'totalPatients', title: '在管患者', value: formatNumber(stats?.totalPatients), caption: '当前服务患者数', tone: 'success' },
    { key: 'todayPending', title: '今日待随访', value: formatNumber(stats?.todayPending), caption: '优先处理待办', tone: 'warning' },
    { key: 'upcoming3Days', title: '未来 3 天待办', value: formatNumber(stats?.upcoming3Days), caption: '即将到期随访', tone: 'neutral' },
    { key: 'highRiskCount', title: '高危患者', value: formatNumber(stats?.highRiskCount), caption: '需要重点关注', tone: 'danger' }
  ]
}

function normalizeTodoPatient (patient) {
  const item = Object.assign({}, patient || {})
  const statusText = item.visitStatusText || (Number(item.visitStatus) === 1 ? '已随访' : '待随访')
  const riskText = item.riskLevelText || (Number(item.riskLevel) >= 4 ? '极高危' : Number(item.riskLevel) === 3 ? '高危' : Number(item.riskLevel) === 2 ? '中危' : '低危')
  return Object.assign(item, {
    id: String(item.id || item.patientId || ''),
    patientId: String(item.patientId || item.id || ''),
    statusText,
    riskText,
    riskLevelText: riskText,
    nextVisitText: formatDate(item.nextVisitDate),
    priorityText: Number(item.riskLevel) >= 3 ? '重点关注' : statusText
  })
}

function sortTodoPatients (patients) {
  return (Array.isArray(patients) ? patients : [])
    .map(normalizeTodoPatient)
    .filter(item => item.id && (item.visitStatus === undefined || item.visitStatus === null || Number(item.visitStatus) === 0))
    .sort((a, b) => {
      const riskDelta = Number(b.riskLevel || 0) - Number(a.riskLevel || 0)
      if (riskDelta) return riskDelta
      return String(a.nextVisitDate || '9999-99-99').localeCompare(String(b.nextVisitDate || '9999-99-99'))
    })
}

function buildStats () {
  return [
    { key: 'patients', title: '患者入口', value: '3', caption: '列表、建档与患者360', tone: 'success' },
    { key: 'native', title: '原生入口', value: String(DOCTOR_ENTRY_ROUTES.length), caption: '随访、监测、消息、统计、报告与设备工作站', tone: 'neutral' }
  ]
}

function normalizeEntries () {
  return DOCTOR_ENTRY_ROUTES.map(item => Object.assign({ disabled: false }, item))
}

function resolveCurrentPatientId (query = {}, session = {}, fallback = '') {
  const app = typeof getApp === 'function' ? getApp() : null
  return String(
    session.currentPatientId ||
    app?.globalData?.currentPatientId ||
    fallback ||
    ''
  ).trim()
}

function buildEntryUrl (entry, patientId) {
  return entry?.url || ''
}

function persistTransientPatientContext (patientId) {
  const app = typeof getApp === 'function' ? getApp() : null
  if (!app?.globalData) return
  const nextPatientId = String(patientId || '').trim()
  if (nextPatientId) {
    app.globalData.currentPatientId = nextPatientId
    return
  }
  delete app.globalData.currentPatientId
}

function persistPendingDoctorEntry (entryKey) {
  const app = typeof getApp === 'function' ? getApp() : null
  if (!app?.globalData) return
  const key = String(entryKey || '').trim()
  if (key && PATIENT_SCOPED_ENTRY_ROUTES[key]) {
    app.globalData.pendingDoctorEntry = key
    return
  }
  delete app.globalData.pendingDoctorEntry
}

function buildStateMessage (patientId) {
  if (String(patientId || '').trim()) {
    return '患者管理、随访、监测、消息、统计、报告、体脂秤和设备工作站均可进入；当前患者上下文仅保存在本次小程序内存中，不进入路由地址。'
  }
  return '患者管理、随访、监测、消息、统计、报告、体脂秤和设备工作站均可进入；随访、监测和报告在缺少患者上下文时会提示先选择患者。'
}

function buildDeviceSummary (state = {}) {
  const device = state.boundDevice || null
  return {
    bound: !!device,
    name: device?.name || device?.deviceName || '尚未绑定设备',
    connectionText: state.connected ? '已连接' : device ? '未连接' : '待绑定',
    syncText: device?.lastHealthSyncAt ? `最近同步 ${formatDate(device.lastHealthSyncAt)}` : '绑定后同步健康数据'
  }
}

function buildActionGroups (entries) {
  const normalized = Array.isArray(entries) ? entries : []
  return {
    primaryActions: PRIMARY_ACTION_KEYS.map(key => normalized.find(item => item.key === key)).filter(Boolean),
    deviceActions: DEVICE_ACTION_KEYS.map(key => normalized.find(item => item.key === key)).filter(Boolean)
  }
}

Page({
  data: {
    loading: false,
    currentPatientId: '',
    error: '',
    stateMessage: buildStateMessage(''),
    summaryCards: buildSummaryCards({}),
    stats: buildStats(),
    todoPatients: [],
    todoTotal: 0,
    deviceSummary: buildDeviceSummary(),
    ...buildActionGroups(normalizeEntries()),
    entries: normalizeEntries()
  },

  async onLoad (query = {}) {
    await this.ensureDoctor(query)
  },

  async onShow () {
    await this.ensureDoctor()
  },

  async ensureDoctor (query = {}) {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      const currentPatientId = resolveCurrentPatientId(query, session, this.data.currentPatientId)
      this.setData({
        loading: true,
        currentPatientId,
        error: '',
        stateMessage: buildStateMessage(currentPatientId),
        stats: buildStats(),
        entries: normalizeEntries(),
        ...buildActionGroups(normalizeEntries())
      })
      await this.loadDashboard()
    } catch (error) {
      this.setData({
        loading: false,
        currentPatientId: '',
        error: error?.statusCode === 401 ? '登录状态已失效，请重新登录' : '医生工作台加载失败，请稍后重试',
        entries: []
      })
    }
  },

  async loadDashboard () {
    this.setData({ loading: true, error: '' })
    try {
      const [homeStats, patientResult] = await Promise.all([
        statsApi.getHomeStats(),
        patientApi.listPatients({ page: 1, pageSize: 5, visitStatus: 0 })
      ])
      const todoPatients = sortTodoPatients(patientResult?.list || patientResult?.items || patientResult?.records || [])
      const deviceState = typeof bleManager.snapshot === 'function' ? bleManager.snapshot() : {}
      this.setData({
        loading: false,
        summaryCards: buildSummaryCards(homeStats),
        todoPatients,
        todoTotal: Number(patientResult?.total || todoPatients.length || 0),
        deviceSummary: buildDeviceSummary(deviceState),
        stateMessage: buildStateMessage(this.data.currentPatientId)
      })
    } catch (error) {
      this.setData({
        loading: false,
        error: error?.statusCode === 403 ? '无权查看医生工作台数据' : '医生工作台数据加载失败，请稍后重试'
      })
    }
  },

  onEntrySelect (event) {
    const entry = this.data.entries[event.currentTarget.dataset.index]
    if (!entry || entry.disabled) return
    if (entry.requiresPatientContext && !this.data.currentPatientId) {
      persistPendingDoctorEntry(entry.key)
      wx.navigateTo({ url: '/pages/patient-list/index?selection=1' })
      return
    }
    persistPendingDoctorEntry('')
    persistTransientPatientContext(entry.requiresPatientContext ? this.data.currentPatientId : '')
    const url = buildEntryUrl(entry, this.data.currentPatientId)
    if (!url) return
    if (TAB_BAR_URLS.has(url)) {
      wx.switchTab({ url })
      return
    }
    wx.navigateTo({ url })
  },

  onEntrySelectByKey (event) {
    const key = String(event.currentTarget.dataset.index || event.currentTarget.dataset.key || '').trim()
    const index = this.data.entries.findIndex(item => item.key === key)
    if (index < 0) return
    this.onEntrySelect({ currentTarget: { dataset: { index } } })
  },

  onTodoPatientSelect (event) {
    const index = Number(event.currentTarget.dataset.index)
    const patient = this.data.todoPatients[index]
    if (!patient?.id) return
    persistTransientPatientContext(patient.id)
    wx.navigateTo({ url: '/pages/patient-detail/index' })
  },

  onTodoFollowup (event) {
    const index = Number(event.currentTarget.dataset.index)
    const patient = this.data.todoPatients[index]
    if (!patient?.id) return
    persistTransientPatientContext(patient.id)
    wx.navigateTo({ url: '/pages/followups/detail' })
  },

  openDevice () {
    wx.switchTab({ url: '/pages/device/device' })
  },

  backHome () {
    wx.switchTab({ url: '/pages/home/home' })
  },

  retry () {
    return this.ensureDoctor()
  },

  logout () {
    wx.showModal({
      title: '退出登录',
      content: '退出后需要重新登录，当前设备连接会断开。',
      confirmText: '退出',
      confirmColor: '#0c9b6c',
      success: async result => {
        if (!result.confirm) return
        try {
          await api.logout()
        } catch (error) {
          console.warn('[CDMS] logout request failed', error)
        }
        try {
          await bleManager.unbind()
        } catch (error) {
          console.warn('[CDMS BLE] disconnect on logout failed', error)
        }
        getApp().clearAuth()
        wx.reLaunch({ url: '/pages/auth/login' })
      }
    })
  }
})

module.exports = {
  DOCTOR_ENTRY_ROUTES,
  buildEntryUrl,
  buildStateMessage,
  buildStats,
  buildSummaryCards,
  buildDeviceSummary,
  buildActionGroups,
  normalizeTodoPatient,
  sortTodoPatients,
  normalizeEntries,
  persistPendingDoctorEntry,
  persistTransientPatientContext,
  resolveCurrentPatientId,
  PATIENT_SCOPED_ENTRY_ROUTES
}
