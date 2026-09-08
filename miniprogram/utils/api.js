const queueKey = 'cdms.iot.wearable.upload.queue'
let refreshPromise = null

function queueStorageKey (scope) {
  const safeScope = String(scope || 'anonymous').replace(/[^A-Za-z0-9_.-]/g, '_')
  return `${queueKey}.${safeScope}`
}

function currentScope () {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    return app?.globalData?.patientRef || app?.globalData?.mode || 'anonymous'
  } catch (_) { return 'anonymous' }
}

function readQueue (scope = currentScope()) {
  const queue = wx.getStorageSync(queueStorageKey(scope)) || []
  if (queue.length <= 1) return queue
  const latest = queue.slice(-1)
  writeQueue(latest, scope)
  return latest
}
function writeQueue (queue, scope = currentScope()) { wx.setStorageSync(queueStorageKey(scope), queue.slice(-1000)) }

function request (url, method, data, token) {
  return new Promise((resolve, reject) => {
    const header = token ? { Authorization: `Bearer ${token}` } : {}
    wx.request({ url, method, data, header,
      success: res => {
        if (res.statusCode >= 200 && res.statusCode < 300 && res.data?.code !== 401) {
          resolve(res.data)
          return
        }
        const error = new Error(`HTTP ${res.statusCode}`)
        error.statusCode = res.statusCode
        error.response = res.data
        if (res.data?.code) error.code = res.data.code
        reject(error)
      },
      fail: reject })
  })
}

function cdmsBaseUrl () {
  try { return getApp()?.globalData?.cdmsBaseUrl || '' } catch (_) { return '' }
}

function cdmsRequest (path, method, data, token) {
  return cdmsRequestWithRetry(path, method, data, token, true)
}

async function cdmsRequestWithRetry (path, method, data, token, allowRefresh) {
  const baseUrl = cdmsBaseUrl()
  if (!baseUrl) return Promise.reject(new Error('未配置 CDMS 服务地址'))
  try {
    return await request(`${baseUrl}${path}`, method, data, token)
  } catch (error) {
    const app = getApp()
    const isAuthEndpoint = path.includes('/auth/login') || path.includes('/auth/refresh')
      || path.includes('/handoff/redeem')
    if (!allowRefresh || !token || error?.statusCode !== 401 || isAuthEndpoint
      || !app?.globalData?.refreshToken) throw error
    try {
      const nextToken = await refreshAccessToken()
      return request(`${baseUrl}${path}`, method, data, nextToken)
    } catch (refreshError) {
      // §6.3：刷新失败（含角色切换后旧版本 token 失效）→ 清空【完整会话对象】，
      // 而不是只删除单个 token。app.clearAuth 现委托 session-store 整体清空。
      if (typeof app.clearAuth === 'function') app.clearAuth()
      else { try { require('./auth-guard').purgeSession(app) } catch (_) { /* noop */ } }
      throw refreshError
    }
  }
}

function refreshAccessToken () {
  const app = getApp()
  if (!app?.globalData?.refreshToken) return Promise.reject(new Error('Refresh Token 缺失'))
  if (!refreshPromise) {
    const baseUrl = cdmsBaseUrl()
    refreshPromise = request(`${baseUrl}/api/v1/miniapp/auth/refresh`, 'POST', {
      refreshToken: app.globalData.refreshToken
    }, '').then(response => {
      const session = response?.data || response
      if (!session?.token || !session?.refreshToken) throw new Error('Refresh Token 响应无效')
      if (typeof app.saveAuth === 'function') app.saveAuth(session)
      return session.token
    }).finally(() => { refreshPromise = null })
  }
  return refreshPromise
}

async function login (phone, password, wxCode) {
  return cdmsRequest('/api/v1/miniapp/auth/login', 'POST', { phone, password, wxCode }, '')
}

function loginDoctor ({ baseUrl, username, password }) {
  const targetBaseUrl = baseUrl || cdmsBaseUrl()
  const account = String(username || '').trim()
  if (!targetBaseUrl || !account || !String(password || '')) {
    return Promise.reject(new Error('请输入医生账号和密码'))
  }
  return request(`${targetBaseUrl}/api/v1/miniapp/auth/doctor-login`, 'POST', {
    username: account,
    password: String(password)
  }, '')
}

