function loginUrl () {
  return '/pages/auth/login'
}

async function ensureSession ({ role, redirect = true } = {}) {
  const app = getApp()
  const auth = app?.globalData || {}
  if (hasUsableSession(auth, role)) return auth
  if (app?.restoreSessionPromise) {
    await app.restoreSessionPromise
    if (hasUsableSession(auth, role)) return auth
  }
  if (!String(auth.accessToken || '').trim() && String(auth.refreshToken || '').trim()) {
    try {
      const api = require('./api')
      await api.refreshAccessToken()
      if (hasUsableSession(auth, role)) return auth
    } catch (error) {
      if (error && error.reauthRequired && typeof app?.clearAuth === 'function') {
        app.clearAuth()
        if (redirect) wx.reLaunch({ url: loginUrl() })
      }
      throw error
    }
  }
  if (redirect) wx.reLaunch({ url: loginUrl() })
  throw new Error(role ? `需要${role}身份登录` : '需要登录')
}

function hasUsableSession (auth, role) {
  const hasSession = !!String(auth.accessToken || '').trim() && !!String(auth.refreshToken || '').trim()
  const hasRole = !role || auth.activeRole === role
  return hasSession && hasRole
}

module.exports = { ensureSession }
