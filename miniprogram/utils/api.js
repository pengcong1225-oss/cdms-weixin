const queueKey = 'cdms.iot.wearable.upload.queue'
const queueIndexKey = `${queueKey}.index`
let refreshPromise = null
const flushLocks = new Map()

function safeScopePart (value) {
  // Keep the old spelling for simple identifiers, while encoding separators
  // instead of collapsing distinct patient/device refs (for example `a/b`
  // and `a_b`) onto one storage key.
  return encodeURIComponent(String(value || 'anonymous'))
}

function legacyScopePart (value) {
  return String(value || 'anonymous').replace(/[^A-Za-z0-9_.-]/g, '_')
}

function currentPatientRef () {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    return app?.globalData?.patientRef || 'anonymous'
  } catch (_) { return 'anonymous' }
}

function normalizeQueueScope (scope, deviceRef, sessionId) {
  if (scope && typeof scope === 'object') {
    return {
      patientRef: String(scope.patientRef || currentPatientRef()).trim() || 'anonymous',
      deviceRef: String(scope.deviceRef || scope.wearableDeviceRef || '').trim(),
      sessionId: String(scope.sessionId || scope.wearableSessionId || '').trim()
    }
  }
  return {
    patientRef: String(scope || currentPatientRef()).trim() || 'anonymous',
    deviceRef: String(deviceRef || '').trim(),
    sessionId: String(sessionId || '').trim()
  }
}

function queueStorageKey (scope, deviceRef, sessionId) {
  const normalized = normalizeQueueScope(scope, deviceRef, sessionId)
  const patientPart = safeScopePart(normalized.patientRef)
  if (!normalized.deviceRef) return `${queueKey}.${patientPart}`
  const devicePart = safeScopePart(normalized.deviceRef)
  const base = `${queueKey}.${patientPart}.${devicePart}`
  return normalized.sessionId ? `${base}.${safeScopePart(normalized.sessionId)}` : base
}

function legacyPatientQueueKey (patientRef) {
  return `${queueKey}.${legacyScopePart(patientRef)}`
}

function legacyQueueKeys (patientRef) {
  const keys = [queueStorageKey(patientRef), legacyPatientQueueKey(patientRef)]
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    const mode = String(app?.globalData?.mode || '').trim()
    if (mode && mode !== String(patientRef || '').trim()) keys.push(legacyPatientQueueKey(mode))
  } catch (_) {}
  return keys.filter((key, index) => key && keys.indexOf(key) === index)
}

function readStorage (key, fallback) {
  try {
    const value = wx.getStorageSync(key)
    return value == null ? fallback : value
  } catch (_) { return fallback }
}

function writeStorage (key, value) {
  try { wx.setStorageSync(key, value) } catch (_) { /* best effort in tests/offline mode */ }
}

function readStoredQueueIndex () {
  const value = readStorage(queueIndexKey, [])
  return Array.isArray(value) ? value.filter(item => item && item.key) : []
}

function recoverQueueIndex (index) {
  let next = index.slice()
  let changed = false
  let keys = []
  try {
    const info = typeof wx.getStorageInfoSync === 'function' ? wx.getStorageInfoSync() : null
    keys = Array.isArray(info?.keys) ? info.keys : []
  } catch (_) {}
  keys.forEach(key => {
    if (!key || key === queueIndexKey || !key.startsWith(`${queueKey}.`)) return
    if (next.some(item => item.key === key)) return
    const queue = readQueueAtKey(key)
    const sample = queue.find(batch => batch && typeof batch === 'object' &&
      String(batch.patientRef || '').trim() && String(batch.deviceRef || '').trim())
    if (!sample) return
    // Patient-only legacy queues are migrated from their batch metadata below;
    // they are not exact v2 scopes and must not be indexed as one.
    const patientKey = legacyPatientQueueKey(sample.patientRef)
    if (key === patientKey || key === queueStorageKey(sample.patientRef)) return
    next = next.concat({
      key,
      patientRef: String(sample.patientRef).trim(),
      deviceRef: String(sample.deviceRef).trim(),
      sessionId: String(sample.sessionId || '').trim()
    })
    changed = true
  })
  if (changed) writeStorage(queueIndexKey, next)
  return next
}

function readQueueIndex () {
  return recoverQueueIndex(readStoredQueueIndex())
}

function registerQueueScope (scope) {
  if (!scope.deviceRef) return
  const key = queueStorageKey(scope)
  const index = readQueueIndex()
  if (index.some(item => item.key === key)) return
  writeStorage(queueIndexKey, index.concat({
    key,
    patientRef: scope.patientRef,
    deviceRef: scope.deviceRef,
    sessionId: scope.sessionId || ''
  }))
}

