// 会话存储（审计整改 §6.3）：以【一个原子对象】保存小程序侧全部会话状态。
//
//   principalId / activeRole / orgId / patientId
//   accessToken / refreshToken / tokenVersion
//   handoffSession / wearableSession / issuedAt
//
// 登录、角色切换、退出、401 一律整体替换或整体清空，不再零散写多个键。
// 旧版本把会话拆在 'cdms.miniapp.auth' / 'cdms.miniapp.wearable' 等分散键里，
// 读到时自动迁移进新对象并删除旧键（向后兼容）。
//
// 本模块只依赖 wx.*StorageSync，不 require 任何页面/服务模块，保持可单测。

const SESSION_KEY = 'cdms.miniapp.session.v1'
const LEGACY_AUTH_KEY = 'cdms.miniapp.auth'
const LEGACY_WEARABLE_KEY = 'cdms.miniapp.wearable'

function text (value) {
  if (value == null) return ''
  const trimmed = String(value).trim()
  return trimmed
}

function numberOrNull (value) {
  if (value === '' || value == null) return null
  const n = Number(value)
  return Number.isFinite(n) ? n : null
}

function normalizeRole (role) {
  if (!role || typeof role !== 'object') return role
  const normalized = Object.assign({}, role)
  const stringKeys = ['id', 'identityId', 'patientId', 'principalId', 'orgId']
  stringKeys.forEach(key => {
    if (normalized[key] != null) normalized[key] = String(normalized[key])
  })
  return normalized
}

// 从后端 session 推导 principalId / patientId（患者角色下的档案号）。
function derivePrincipal (session, roles) {
  let principalId = text(session.principalId || session.identityId || session.id)
  let patientId = text(session.patientId)
  const activeRole = text(session.activeRole)
  if (!patientId || !principalId) {
    for (let i = 0; i < roles.length; i += 1) {
      const role = roles[i]
      if (!role || typeof role !== 'object') continue
      if (activeRole && role.roleType && role.roleType !== activeRole) continue
      if (!patientId) patientId = text(role.patientId)
      if (!principalId) principalId = text(role.principalId || role.id || role.identityId)
      if (patientId && principalId) break
    }
  }
  return { principalId, patientId }
}

// 把任意来源（登录响应 / 刷新响应 / 旧快照）规整成完整会话对象。
// patch 覆盖 existing；两者都没有 refreshToken 时返回 null（视为无会话）。
function normalizeSession (patch, existing) {
  const source = existing || {}
  const base = Object.assign({}, source, patch || {})

  const refreshToken = text(base.refreshToken)
  if (!refreshToken) return null

  const rawRoles = Array.isArray(base.roles) ? base.roles.map(normalizeRole) : []
  const derived = derivePrincipal(base, rawRoles)

  const wearable = base.wearableSession && typeof base.wearableSession === 'object' ? base.wearableSession : {}
  const handoff = base.handoffSession && typeof base.handoffSession === 'object' ? base.handoffSession : {}

  return {
    version: 1,
    principalId: derived.principalId,
    identityId: text(base.identityId),
    activeRole: text(base.activeRole),
    orgId: text(base.orgId),
    patientId: derived.patientId,
    accessToken: text(base.accessToken),
    refreshToken,
    tokenVersion: numberOrNull(base.tokenVersion),
    handoffSession: {
      code: text(handoff.code),
      url: text(handoff.url),
      targetPath: text(handoff.targetPath),
      issuedAt: numberOrNull(handoff.issuedAt)
    },
    wearableSession: {
      iotBaseUrl: text(wearable.iotBaseUrl),
      wearableToken: text(wearable.wearableToken || wearable.uploadToken),
      wearableSessionId: text(wearable.wearableSessionId || wearable.sessionId),
      deviceRef: text(wearable.deviceRef || wearable.wearableDeviceRef),
      patientId: text(wearable.patientId || wearable.patientRef)
    },
    roles: rawRoles,
    cdmsBaseUrl: text(base.cdmsBaseUrl),
    orgName: text(base.orgName),
    patientRef: text(base.patientRef || derived.patientId),
    issuedAt: numberOrNull(base.issuedAt) || Date.now()
  }
}

function readRaw (key) {
  try {
    return (typeof wx !== 'undefined' && wx.getStorageSync) ? (wx.getStorageSync(key) || null) : null
  } catch (_) {
    return null
  }
}

