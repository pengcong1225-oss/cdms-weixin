const acquisitionApi = require('../../utils/acquisition-api')
const { ensureSession } = require('../../utils/auth-guard')

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function formatDateTime (value) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}

function buildDefaults () {
  const now = Date.now()
  return {
    businessSessionId: `mfa1-${now}`,
    traceId: `mfa1-${now}`,
    expiresInSeconds: 600
  }
}

function toneForStatus (status) {
  const current = String(status || '').toUpperCase()
  if (['COMPLETED', 'COLLECTING', 'PROCESSING'].includes(current)) return 'success'
  if (['FAILED', 'CANCELLED'].includes(current)) return 'danger'
  if (current === 'CONNECTING' || current === 'CREATED') return 'warning'
  return 'neutral'
}

Page({
  data: {
    activeRole: 'DOCTOR',
    loading: false,
    creating: false,
    refreshing: false,
    launching: false,
    cancelling: false,
    errorText: '',
    businessSessionId: '',
    orgId: '',
    patientRef: '',
    traceId: '',
    expiresInSeconds: 600,
    sessionId: '',
    sessionStatus: 'CREATED',
    sessionTone: 'warning',
    captureId: '',
    failureCode: '',
    failureMessage: '',
    sessionExpiresAtText: '-',
    tokenStateText: '未签发',
    tokenExpiresAtText: '-'
  },

  async onLoad (query = {}) {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (session.activeRole !== 'DOCTOR') {
        this.setData({ errorText: '请先使用医生账号登录' })
        return
      }
      const defaults = buildDefaults()
      const app = getApp()
      this.setData({
        activeRole: session.activeRole || 'DOCTOR',
        businessSessionId: valueText(query.businessSessionId, defaults.businessSessionId),
        orgId: valueText(query.orgId, app?.globalData?.orgId || ''),
        patientRef: valueText(query.patientRef || query.patientId, app?.globalData?.patientRef || ''),
        traceId: valueText(query.traceId, defaults.traceId),
        expiresInSeconds: Number(query.expiresInSeconds || defaults.expiresInSeconds)
      })
      if (query.sessionId) {
        this.setData({ sessionId: valueText(query.sessionId) })
        await this.loadSession()
      }
    } catch (error) {
      this.setData({ errorText: error.message || '医生会话校验失败' })
    }
  },

  onUnload () {
    this.clearTransientToken()
  },

  clearTransientToken () {
    this.currentWssToken = ''
    this.currentWssUrl = ''
    this.currentWssExpiresAt = ''
    this.setData({
      tokenStateText: '未签发',
      tokenExpiresAtText: '-'
    })
  },

  collectPayload () {
    const payload = {
      businessSessionId: valueText(this.data.businessSessionId).trim(),
      orgId: valueText(this.data.orgId).trim(),
      patientRef: valueText(this.data.patientRef).trim(),
      deviceType: 'MFA1',
      sourceChannel: 'BLE',
      traceId: valueText(this.data.traceId).trim(),
      expiresInSeconds: Number(this.data.expiresInSeconds || 600)
    }
    if (!payload.businessSessionId) throw new Error('请输入业务会话 ID')
    if (!payload.orgId) throw new Error('请输入机构 ID')
    if (!payload.patientRef) throw new Error('请输入患者编号')
    if (!payload.traceId) throw new Error('请输入追踪 ID')
    return payload
  },

  applySession (session) {
    if (!session) return
    this.setData({
      sessionId: valueText(session.sessionId, this.data.sessionId),
      sessionStatus: valueText(session.status, 'CREATED'),
      sessionTone: toneForStatus(session.status),
      captureId: valueText(session.captureId, ''),
      failureCode: valueText(session.failureCode, ''),
      failureMessage: valueText(session.failureMessage, ''),
      sessionExpiresAtText: formatDateTime(session.expiresAt)
    })
  },

  async createSession () {
    this.clearTransientToken()
    this.setData({ creating: true, errorText: '' })
    try {
      const session = await acquisitionApi.createSession(this.collectPayload())
      this.applySession(session)
      if (session?.sessionId) {
        await this.loadSession(session.sessionId)
      }
    } catch (error) {
      this.setData({ errorText: error.message || '会话创建失败' })
    } finally {
      this.setData({ creating: false })
    }
  },

  async loadSession (sessionId = this.data.sessionId) {
    const targetSessionId = valueText(sessionId).trim()
    if (!targetSessionId) {
      this.setData({ errorText: '请输入会话 ID' })
      return
    }
    this.setData({ refreshing: true, errorText: '' })
    try {
      const session = await acquisitionApi.getSession(targetSessionId)
      this.applySession(session)
    } catch (error) {
      this.setData({ errorText: error.message || '会话加载失败' })
    } finally {
      this.setData({ refreshing: false })
    }
  },

  async launchSession () {
    const sessionId = valueText(this.data.sessionId).trim()
    if (!sessionId) {
      wx.showToast({ title: '请输入会话 ID', icon: 'none' })
      return
    }
    this.setData({ launching: true, errorText: '' })
    try {
      const token = await acquisitionApi.launchSession(sessionId)
      this.currentWssToken = token?.token || ''
      this.currentWssUrl = token?.wssUrl || ''
      this.currentWssExpiresAt = token?.expiresAt || ''
      this.setData({
        tokenStateText: this.currentWssToken ? '已签发' : '未签发',
        tokenExpiresAtText: formatDateTime(this.currentWssExpiresAt)
      })
      await this.loadSession(sessionId)
    } catch (error) {
      this.clearTransientToken()
      this.setData({ errorText: error.message || 'WSS 令牌签发失败' })
    } finally {
      this.setData({ launching: false })
    }
  },

  async retrySession () {
    const sessionId = valueText(this.data.sessionId).trim()
    if (!sessionId) {
      return this.createSession()
    }
    this.clearTransientToken()
    this.setData({ loading: true, errorText: '' })
    try {
      const token = await acquisitionApi.retrySession(sessionId)
      this.currentWssToken = token?.token || ''
      this.currentWssUrl = token?.wssUrl || ''
      this.currentWssExpiresAt = token?.expiresAt || ''
      this.setData({
        tokenStateText: this.currentWssToken ? '已签发' : '未签发',
        tokenExpiresAtText: formatDateTime(this.currentWssExpiresAt)
      })
      await this.loadSession(sessionId)
    } catch (error) {
      this.setData({ errorText: error.message || '会话重试失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async cancelSession () {
    const sessionId = valueText(this.data.sessionId).trim()
    if (!sessionId) {
      wx.showToast({ title: '请输入会话 ID', icon: 'none' })
      return
    }
    this.setData({ cancelling: true, errorText: '' })
    try {
      const session = await acquisitionApi.cancelSession(sessionId)
      this.clearTransientToken()
      this.applySession(session)
    } catch (error) {
      this.setData({ errorText: error.message || '会话取消失败' })
    } finally {
      this.setData({ cancelling: false })
    }
  },

  updateField (event) {
    const field = event.currentTarget.dataset.field
    if (!field) return
    this.setData({ [field]: event.detail.value })
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})

module.exports = { buildDefaults, toneForStatus }