function unregisterQueueScope (key) {
  const next = readQueueIndex().filter(item => item.key !== key)
  writeStorage(queueIndexKey, next)
}

function readQueueAtKey (key) {
  const queue = readStorage(key, [])
  return Array.isArray(queue) ? queue.slice() : []
}

function migrateLegacyQueues (patientRef) {
  const requestedPatientRef = String(patientRef || '').trim()
  const sourceKeys = legacyQueueKeys(requestedPatientRef || 'anonymous')
  sourceKeys.forEach(sourceKey => {
    const sourceQueue = readQueueAtKey(sourceKey)
    if (!sourceQueue.length) return
    const remainder = []
    const destinations = new Map()
    sourceQueue.forEach(batch => {
      const batchPatientRef = String(batch && batch.patientRef || '').trim()
      const batchDeviceRef = String(batch && (batch.deviceRef || batch.wearableDeviceRef) || '').trim()
      const batchSessionId = String(batch && (batch.sessionId || batch.wearableSessionId) || '').trim()
      if (!batch || typeof batch !== 'object' || !batchPatientRef || !batchDeviceRef || !batchSessionId) {
        remainder.push(batch)
        return
      }
      const targetScope = {
        patientRef: batchPatientRef,
        deviceRef: batchDeviceRef,
        sessionId: batchSessionId
      }
      const targetKey = queueStorageKey(targetScope)
      if (!destinations.has(targetKey)) destinations.set(targetKey, { scope: targetScope, batches: [] })
      destinations.get(targetKey).batches.push(Object.assign({}, batch, targetScope))
    })
    destinations.forEach(({ scope, batches }, targetKey) => {
      const targetQueue = readQueueAtKey(targetKey)
      const seen = new Set(targetQueue.map(batch => batch && batch.batchId).filter(Boolean).map(String))
      batches.forEach(batch => {
        const id = batch.batchId == null ? '' : String(batch.batchId)
        if (id && seen.has(id)) return
        if (id) seen.add(id)
        targetQueue.push(batch)
      })
      writeQueueAtKey(targetKey, targetQueue, scope)
    })
    if (remainder.length !== sourceQueue.length) writeStorage(sourceKey, remainder)
  })
}

function writeQueueAtKey (key, queue, scope) {
  writeStorage(key, queue.slice())
  if (scope && scope.deviceRef) registerQueueScope(scope)
  if (!queue.length && scope && scope.deviceRef) unregisterQueueScope(key)
}

function queueEntries (scope) {
  const keys = []
  if (scope.deviceRef) {
    const exactSession = scope.sessionId
    readQueueIndex().forEach(item => {
      if (item.patientRef !== scope.patientRef || item.deviceRef !== scope.deviceRef) return
      if (exactSession && item.sessionId !== exactSession) return
      keys.push({ key: item.key, scope: normalizeQueueScope(item) })
    })
    const baseKey = queueStorageKey(scope.patientRef, scope.deviceRef)
    if (!keys.some(item => item.key === baseKey)) keys.push({ key: baseKey, scope: normalizeQueueScope(scope.patientRef, scope.deviceRef, '') })
    // A legacy patient queue may already contain device-tagged batches.
    legacyQueueKeys(scope.patientRef).forEach(legacyKey => {
      if (!keys.some(item => item.key === legacyKey)) keys.push({ key: legacyKey, scope: normalizeQueueScope(scope.patientRef) })
    })
  } else {
    legacyQueueKeys(scope.patientRef).forEach(legacyKey => keys.push({ key: legacyKey, scope: normalizeQueueScope(scope.patientRef) }))
    readQueueIndex().forEach(item => {
      if (item.patientRef === scope.patientRef && !keys.some(entry => entry.key === item.key)) {
        keys.push({ key: item.key, scope: normalizeQueueScope(item) })
      }
    })
  }
  const entries = []
  keys.forEach(source => {
    readQueueAtKey(source.key).forEach((batch, index) => {
      if (!batch || typeof batch !== 'object') return
      if (scope.deviceRef && batch.deviceRef && String(batch.deviceRef) !== scope.deviceRef) return
      if (scope.sessionId && batch.sessionId && String(batch.sessionId) !== scope.sessionId) return
      entries.push({ key: source.key, scope: source.scope, batch, index })
    })
  })
  return entries
}

