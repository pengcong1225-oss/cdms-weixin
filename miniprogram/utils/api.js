const queueKey = 'cdms.iot.wearable.upload.queue'

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
        if (res.statusCode >= 200 && res.statusCode < 300) {
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
  const baseUrl = cdmsBaseUrl()
  if (!baseUrl) return Promise.reject(new Error('未配置 CDMS 服务地址'))
  return request(`${baseUrl}${path}`, method, data, token)
}

async function login (phone, password, wxCode) {
  return cdmsRequest('/api/v1/miniapp/auth/login', 'POST', { phone, password, wxCode }, '')
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

module.exports = { enqueue, flushQueue, exchangeHandoff, readQueue, queueStorageKey, request, login, loginWithWechat, logout, switchRole, createHandoff, redeemHandoff, createPatientWearableSession, releasePatientWearableSession }
