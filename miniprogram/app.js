const bleManager = require('./services/bleManager')
const runtimeConfig = require('./config/runtime')
const sessionStore = require('./utils/session-store')

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
    bleManager.init().catch(error => console.warn('[CDMS BLE] adapter init failed', error))
  },

  onShow (options) {
    this.applyBridgeQuery(options?.query)
  },
  applyBridgeQuery (query = {}) {
    const keys = ['iotBaseUrl', 'managerBaseUrl', 'cdmsBaseUrl', 'wearableToken', 'wearableSessionId', 'patientRef', 'handoffCode', 'mode', 'taskId']
    const decode = value => {
      try { return /%3A|%2F|%25/.test(value) ? decodeURIComponent(value) : value } catch (_) { return value }
    }
    keys.forEach(key => {
      if (query[key] != null && query[key] !== '') this.globalData[key] = decode(query[key])
    })
    if (query.patientId && !this.globalData.patientRef) this.globalData.patientRef = query.patientId
  },

  // 把原子会话对象展开进 globalData（运行时消费者仍读扁平字段）。§6.3
  applySession (session) {
    if (!session) return
    this.globalData.accessToken = session.accessToken || ''
    this.globalData.refreshToken = session.refreshToken || ''
    this.globalData.identityId = session.identityId || session.principalId || ''
    this.globalData.principalId = session.principalId || ''
    this.globalData.tokenVersion = session.tokenVersion
    this.globalData.activeRole = session.activeRole || ''
    this.globalData.roles = Array.isArray(session.roles) ? session.roles : []
    this.globalData.orgId = session.orgId || ''
    this.globalData.orgName = session.orgName || ''
    if (session.cdmsBaseUrl) this.globalData.cdmsBaseUrl = session.cdmsBaseUrl
    this.globalData.patientId = session.patientId || ''
    this.globalData.patientRef = session.patientRef || session.patientId || ''
    const handoff = session.handoffSession || {}
    this.globalData.handoffCode = handoff.code || ''
    const wearable = session.wearableSession || {}
    this.globalData.iotBaseUrl = wearable.iotBaseUrl || this.globalData.iotBaseUrl
    this.globalData.wearableToken = wearable.wearableToken || ''
    this.globalData.wearableSessionId = wearable.wearableSessionId || ''
    this.globalData.wearableDeviceRef = wearable.deviceRef || ''
  },

  restoreAuth () {
    // §6.3：读取唯一原子会话对象；若只有旧分散键则迁移并删除旧键。
    const session = sessionStore.readSession()
    if (!session) {
      sessionStore.clearSession()
      return
    }
    this.applySession(session)
    // 穿戴 / handoff 临时会话只在同一 PATIENT 作用域内复用（§6.2 第 5 步）。
    const patientAuthed = !!this.globalData.accessToken && this.globalData.activeRole === 'PATIENT'
    const wearablePatient = String(session.wearableSession && session.wearableSession.patientId || '').trim()
    const currentPatient = String(this.globalData.patientRef || '').trim()
    const wearableUsable = !patientAuthed
      || (this.globalData.activeRole === 'PATIENT' && !!currentPatient && wearablePatient === currentPatient)
    if (!wearableUsable) {
      this.globalData.wearableToken = ''
      this.globalData.wearableSessionId = ''
      this.globalData.wearableDeviceRef = ''
      const next = sessionStore.normalizeSession({ wearableSession: {} }, session)
      if (next) sessionStore.writeSession(next, next)
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
    const prevActiveRole = String(this.globalData.activeRole || '')
    const identityChanged = !!nextIdentityId
      && (String(this.globalData.identityId || '') !== nextIdentityId
        || this.globalData.activeRole !== activeRole
        || String(this.globalData.patientRef || '') !== nextPatientRef
        // 角色在 PATIENT↔DOCTOR 之间变化也算作用域切换（患者↔医生），
        // 与 patientRef 是否变化无关——否则同账号往返切换会漏清旧 handoff/穿戴会话。
        || (!!prevActiveRole && prevActiveRole !== activeRole))
    // §6.3：整体替换唯一原子会话对象（不再零散写 cdms.miniapp.auth）。
    // §6.2/§6.3：角色或身份一旦变化，立即作废旧角色的 handoff / 穿戴临时会话与 patientId——
    // 不保留旧患者、旧穿戴 token、旧 handoff code。
    const discardScoped = identityChanged
    const patch = {
      cdmsBaseUrl: this.globalData.cdmsBaseUrl,
      accessToken: session.token || '',
      refreshToken: session.refreshToken || '',
      identityId: nextIdentityId,
      principalId: session.principalId || nextIdentityId,
      orgId: session.orgId != null ? session.orgId : this.globalData.orgId,
      orgName: session.orgName != null ? session.orgName : this.globalData.orgName,
      tokenVersion: session.tokenVersion != null ? session.tokenVersion : this.globalData.tokenVersion,
      activeRole,
      roles: session.roles || [],
      patientRef: nextPatientRef
    }
    if (discardScoped) {
      // §6.3：切换后不得保留旧角色的 patientId / 穿戴 token / handoff code。
      patch.handoffSession = {}
      patch.wearableSession = {}
      patch.patientId = ''
      patch.patientRef = nextPatientRef
    } else {
      if (session.wearableSession) patch.wearableSession = session.wearableSession
      if (session.handoffSession) patch.handoffSession = session.handoffSession
    }
    const next = sessionStore.writeSession(patch, null)
    this.applySession(next || patch)
    if (!next) {
      // normalizeSession 返回空（缺 refreshToken）：退回到直接写入以兼容仅令牌的测试夹具。
      this.globalData.accessToken = patch.accessToken
      this.globalData.refreshToken = patch.refreshToken
    }
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
    // §6.3：整体清空完整会话对象（含旧分散键），而非只删单个 token。
    sessionStore.clearSession()
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
    this.globalData.patientId = ''
    this.globalData.patientRef = ''
    this.globalData.handoffCode = ''
    this.globalData.tokenVersion = null
  }
})