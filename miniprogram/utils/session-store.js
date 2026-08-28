const authStorageKey = 'cdms.miniapp.auth'

function normalizeRole (role) {
  if (!role || typeof role !== 'object') return role
  const normalized = Object.assign({}, role)
  const stringKeys = ['id', 'identityId', 'patientId', 'principalId', 'orgId']
  stringKeys.forEach(key => {
    if (normalized[key] != null) normalized[key] = String(normalized[key])
  })
  return normalized
}

function normalizeAuth (snapshot = {}) {
  const refreshToken = String(snapshot.refreshToken || '').trim()
  if (!refreshToken) return null
  return {
    refreshToken,
    identityId: snapshot.identityId != null ? String(snapshot.identityId) : '',
    activeRole: snapshot.activeRole || '',
    roles: Array.isArray(snapshot.roles) ? snapshot.roles.map(normalizeRole) : [],
    patientRef: snapshot.patientRef != null ? String(snapshot.patientRef) : '',
    cdmsBaseUrl: snapshot.cdmsBaseUrl || ''
  }
}

function readAuth () {
  const snapshot = wx.getStorageSync(authStorageKey)
  return normalizeAuth(snapshot || {})
}

function writeAuth (snapshot) {
  const auth = normalizeAuth(snapshot)
  if (!auth) {
    clearAuth()
    return
  }
  wx.setStorageSync(authStorageKey, auth)
}

function clearAuth () {
  wx.removeStorageSync(authStorageKey)
}

module.exports = { readAuth, writeAuth, clearAuth, normalizeAuth }
