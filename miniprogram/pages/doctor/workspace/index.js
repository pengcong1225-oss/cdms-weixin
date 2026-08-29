const api = require('../../../utils/api')
const bleManager = require('../../../services/bleManager')
const { ensureSession } = require('../../../utils/auth-guard')

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

function buildStateMessage (patientId) {
  if (String(patientId || '').trim()) {
    return '患者管理、随访、监测、消息、统计、报告、体脂秤和设备工作站均可进入；当前患者上下文仅保存在本次小程序内存中，不进入路由地址。'
  }
  return '患者管理、随访、监测、消息、统计、报告、体脂秤和设备工作站均可进入；随访、监测和报告在缺少患者上下文时会提示先选择患者。'
}

Page({
  data: {
    currentPatientId: '',
    stateMessage: buildStateMessage(''),
    stats: buildStats(),
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
        currentPatientId,
        stateMessage: buildStateMessage(currentPatientId),
        stats: buildStats(),
        entries: normalizeEntries()
      })
    } catch (_) {}
  },

  onEntrySelect (event) {
    const entry = this.data.entries[event.currentTarget.dataset.index]
    if (!entry || entry.disabled) return
    persistTransientPatientContext(entry.requiresPatientContext ? this.data.currentPatientId : '')
    const url = buildEntryUrl(entry, this.data.currentPatientId)
    if (!url) return
    wx.navigateTo({ url })
  },

  backHome () {
    wx.switchTab({ url: '/pages/home/home' })
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
  normalizeEntries,
  persistTransientPatientContext,
  resolveCurrentPatientId
}
