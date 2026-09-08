const { getRoleEntry } = require('./role-entry')
const sessionStore = require('./session-store')

function loginUrl () {
  return '/pages/auth/login'
}

// §6.3：收到 401（含角色切换后旧版本 token 失效）时清空【完整会话对象】，
// 而不是只删除某一个 token。整体清空 storage 里的原子会话，并把 globalData
// 收敛到未登录态；保留 identityId 作为换账号识别锚点（Task B）。
// 返回登录页地址供调用方跳转；本函数不做跳转，避免在非小程序环境里报错。
function purgeSession (app) {
  const target = app || (typeof getApp === 'function' ? getApp() : null)
  try { sessionStore.clearSession() } catch (_) { /* storage 不可用时仍清内存 */ }
  if (target && target.globalData) {
    const data = target.globalData
    data.accessToken = ''
    data.refreshToken = ''
    data.activeRole = ''
    data.roles = []
    data.wearableToken = ''
    data.wearableSessionId = ''
    data.wearableDeviceRef = ''
    data.patientId = ''
    data.patientRef = ''
    data.handoffCode = ''
    data.tokenVersion = null
    // identityId 保留：见 saveAuth 的 identityChanged 说明。
  }
  return loginUrl()
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
      if (error && error.reauthRequired) {
        purgeSession(app)
        if (redirect && typeof wx !== 'undefined' && wx.reLaunch) wx.reLaunch({ url: loginUrl() })
      }
      throw error
    }
  }
  if (redirect && typeof wx !== 'undefined' && wx.reLaunch) wx.reLaunch({ url: loginUrl() })
  throw new Error(role ? `需要${role}身份登录` : '需要登录')
}

function hasUsableSession (auth, role) {
  const hasSession = !!String(auth.accessToken || '').trim() && !!String(auth.refreshToken || '').trim()
  const hasRole = !role || auth.activeRole === role
  return hasSession && hasRole
}

// §8.2：handoff / H5 会话失效后的宿主恢复落点。
// 优先回到当前 activeRole 的正常入口；无法判定时回小程序登录页，
// 保证小程序内不会停在无法返回宿主的 H5 死路上。
function recoveryTarget (activeRole) {
  const entry = getRoleEntry(activeRole)
  if (entry.type === 'HOME') return '/pages/home/home'
  return loginUrl()
}

module.exports = { ensureSession, purgeSession, recoveryTarget, loginUrl }