function removeLegacy (key) {
  try {
    if (typeof wx !== 'undefined' && wx.removeStorageSync) wx.removeStorageSync(key)
  } catch (_) {
    // 单测环境可能没有 storage；内存里的权威副本仍然正确。
  }
}

// 旧分散键 → 新原子对象的字段迁移（§6.3 向后兼容）。
function migrateLegacy () {
  const legacyAuth = readRaw(LEGACY_AUTH_KEY)
  if (!legacyAuth || typeof legacyAuth !== 'object') return null
  const legacyWearable = readRaw(LEGACY_WEARABLE_KEY)
  const merged = Object.assign({}, legacyAuth)
  if (legacyWearable && typeof legacyWearable === 'object') {
    merged.wearableSession = {
      iotBaseUrl: legacyWearable.iotBaseUrl || '',
      wearableToken: legacyWearable.wearableToken || '',
      wearableSessionId: legacyWearable.wearableSessionId || '',
      deviceRef: legacyWearable.wearableDeviceRef || legacyWearable.deviceRef || '',
      patientId: legacyWearable.patientRef || ''
    }
  }
  return normalizeSession(merged, null)
}

// 读取当前会话；若只有旧分散键则迁移进新对象并删除旧键。
function readSession () {
  const stored = readRaw(SESSION_KEY)
  if (stored && typeof stored === 'object' && text(stored.refreshToken)) {
    const session = normalizeSession(stored, null)
    // 迁移期间：新对象尚未定型而旧键仍在时，合并并清理一次。
    if (!session || !text(session.patientId)) {
      const migrated = migrateLegacy()
      if (migrated) {
        const next = normalizeSession({}, session) || session
        removeLegacy(LEGACY_AUTH_KEY)
        removeLegacy(LEGACY_WEARABLE_KEY)
        writeSession(next)
        return next
      }
    }
    return session
  }
  const migrated = migrateLegacy()
  if (migrated) {
    removeLegacy(LEGACY_AUTH_KEY)
    removeLegacy(LEGACY_WEARABLE_KEY)
    writeSession(migrated)
    return migrated
  }
  return null
}

// 整体替换会话对象（登录 / 角色切换 / 刷新成功）。
function writeSession (patch, existing) {
  const base = existing || readSession()
  const session = normalizeSession(patch || {}, base)
  if (!session) {
    clearSession()
    return null
  }
  try {
    if (typeof wx !== 'undefined' && wx.setStorageSync) wx.setStorageSync(SESSION_KEY, session)
  } catch (_) {
    // storage 不可用时内存副本仍可用。
  }
  // 收敛完成：确保不再残留旧分散键。
  removeLegacy(LEGACY_AUTH_KEY)
  removeLegacy(LEGACY_WEARABLE_KEY)
  return session
}

// 整体清空会话对象（退出 / 401）。
function clearSession () {
  removeLegacy(SESSION_KEY)
  removeLegacy(LEGACY_AUTH_KEY)
  removeLegacy(LEGACY_WEARABLE_KEY)
  return null
}

// —— 向后兼容旧导出名（readAuth/writeAuth/clearAuth/normalizeAuth）——

function toLegacyAuth (session) {
  if (!session) return null
  return {
    refreshToken: session.refreshToken,
    identityId: session.identityId || session.principalId,
    activeRole: session.activeRole,
    roles: session.roles,
    orgId: session.orgId,
    orgName: session.orgName,
    patientRef: session.patientRef,
    cdmsBaseUrl: session.cdmsBaseUrl
  }
}

function readAuth () {
  return toLegacyAuth(readSession())
}

function writeAuth (snapshot) {
  const session = writeSession(snapshot, null)
  if (!session) clearSession()
  return session
}

function clearAuth () {
  return clearSession()
}

function normalizeAuth (snapshot) {
  return toLegacyAuth(normalizeSession(snapshot, null))
}

module.exports = {
  SESSION_KEY,
  LEGACY_AUTH_KEY,
  LEGACY_WEARABLE_KEY,
  readSession,
  writeSession,
  clearSession,
  normalizeSession,
  // 兼容别名
  readAuth,
  writeAuth,
  clearAuth,
  normalizeAuth
}