function loginWithWechat ({ baseUrl, phone }) {
  return new Promise((resolve, reject) => {
    const targetBaseUrl = baseUrl || cdmsBaseUrl()
    if (!targetBaseUrl || !/^1\d{10}$/.test(String(phone || ''))) {
      reject(new Error('请输入已建档的 11 位手机号'))
      return
    }
    wx.login({
      success: loginResult => {
        if (!loginResult?.code) {
          reject(new Error('微信授权凭证获取失败'))
          return
        }
        request(`${targetBaseUrl}/api/v1/miniapp/auth/login`, 'POST', {
          phone: String(phone).trim(),
          wxCode: loginResult.code
        }, '').then(resolve).catch(reject)
      },
      fail: reject
    })
  })
}

async function logout () {
  const app = getApp()
  if (!app?.globalData?.accessToken) return null
  return cdmsRequest('/api/v1/miniapp/auth/logout', 'POST', {}, app.globalData.accessToken)
}

async function switchRole (roleType) {
  const app = getApp()
  return cdmsRequest('/api/v1/miniapp/auth/switch-role', 'POST', { roleType }, app.globalData.accessToken)
}

async function createHandoff (targetPath) {
  const app = getApp()
  return cdmsRequest('/api/v1/miniapp/auth/handoff', 'POST', { targetPath }, app.globalData.accessToken)
}

async function redeemHandoff (code) {
  return cdmsRequest('/api/v1/miniapp/auth/handoff/redeem', 'POST', { code }, '')
}

async function createPatientWearableSession (deviceRef, sessionId) {
  const app = getApp()
  return cdmsRequest('/api/v1/miniapp/iot/wearable-session', 'POST', { deviceRef, sessionId }, app.globalData.accessToken)
}

async function releasePatientWearableSession (deviceRef) {
  const app = getApp()
  const encodedDeviceRef = encodeURIComponent(String(deviceRef || ''))
  return cdmsRequest(`/api/v1/miniapp/iot/wearable-session?deviceRef=${encodedDeviceRef}`, 'DELETE', null, app.globalData.accessToken)
}

async function listDoctorPatients ({ page = 1, pageSize = 100, keyword = '' } = {}) {
  const app = getApp()
  const query = ['page=' + encodeURIComponent(String(page)), 'pageSize=' + encodeURIComponent(String(pageSize))]
  const kw = String(keyword || '').trim()
  if (kw) query.push('keyword=' + encodeURIComponent(kw))
  return cdmsRequest('/api/v1/patients?' + query.join('&'), 'GET', null, app.globalData.accessToken)
}

async function getDoctorPatient (patientId) {
  const app = getApp()
  return cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId))}`, 'GET', null, app.globalData.accessToken)
}

async function submitScaleMeasurement (payload) {
  const app = getApp()
  return cdmsRequest('/api/v1/miniapp/iot/scale/measurements', 'POST', payload, app.globalData.accessToken)
}

async function flushQueue ({ baseUrl, token, scope }) {
  const queueScope = scope || currentScope()
  const queue = readQueue(queueScope)
  if (!queue.length) return { accepted: 0, duplicates: 0, rejected: 0 }
  const batch = queue[0]
  const result = await request(`${baseUrl}/v1/wearable-upload-batches`, 'POST', batch, token)
  writeQueue(queue.slice(1), queueScope)
  return result
}

async function exchangeHandoff ({ managerBaseUrl, handoffCode, deviceRef }) {
  if (!managerBaseUrl || !handoffCode || !deviceRef) throw new Error('缺少小程序安全启动上下文')
  const result = await request(`${managerBaseUrl}/iot/wearable-handoffs/${encodeURIComponent(handoffCode)}/exchange`, 'POST', { deviceRef }, '')
  return result?.data || result
}

function enqueue (batch) {
  const scope = batch?.patientRef || currentScope()
  writeQueue([batch], scope)
}

module.exports = { enqueue, flushQueue, exchangeHandoff, readQueue, queueStorageKey, request, cdmsRequest, login, loginDoctor, loginWithWechat, logout, switchRole, createHandoff, redeemHandoff, createPatientWearableSession, releasePatientWearableSession, listDoctorPatients, getDoctorPatient, submitScaleMeasurement, refreshAccessToken }