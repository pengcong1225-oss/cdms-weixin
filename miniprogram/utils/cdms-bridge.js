const api = require('./api')
const { flattenRecords } = require('./rwfit-normalize')
const { getSessionStrategy } = require('./session-strategy')

const SESSION_CACHE_KEY = 'cdms.miniapp.wearable.sessions.v2'
let requestGeneration = 0
let latestRequest = null
let contextRevision = 0
let contextSignature = null

function appContext () {
  const app = typeof getApp === 'function' ? getApp() : null
  return app?.globalData || {}
}

function text (value) {
  return String(value == null ? '' : value).trim()
}

function storageRead (key, fallback) {
  try {
    const value = wx.getStorageSync(key)
    return value == null ? fallback : value
  } catch (_) { return fallback }
}

function storageWrite (key, value) {
  try { wx.setStorageSync(key, value) } catch (_) { /* best effort */ }
}

function storageRemove (key) {
  try { wx.removeStorageSync(key) } catch (_) { /* best effort */ }
}

function sessionKey (patientRef, deviceRef) {
  return `${text(patientRef)}\u0000${text(deviceRef)}`
}

function sessionSnapshot (values, fallback = {}) {
  const source = Object.assign({}, fallback, values || {})
  return {
    iotBaseUrl: text(source.iotBaseUrl),
    wearableToken: text(source.wearableToken || source.uploadToken || source.token),
    wearableSessionId: text(source.wearableSessionId || source.sessionId),
    patientRef: text(source.patientRef || source.patientId),
    deviceRef: text(source.deviceRef || source.wearableDeviceRef)
  }
}

function isCompleteSession (session) {
  return !!(session && session.iotBaseUrl && session.wearableToken &&
    session.wearableSessionId && session.patientRef && session.deviceRef)
}

function immutableSnapshot (session) {
  return Object.freeze(Object.assign({}, session))
}

function readSessionCache () {
  const raw = storageRead(SESSION_CACHE_KEY, [])
  const values = Array.isArray(raw) ? raw : raw && Array.isArray(raw.sessions) ? raw.sessions : []
  return values.map(value => sessionSnapshot(value)).filter(isCompleteSession)
}

function writeSessionCache (sessions) {
  storageWrite(SESSION_CACHE_KEY, sessions.map(session => Object.assign({}, session)))
}

function cacheSession (session) {
  const normalized = sessionSnapshot(session)
  if (!isCompleteSession(normalized)) throw new Error('IoT 会话响应范围不完整')
  const sessions = readSessionCache()
  const index = sessions.findIndex(item => sessionKey(item.patientRef, item.deviceRef) ===
    sessionKey(normalized.patientRef, normalized.deviceRef))
  if (index < 0) sessions.push(normalized)
  else sessions[index] = normalized
  writeSessionCache(sessions)
  return normalized
}

function findCachedSession (patientRef, deviceRef) {
  return readSessionCache().find(item =>
    item.patientRef === text(patientRef) && item.deviceRef === text(deviceRef)) || null
}

function removeCachedSession (patientRef, deviceRef) {
  const target = sessionKey(patientRef, deviceRef)
  writeSessionCache(readSessionCache().filter(item => sessionKey(item.patientRef, item.deviceRef) !== target))
}

function persistLegacyContext (context) {
  if (!context.wearableToken || !context.wearableSessionId) return
  storageWrite('cdms.miniapp.wearable', {
    iotBaseUrl: context.iotBaseUrl || '',
    wearableToken: context.wearableToken,
    wearableSessionId: context.wearableSessionId,
    wearableDeviceRef: context.wearableDeviceRef || context.deviceRef || '',
    patientRef: context.patientRef || ''
  })
}

function publishSession (session) {
  const context = appContext()
  context.iotBaseUrl = session.iotBaseUrl
  context.wearableToken = session.wearableToken
  context.wearableSessionId = session.wearableSessionId
  context.wearableDeviceRef = session.deviceRef
  context.deviceRef = session.deviceRef
  context.patientRef = session.patientRef
  persistLegacyContext(context)
  return immutableSnapshot(session)
}

function observeContextRevision (context) {
  const signature = [
    text(context.patientRef || context.patientId),
    text(context.activeRole),
    text(context.identityId || context.principalId),
    text(context.accessToken),
    text(context.refreshToken)
  ].join('\u0000')
  if (signature !== contextSignature) {
    contextSignature = signature
    contextRevision += 1
  }
  return contextRevision
}

function beginSessionRequest (context, deviceRef) {
  const identity = {
    generation: ++requestGeneration,
    contextRevision: observeContextRevision(context),
    patientRef: text(context.patientRef || context.patientId),
    activeRole: text(context.activeRole),
    identityId: text(context.identityId || context.principalId),
    accessToken: text(context.accessToken),
    refreshToken: text(context.refreshToken),
    deviceRef: text(deviceRef),
    initialDeviceRef: text(context.wearableDeviceRef || context.deviceRef),
    initialIotBaseUrl: text(context.iotBaseUrl)
  }
  latestRequest = identity
  return identity
}