function readQueue (scope = currentPatientRef(), deviceRef, sessionId) {
  const normalized = normalizeQueueScope(scope, deviceRef, sessionId)
  migrateLegacyQueues(normalized.patientRef)
  return queueEntries(normalized).map(entry => entry.batch)
}

function removeQueueEntry (entry) {
  const queue = readQueueAtKey(entry.key)
  const index = queue.findIndex(item => item && entry.batch && item.batchId && entry.batch.batchId
    ? String(item.batchId) === String(entry.batch.batchId)
    : item === entry.batch)
  if (index < 0) return
  queue.splice(index, 1)
  writeQueueAtKey(entry.key, queue, entry.scope)
}

function appendQueueBatch (batch) {
  const normalized = normalizeQueueScope(batch)
  migrateLegacyQueues(normalized.patientRef)
  const storedBatch = Object.assign({}, batch)
  if (!storedBatch.patientRef) storedBatch.patientRef = normalized.patientRef
  if (normalized.deviceRef && !storedBatch.deviceRef) storedBatch.deviceRef = normalized.deviceRef
  if (normalized.sessionId && !storedBatch.sessionId) storedBatch.sessionId = normalized.sessionId
  const existing = queueEntries(normalized).some(entry => entry.batch.batchId && storedBatch.batchId &&
    String(entry.batch.batchId) === String(batch.batchId))
  if (existing) return false
  const key = queueStorageKey(normalized)
  const queue = readQueueAtKey(key)
  queue.push(storedBatch)
  writeQueueAtKey(key, queue, normalized)
  return true
}

