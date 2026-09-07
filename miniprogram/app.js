const bleManager = require('./services/bleManager')
const runtimeConfig = require('./config/runtime')

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
    this.restoreAuth()
    this.applyBridgeQuery(options?.query)
    this.initCloud()
    bleManager.init().catch(error => console.warn('[CDMS BLE] adapter init failed', error))
  },

  // 云开发只服务于遗留 quickstart 模板；CDMS/IoT 链路走 HTTPS，不依赖云环境。
  // 当前 appid 未绑定云环境或开发者工具身份上下文缺失时，静默跳过，不阻塞启动。
  initCloud () {
    if (typeof wx === 'undefined' || !wx.cloud) {
      console.warn('[CDMS Cloud] wx.cloud unavailable; continuing with IoT API mode')
      return
    }
    if (!this.globalData.cloudEnv) {
      console.warn('[CDMS Cloud] cloudEnv not configured; skip cloud init')
      return
    }
    try {
      wx.cloud.init({ traceUser: true, env: this.globalData.cloudEnv })
    } catch (error) {
      console.warn('[CDMS Cloud] cloud init failed; continuing with IoT API mode', error)
    }
  },
  onShow (options) {
    this.applyBridgeQuery(options?.query)
  },
  applyBridgeQuery (query = {}) {
    const keys = ['iotBaseUrl', 'managerBaseUrl', 'cdmsBaseUrl', 'cloudEnv', 'wearableToken', 'wearableSessionId', 'patientRef', 'handoffCode', 'mode', 'taskId']
    const decode = value => {
      try { return /%3A|%2F|%25/.test(value) ? decodeURIComponent(value) : value } catch (_) { return value }
    }
    keys.forEach(key => {
      if (query[key] != null && query[key] !== '') this.globalData[key] = decode(query[key])
    })
    if (query.patientId && !this.globalData.patientRef) this.globalData.patientRef = query.patientId
  },

  restoreAuth () {
    const auth = wx.getStorageSync('cdms.miniapp.auth') || {}
    Object.assign(this.globalData, auth)
    const wearable = wx.getStorageSync('cdms.miniapp.wearable') || {}
    const authPatientRef = String(auth.patientRef || '').trim()
    const wearablePatientRef = String(wearable.patientRef || '').trim()
    const hasAuth = !!String(auth.accessToken || '').trim()
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
  },

  saveAuth (session) {
    const activeRole = session.activeRole || ''
    const selectedRole = (session.roles || []).find(role => role.roleType === activeRole)
    const nextPatientRef = activeRole === 'PATIENT'
      ? String(selectedRole?.patientId || selectedRole?.principalId || '')
      : ''
    // Task B：identityId 是身份切换识别的锚点。token 刷新等场景的会话可能不含 identityId，
    // 此时保留既有身份标记，避免误判为切换；登录/换账号时 session.identityId 一定存在并会覆盖。
    const nextIdentityId = String(session.identityId || '').trim() || String(this.globalData.identityId || '').trim()
    const identityChanged = !!nextIdentityId
      && (String(this.globalData.identityId || '') !== nextIdentityId
        || this.globalData.activeRole !== activeRole
        || String(this.globalData.patientRef || '') !== nextPatientRef)
    const auth = {
      cdmsBaseUrl: this.globalData.cdmsBaseUrl,
      accessToken: session.token || '',
      refreshToken: session.refreshToken || '',
      identityId: nextIdentityId,
      activeRole,
      roles: session.roles || [],
      patientRef: nextPatientRef
    }
    Object.assign(this.globalData, auth)
    wx.setStorageSync('cdms.miniapp.auth', auth)
    if (identityChanged) {
      console.info('[CDMS] 登录身份切换，按绑定归属刷新设备展示（不删除绑定历史）', {
        fromPatientRef: String(this.globalData.patientRef || ''),
      })
    }
    // Task A/B：身份/角色/患者切换后不再执行 unbind（unbind 会删除绑定历史），
    // 改为按绑定归属 ownerPatientRef 与当前 patientRef 比对：
    // 异患者绑定自动隐藏（foreignDevice）且不删除，登录本人账号后自动恢复。
    // 每次登录都检查一次，同时覆盖"退出后换账号冷启动再登录"（identityId 已被清空的场景）。
    if (bleManager && typeof bleManager.refreshBoundDeviceOwnership === 'function') {
      bleManager.refreshBoundDeviceOwnership().catch(error =>
        console.warn('[CDMS BLE] 登录后设备归属检查失败', error && error.message ? error.message : error))
    }
  },

  clearAuth () {
    wx.removeStorageSync('cdms.miniapp.auth')
    wx.removeStorageSync('cdms.miniapp.wearable')
    this.globalData.accessToken = ''
    this.globalData.refreshToken = ''
    // Task B：保留 identityId，作为"退出登录后换账号再登录"的切换识别依据
    // （saveAuth 的 identityChanged 依赖它；清空会导致该保护失效）。
    // patientRef / activeRole 仍需清空：新账号登录后会在 saveAuth 中重设。
    this.globalData.activeRole = ''
    this.globalData.roles = []
    this.globalData.wearableToken = ''
    this.globalData.wearableSessionId = ''
    this.globalData.wearableDeviceRef = ''
    this.globalData.patientRef = ''
  }
})