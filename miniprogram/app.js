const bleManager = require('./services/bleManager')
const runtimeConfig = require('./config/runtime')
const sessionStore = require('./utils/session-store')

let configuredCloudEnv = ''
try {
  const envConfig = require('./envList')
  configuredCloudEnv = envConfig?.envList?.[0]?.envId || ''
} catch (error) {
  // Standalone builds may not include the CloudBase template helper.
}

App({
  globalData: {
    // 由部署环境注入；不要提交生产 token。
    iotBaseUrl: runtimeConfig.iotBaseUrl,
    managerBaseUrl: runtimeConfig.managerBaseUrl,
    cdmsBaseUrl: runtimeConfig.cdmsBaseUrl,
    accessToken: '',
    refreshToken: '',
    identityId: '',
    activeRole: '',
    roles: [],
    cloudEnv: configuredCloudEnv,
    wearableToken: '',
    wearableSessionId: '',
    wearableDeviceRef: '',
    patientRef: '',
    handoffCode: '',
    mode: 'PATIENT',
    taskId: '',
    bleManager
  },
  onLaunch (options) {
    const snapshot = sessionStore.readAuth()
    this.restoreAuth(snapshot)
    this.applyBridgeQuery(options?.query)
    this.restoreSessionPromise = this.restoreSessionInBackground()
    this.initNativeServices()
  },
  initNativeServices () {
    if (wx.cloud) {
      const cloudOptions = { traceUser: true }
      if (this.globalData.cloudEnv) cloudOptions.env = this.globalData.cloudEnv
      wx.cloud.init(cloudOptions)
    } else {
      console.warn('[CDMS Cloud] wx.cloud unavailable; continuing with IoT API mode')
    }
    try {
      const bleInit = bleManager.init()
      if (bleInit && typeof bleInit.catch === 'function') {
        bleInit.catch(error => console.warn('[CDMS BLE] adapter init failed', error))
      }
    } catch (error) {
      console.warn('[CDMS BLE] adapter init failed', error)
    }
  },
  onShow (options) {
    this.applyBridgeQuery(options?.query)
  },
  applyBridgeQuery (query = {}) {
    const keys = ['iotBaseUrl', 'managerBaseUrl', 'cdmsBaseUrl', 'cloudEnv', 'wearableToken', 'wearableSessionId', 'patientRef', 'handoffCode', 'mode', 'taskId']
    keys.forEach(key => {
      if (query[key] != null && query[key] !== '') this.globalData[key] = query[key]
    })
    if (query.patientId && !this.globalData.patientRef) this.globalData.patientRef = query.patientId
  },

  restoreAuth (snapshot) {
    const auth = snapshot || sessionStore.readAuth() || {}
    if (auth.refreshToken && !auth.cdmsBaseUrl) auth.cdmsBaseUrl = this.globalData.cdmsBaseUrl
    Object.assign(this.globalData, auth)
    const wearable = wx.getStorageSync('cdms.miniapp.wearable') || {}
    const authPatientRef = String(auth.patientRef || '').trim()
    const wearablePatientRef = String(wearable.patientRef || '').trim()
    const hasAuth = !!String(auth.refreshToken || '').trim()
    const samePatient = authPatientRef && wearablePatientRef && authPatientRef === wearablePatientRef
    const wearableUsable = !hasAuth || (auth.activeRole === 'PATIENT' && samePatient)
    if (wearableUsable) {
      Object.assign(this.globalData, wearable)
      if (authPatientRef) this.globalData.patientRef = authPatientRef
    } else {
      // 会话只允许在同一患者范围内复用，避免旧账号的 IoT token 污染当前患者。
      wx.removeStorageSync('cdms.miniapp.wearable')
      this.globalData.wearableToken = ''
      this.globalData.wearableSessionId = ''
      this.globalData.wearableDeviceRef = ''
      if (authPatientRef) this.globalData.patientRef = authPatientRef
    }
    return sessionStore.normalizeAuth(auth)
  },

  restoreSessionInBackground () {
    if (!this.globalData.refreshToken || !this.globalData.cdmsBaseUrl) return Promise.resolve(null)
    const api = require('./utils/api')
    return api.refreshAccessToken().catch(error => {
      if (error && error.reauthRequired) {
        this.clearAuth()
        wx.reLaunch({ url: '/pages/auth/login' })
      } else {
        console.warn('[CDMS Auth] silent refresh failed; keeping persisted session', error)
      }
      return null
    })
  },

  saveAuth (session) {
    const activeRole = session.activeRole || ''
    const selectedRole = (session.roles || []).find(role => role.roleType === activeRole)
    const nextPatientRef = activeRole === 'PATIENT'
      ? String(selectedRole?.patientId || selectedRole?.principalId || '')
      : ''
    const identityChanged = this.globalData.identityId
      && (String(this.globalData.identityId) !== String(session.identityId || '')
        || this.globalData.activeRole !== activeRole
        || String(this.globalData.patientRef || '') !== nextPatientRef)
    if (identityChanged) {
      // 角色或患者切换时释放旧的设备会话，避免新患者复用旧患者的 IoT token。
      bleManager.unbind().catch(error => console.warn('[CDMS BLE] identity switch cleanup failed', error))
      this.clearRoleContext()
    }
    const auth = {
      cdmsBaseUrl: session.cdmsBaseUrl || this.globalData.cdmsBaseUrl || runtimeConfig.cdmsBaseUrl,
      refreshToken: session.refreshToken || '',
      identityId: session.identityId || '',
      activeRole,
      roles: session.roles || [],
      patientRef: nextPatientRef
    }
    Object.assign(this.globalData, auth)
    this.globalData.accessToken = session.token || ''
    sessionStore.writeAuth(auth)
  },

  clearRoleContext () {
    wx.removeStorageSync('cdms.miniapp.wearable')
    this.globalData.patientRef = ''
    this.globalData.taskId = ''
    this.globalData.wearableToken = ''
    this.globalData.wearableSessionId = ''
    this.globalData.wearableDeviceRef = ''
    this.globalData.deviceRef = ''
  },

  clearAuth () {
    sessionStore.clearAuth()
    this.clearRoleContext()
    this.globalData.accessToken = ''
    this.globalData.refreshToken = ''
    this.globalData.identityId = ''
    this.globalData.activeRole = ''
    this.globalData.roles = []
  }
})