function mayPublishSession (identity) {
  const context = appContext()
  if (observeContextRevision(context) !== identity.contextRevision) return false
  const currentPatientRef = text(context.patientRef || context.patientId)
  if (currentPatientRef !== identity.patientRef) return false
  if (text(context.activeRole) !== identity.activeRole) return false
  if (text(context.identityId || context.principalId) !== identity.identityId) return false
  if (text(context.accessToken) !== identity.accessToken) return false
  if (text(context.refreshToken) !== identity.refreshToken) return false
  if (!latestRequest || latestRequest.generation !== identity.generation ||
    latestRequest.deviceRef !== identity.deviceRef) return false
  const currentDeviceRef = text(context.wearableDeviceRef || context.deviceRef)
  if (currentDeviceRef && currentDeviceRef !== identity.deviceRef &&
    currentDeviceRef !== identity.initialDeviceRef) return false
  return true
}

function publishSessionIfCurrent (identity, session) {
  return mayPublishSession(identity) ? publishSession(session) : immutableSnapshot(session)
}

function createUploadBatch ({ batchId, sessionId, patientRef, deviceRef, recordsByType, records, sdkVersion = 'RW_SDK_V2.0.0_20260807' }) {
  const normalized = records || flattenRecords(recordsByType)
  return {
    batchId: String(batchId || `wx-${Date.now()}`),
    sessionId: String(sessionId || ''),
    patientRef: String(patientRef || ''),
    deviceRef: String(deviceRef || ''),
    sdkVersion,
    records: normalized
  }
}

function updateContext (values) {
  const context = appContext()
  Object.assign(context, values || {})
  if (context.deviceRef && !context.wearableDeviceRef) context.wearableDeviceRef = context.deviceRef
  observeContextRevision(context)
  persistLegacyContext(context)
  return context
}

function clearWearableSession (deviceRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef || context.wearableDeviceRef || context.deviceRef)
  if (targetDeviceRef) removeCachedSession(context.patientRef, targetDeviceRef)
  const currentDeviceRef = text(context.wearableDeviceRef || context.deviceRef)
  if (!targetDeviceRef || !currentDeviceRef || targetDeviceRef === currentDeviceRef) {
    context.wearableToken = ''
    context.wearableSessionId = ''
    context.wearableDeviceRef = ''
    context.deviceRef = ''
    storageRemove('cdms.miniapp.wearable')
  }
  return context
}

function canRenewPatientSession (context) {
  return context.activeRole === 'PATIENT' &&
    !!context.cdmsBaseUrl &&
    !!context.accessToken &&
    !!context.patientRef
}

async function renewPatientSession (deviceRef, expiredSessionId, expectedPatientRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef)
  const identity = beginSessionRequest(context, targetDeviceRef)
  const patientRef = identity.patientRef
  if (!canRenewPatientSession(context) || !targetDeviceRef) {
    throw new Error('患者登录状态不完整，无法续期 IoT 会话')
  }
  if (expectedPatientRef && patientRef !== text(expectedPatientRef)) {
    throw new Error('患者登录状态已切换，拒绝续期旧设备会话')
  }
  clearWearableSession(targetDeviceRef)
  // A renewal is a new session creation. The expired ID is intentionally not
  // sent back to the server and may never be used as a fallback locally.
  const response = await api.createPatientWearableSession(targetDeviceRef)
  const raw = response?.data || response
  const session = sessionSnapshot(raw, {
    patientRef,
    deviceRef: targetDeviceRef,
    iotBaseUrl: identity.initialIotBaseUrl
  })
  if (!isCompleteSession(session) || session.patientRef !== patientRef || session.deviceRef !== targetDeviceRef) {
    throw new Error('IoT 新会话响应范围不完整')
  }
  if (expiredSessionId && session.wearableSessionId === text(expiredSessionId)) {
    throw new Error('IoT 新会话不得复用已过期 sessionId')
  }
  cacheSession(session)
  // A late renewal for a previously active device/patient must not overwrite
  // the global convenience context. The immutable snapshot remains available
  // to the caller for its own retry.
  return publishSessionIfCurrent(identity, session)
}

