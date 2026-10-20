const sessionStore = require('../../utils/session-store')
const { purgeSession } = require('../../utils/auth-guard')

// H5 侧约定的 handoff 失败信号：postMessage({ type }) 或 URL query 里的标记。
const HANDOFF_FAIL_TYPES = [
  'cdms:handoff-failed',
  'cdms-handoff-failed',
  'handoff-failed',
  'handoff_failed'
]
// 普通业务 postMessage（如 height）不匹配上面的失败信令，因此不会误伤。
const FAIL_QUERY_KEYS = ['cdmsHandoffFailed', 'cdms_handoff_failed', 'handoffFailed']
const LOGIN_URL = '/pages/auth/login'

// 读取当前会话 token（用于 onShow 判断 H5 里那份 handoff 是否已随会话变化而失效）。
function readAccessToken () {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    return String((app && app.globalData && app.globalData.accessToken) || '')
  } catch (_) {
    return ''
  }
}

function isFailType (value) {
  const type = String(value || '')
  return HANDOFF_FAIL_TYPES.indexOf(type) >= 0
}

// 从一条 postMessage 数据里判定是否为 handoff 失败信令。
// web-view 的 e.detail.data 是 H5 wx.miniProgram.postMessage 上报的对象数组。
function detectFailurePayload (data) {
  if (!data) return false
  if (Array.isArray(data)) return data.some(detectFailurePayload)
  if (typeof data !== 'object') return false
  if (isFailType(data.type) || isFailType(data.event) || isFailType(data.action)) return true
  if (data.type === 'cdms:session-expired' || data.type === 'cdms-session-expired') return true
  return false
}

// 从 URL 兜底解析失败标记（H5 无法调用 postMessage 时用重定向携带 query）。
// 同时检查 ?search 与 #hash，因为 Vue Router 的 hash 模式把 query 放在 #/...?x=y。
function detectFailureUrl (url) {
  const src = String(url || '')
  if (!src) return false
  return FAIL_QUERY_KEYS.some(key => {
    const re = new RegExp('[?&]' + key + '(=|&|#|$)', 'i')
    return re.test(src)
  })
}

Page({
  data: { src: '', recovering: false },

  onLoad (query) {
    this._recovered = false
    this._returning = false
    // 进入 H5 时记下当时的 token，onShow 用它判断会话是否已变化（见 onShow）。
    this._handoffToken = readAccessToken()
    if (!query?.url) { wx.showToast({ title: '缺少 H5 地址', icon: 'none' }); return }
    let decoded = ''
    try {
      decoded = decodeURIComponent(query.url)
    } catch (_) {
      wx.showToast({ title: 'H5 地址无效', icon: 'none' })
      return
    }
    this.setData({ src: decoded })
    // URL 约定兜底：进入即带失败标记时直接走恢复流程，不停在死路上。
    if (detectFailureUrl(decoded)) {
      this.recoverFromHandoffFailure()
    }
  },

  // 2026-10-20：H5 侧会话/token 一旦变化，web-view 里那份 handoff 已失效，用户只会对着死页面。
  // 约束不变：**不改 web-view src**（src 变化会整页重载、丢内存 token）。
  // 这里在 onShow 检测 token 变化 → 退回宿主首页，由用户点「进入工作台」重新 createHandoff。
  onShow () {
    const current = readAccessToken()
    if (!this._handoffToken) { this._handoffToken = current; return }
    if (current === this._handoffToken) return
    this.returnToHost()
  },

  // 退回宿主上一页（home）：置 returnedFromExpired 标记，home.onLoad/onShow 见标记不再自动进 H5，
  // 避免「过期页 → 首页 → 自动进 H5」的死循环。navigateBack 不可用时降级 reLaunch 登录页。
  returnToHost () {
    if (this._returning) return
    this._returning = true
    try {
      const app = typeof getApp === 'function' ? getApp() : null
      if (app && app.globalData) app.globalData.returnedFromExpired = true
    } catch (_) { /* best-effort */ }
    try {
      wx.navigateBack({
        delta: 1,
        fail: () => {
          this._returning = false
          try { wx.reLaunch({ url: LOGIN_URL }) } catch (_) { /* best-effort */ }
        }
      })
    } catch (_) {
      this._returning = false
      try { wx.reLaunch({ url: LOGIN_URL }) } catch (_) { /* best-effort */ }
    }
  },

  // §8.2：web-view 监听 H5 侧 handoff 失败消息（postMessage）。
  onWebViewMessage (event) {
    const messages = event && event.detail ? event.detail.data : null
    if (detectFailurePayload(messages)) this.recoverFromHandoffFailure()
  },

  recoverFromHandoffFailure () {
    // 单次加载只恢复一次，避免 navigateBack 失败后反复触发。
    if (this._recovered) return
    this._recovered = true
    this.setData({ recovering: true })
    // 先整体清空会话对象（含一次性 handoff code），杜绝兑换失败后循环重试同一 code（§6.3 / §8.2）。
    try { purgeSession(typeof getApp === 'function' ? getApp() : null) } catch (_) { /* best-effort */ }
    try { sessionStore.clearSession() } catch (_) { /* best-effort */ }

    const fallbackToLogin = () => {
      wx.reLaunch({ url: LOGIN_URL, fail: () => { this.setData({ recovering: false }) } })
    }

    let navigated = false
    try {
      wx.navigateBack({
        delta: 1,
        success: () => { navigated = true },
        fail: () => { if (!navigated) fallbackToLogin() }
      })
    } catch (_) {
      fallbackToLogin()
      return
    }
    // 兜底：某些环境下 navigateBack 既不 success 也不 fail（无上一页栈），超时转 reLaunch。
    setTimeout(() => { if (!navigated) fallbackToLogin() }, 400)
  }
  // 注意：不再在 onShow 改写 web-view src。web-view 的 src 一旦变化会整页重载，
  // 导致 H5 内存 token 丢失、返回时跳登录。保持 src 不变，返回只恢复已有页面状态。
})