function request (url, method, data, token) {
  return new Promise((resolve, reject) => {
    const header = token ? { Authorization: `Bearer ${token}` } : {}
    wx.request({ url, method, data, header,
      success: res => {
        const businessCode = Number(res.data?.code)
        const unauthorized = Number(res.statusCode) === 401 || businessCode === 401
        if (res.statusCode >= 200 && res.statusCode < 300 && !unauthorized) {
          resolve(res.data)
          return
        }
        const error = new Error(`HTTP ${res.statusCode}`)
        // Some gateways return HTTP 200 with a business-level 401. Keep one
        // error shape so callers do not accidentally skip session renewal.
        error.statusCode = unauthorized ? 401 : res.statusCode
        error.response = res.data
        if (res.data?.code != null) error.code = res.data.code
        reject(error)
      },
      fail: err => {
        // 网络层失败（DNS/SSL/断连等）没有 message，只有 errMsg——透传给调用方，避免被笼统的「登录失败/同步失败」吞掉
        const error = new Error('网络请求失败: ' + ((err && err.errMsg) || 'unknown'))
        error.errMsg = (err && err.errMsg) || ''
        reject(error)
      } })
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
      fail: err => {
        const error = new Error('微信授权失败: ' + ((err && err.errMsg) || 'unknown'))
        error.errMsg = (err && err.errMsg) || ''
        reject(error)
      }
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
  const payload = { deviceRef }
  if (sessionId) payload.sessionId = sessionId
  return cdmsRequest('/api/v1/miniapp/iot/wearable-session', 'POST', payload, app.globalData.accessToken)
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

function listQueueScopes () {
  return readQueueIndex().map(item => Object.assign({}, item))
}

function mergeUploadResult (summary, result) {
  if (!result || typeof result !== 'object') return summary
  ;['accepted', 'duplicates', 'rejected'].forEach(key => {
    const value = Number(result[key])
    if (Number.isFinite(value)) summary[key] += value
  })
  return summary
}

async function flushQueueInternal ({ baseUrl, token, scope }) {
  const summary = { accepted: 0, duplicates: 0, rejected: 0 }
  while (true) {
    const entries = queueEntries(scope)
    const entry = entries[0]
    if (!entry) return summary
    const batch = entry.batch
    if (scope.patientRef && String(batch.patientRef || '') !== scope.patientRef) {
      const error = new Error('上传队列患者范围不一致')
      error.code = 'QUEUE_SCOPE_MISMATCH'
      error.statusCode = 409
      throw error
    }
    if (!scope.deviceRef && String(batch.deviceRef || '')) {
      const error = new Error('上传队列缺少设备范围')
      error.code = 'QUEUE_SCOPE_MISMATCH'
      error.statusCode = 409
      throw error
    }
    if (scope.deviceRef && String(batch.deviceRef || '') !== scope.deviceRef) {
      const error = new Error('上传队列设备范围不一致')
      error.code = 'QUEUE_SCOPE_MISMATCH'
      error.statusCode = 409
      throw error
    }
    if (scope.sessionId && String(batch.sessionId || '') !== scope.sessionId) {
      const error = new Error('上传队列会话范围不一致')
      error.code = 'QUEUE_SCOPE_MISMATCH'
      error.statusCode = 409
      throw error
    }
    const result = await request(`${baseUrl}/v1/wearable-upload-batches`, 'POST', batch, token)
    mergeUploadResult(summary, result)
    removeQueueEntry(entry)
  }
}

async function flushQueue (options = {}) {
  const scope = normalizeQueueScope(options.scope || options.patientRef || currentPatientRef(), options.deviceRef, options.sessionId)
  if (!scope.patientRef || scope.patientRef === 'anonymous' || !scope.deviceRef || !scope.sessionId) {
    const error = new Error('上传队列需要完整患者、设备和会话作用域')
    error.code = 'QUEUE_SCOPE_REQUIRED'
    error.statusCode = 409
    throw error
  }
  // Migrate only after the caller has supplied an exact scope. This keeps
  // legacy batches isolated and makes a patient-only flush fail closed.
  migrateLegacyQueues(scope.patientRef)
  const key = queueStorageKey(scope)
  if (flushLocks.has(key)) return flushLocks.get(key)
  const promise = flushQueueInternal({ baseUrl: options.baseUrl, token: options.token, scope })
    .finally(() => flushLocks.delete(key))
  flushLocks.set(key, promise)
  return promise
}

function rebindQueueSession ({ patientRef, deviceRef, fromSessionId, toSessionId }) {
  const sourceScope = normalizeQueueScope({ patientRef, deviceRef, sessionId: fromSessionId })
  const targetScope = normalizeQueueScope({ patientRef, deviceRef, sessionId: toSessionId })
  if (!sourceScope.deviceRef || !sourceScope.sessionId || !targetScope.sessionId) return 0
  if (sourceScope.sessionId === targetScope.sessionId) return 0
  const sourceEntries = queueEntries(sourceScope).filter(entry =>
    String(entry.batch.deviceRef || '') === sourceScope.deviceRef &&
    String(entry.batch.patientRef || '') === sourceScope.patientRef &&
    String(entry.batch.sessionId || '') === sourceScope.sessionId)
  if (!sourceEntries.length) return 0

  const targetKey = queueStorageKey(targetScope)
  const targetQueue = readQueueAtKey(targetKey)
  const seenBatchIds = new Set(targetQueue.map(item => item && item.batchId).filter(Boolean).map(String))
  const removals = new Map()
  let moved = 0
  sourceEntries.forEach(entry => {
    const batchId = entry.batch && entry.batch.batchId ? String(entry.batch.batchId) : ''
    if (!batchId || !seenBatchIds.has(batchId)) {
      if (batchId) seenBatchIds.add(batchId)
      targetQueue.push(Object.assign({}, entry.batch, {
        patientRef: targetScope.patientRef,
        deviceRef: targetScope.deviceRef,
        sessionId: targetScope.sessionId
      }))
      moved += 1
    }
    if (!removals.has(entry.key)) removals.set(entry.key, new Set())
    removals.get(entry.key).add(batchId || `__index__${entry.index}`)
  })
  if (moved) writeQueueAtKey(targetKey, targetQueue, targetScope)
  removals.forEach((batchIds, key) => {
    const sourceQueue = readQueueAtKey(key).filter((item, index) => {
      const identity = item && item.batchId ? String(item.batchId) : `__index__${index}`
      return !batchIds.has(identity)
    })
    const sourceScopeForKey = readQueueIndex().find(item => item.key === key) || sourceScope
    writeQueueAtKey(key, sourceQueue, sourceScopeForKey)
  })
  return moved
}

async function exchangeHandoff ({ managerBaseUrl, handoffCode, deviceRef }) {
  if (!managerBaseUrl || !handoffCode || !deviceRef) throw new Error('缺少小程序安全启动上下文')
  const result = await request(`${managerBaseUrl}/iot/wearable-handoffs/${encodeURIComponent(handoffCode)}/exchange`, 'POST', { deviceRef }, '')
  return result?.data || result
}

function enqueue (batch) {
  if (!batch || typeof batch !== 'object') return false
  return appendQueueBatch(batch)
}

module.exports = { enqueue, flushQueue, rebindQueueSession, exchangeHandoff, readQueue, listQueueScopes, queueStorageKey, request, cdmsRequest, login, loginDoctor, loginWithWechat, logout, switchRole, createHandoff, redeemHandoff, createPatientWearableSession, releasePatientWearableSession, listDoctorPatients, getDoctorPatient, submitScaleMeasurement, refreshAccessToken }