async function ensureIoTSession (deviceRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef || context.wearableDeviceRef || context.deviceRef)
  if (!targetDeviceRef) throw new Error('缺少设备标识，无法建立 IoT 会话')
  const identity = beginSessionRequest(context, targetDeviceRef)
  const requestedPatientRef = identity.patientRef
  const patientRef = requestedPatientRef || 'anonymous'
  const cached = findCachedSession(patientRef, targetDeviceRef)
  if (cached) return publishSessionIfCurrent(identity, cached)

  const currentDeviceRef = text(context.wearableDeviceRef || context.deviceRef)
  const current = sessionSnapshot(context)
  // Very old handoff payloads did not include a device reference. They may be
  // adopted once for the requested device, but an explicitly different
  // cached device must never be retagged as the new device.
  if (!currentDeviceRef && current.wearableToken && current.wearableSessionId) current.deviceRef = targetDeviceRef
  if (isCompleteSession(current) && current.patientRef === patientRef && current.deviceRef === targetDeviceRef) {
    cacheSession(current)
    return publishSessionIfCurrent(identity, current)
  }

  let strategy = getSessionStrategy(context)
  if (strategy === 'EXISTING') {
    // An existing session for another device is not reusable, but its cache is
    // retained. Select the original issuance path for the requested device.
    strategy = context.activeRole === 'PATIENT' && context.cdmsBaseUrl && context.accessToken && requestedPatientRef
      ? 'CDMS_PATIENT'
      : context.managerBaseUrl && context.handoffCode ? 'MANAGER_HANDOFF' : 'MISSING'
  }
  let rawSession
  if (strategy === 'CDMS_PATIENT') {
    const response = await api.createPatientWearableSession(targetDeviceRef)
    rawSession = response?.data || response
  } else if (strategy === 'MANAGER_HANDOFF') {
    rawSession = await api.exchangeHandoff({
      managerBaseUrl: context.managerBaseUrl,
      handoffCode: context.handoffCode,
      deviceRef: targetDeviceRef
    })
  } else {
    throw new Error('缺少小程序安全启动上下文')
  }
  const session = sessionSnapshot(rawSession, {
    iotBaseUrl: identity.initialIotBaseUrl,
    patientRef,
    deviceRef: targetDeviceRef
  })
  if (!isCompleteSession(session) || (requestedPatientRef && session.patientRef !== requestedPatientRef) || session.deviceRef !== targetDeviceRef) {
    throw new Error('IoT 会话响应范围不完整')
  }
  cacheSession(session)
  return publishSessionIfCurrent(identity, session)
}

async function releaseWearableSession (deviceRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef || context.wearableDeviceRef || context.deviceRef)
  try {
    if (targetDeviceRef && canRenewPatientSession(context)) {
      await api.releasePatientWearableSession(targetDeviceRef)
    }
  } finally {
    clearWearableSession(targetDeviceRef)
  }
}

async function enqueueAndFlush ({ deviceRef, recordsByType, records, syncScope, session }) {
  const requestedDeviceRef = text(deviceRef || syncScope?.deviceRef)
  const context = session && typeof session === 'object'
    ? immutableSnapshot(sessionSnapshot(session))
    : await ensureIoTSession(requestedDeviceRef)
  if (!isCompleteSession(context)) throw new Error('IoT 会话范围不完整，无法上传健康数据')
  if (syncScope && (
    text(syncScope.patientRef) !== context.patientRef ||
    text(syncScope.deviceRef) !== context.deviceRef ||
    text(syncScope.sessionId) !== context.wearableSessionId
  )) {
    throw new Error('上传作用域与 IoT 会话不一致')
  }
  if (requestedDeviceRef && requestedDeviceRef !== context.deviceRef) {
    throw new Error('上传设备作用域与 IoT 会话不一致')
  }
  const batch = createUploadBatch({
    sessionId: context.wearableSessionId,
    patientRef: context.patientRef,
    deviceRef: context.deviceRef,
    recordsByType,
    records
  })
  api.enqueue(batch)
  const scope = { patientRef: context.patientRef, deviceRef: context.deviceRef, sessionId: context.wearableSessionId }
  try {
    return await api.flushQueue({ baseUrl: context.iotBaseUrl, token: context.wearableToken, scope })
  } catch (error) {
    const unauthorized = Number(error?.statusCode) === 401 ||
      Number(error?.code) === 401 || Number(error?.response?.code) === 401
    if (!unauthorized || !canRenewPatientSession(appContext())) throw error
    const renewed = await renewPatientSession(context.deviceRef, context.wearableSessionId, context.patientRef)
    const live = appContext()
    const liveDeviceRef = text(live.wearableDeviceRef || live.deviceRef)
    if (text(live.patientRef || live.patientId) !== context.patientRef ||
      (liveDeviceRef && liveDeviceRef !== context.deviceRef) ||
      (text(live.wearableSessionId) && text(live.wearableSessionId) !== renewed.wearableSessionId)) {
      throw new Error('上传期间患者或设备上下文已切换，保留队列待当前作用域重试')
    }
    api.rebindQueueSession({
      patientRef: context.patientRef,
      deviceRef: context.deviceRef,
      fromSessionId: context.wearableSessionId,
      toSessionId: renewed.wearableSessionId
    })
    return api.flushQueue({
      baseUrl: renewed.iotBaseUrl,
      token: renewed.wearableToken,
      scope: { patientRef: renewed.patientRef, deviceRef: renewed.deviceRef, sessionId: renewed.wearableSessionId }
    })
  }
}

module.exports = {
  createUploadBatch,
  ensureIoTSession,
  enqueueAndFlush,
  updateContext,
  clearWearableSession,
  releaseWearableSession,
  renewPatientSession
}
