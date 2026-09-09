const api = require('./api')
const { flattenRecords } = require('./rwfit-normalize')
const { getSessionStrategy } = require('./session-strategy')

const SESSION_CACHE_KEY = 'cdms.miniapp.wearable.sessions.v2'
let requestGeneration = 0
let latestRequest = null
let contextRevision = 0
let contextSignature = null
const sessionGenerations = new Map()
const sessionProvenance = new WeakMap()
// Session creation, renewal, and release for one patient/device must be
// serialized. A release invalidates the local generation before its DELETE
// starts; an ensure that arrives during that DELETE waits before creating a
// replacement.
const scopeLocks = new Map()
const scopeEnsureFlights = new Map()

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

function immutableSnapshot (session, identity) {
  const snapshot = Object.freeze(Object.assign({}, session))
  if (identity) sessionProvenance.set(snapshot, Object.assign({}, identity))
  return snapshot
}

function sessionGeneration (patientRef, deviceRef) {
  return sessionGenerations.get(sessionKey(patientRef, deviceRef)) || 0
}

function invalidateSessionScope (patientRef, deviceRef) {
  const key = sessionKey(patientRef, deviceRef)
  sessionGenerations.set(key, sessionGeneration(patientRef, deviceRef) + 1)
}

function runScopeOperation (key, operation, startImmediately = false) {
  const previous = scopeLocks.get(key)
  let current
  if (!previous && startImmediately) {
    try { current = Promise.resolve(operation()) } catch (error) { current = Promise.reject(error) }
  } else {
    current = (previous || Promise.resolve()).catch(() => undefined).then(operation)
  }
  scopeLocks.set(key, current)
  current.then(
    () => { if (scopeLocks.get(key) === current) scopeLocks.delete(key) },
    () => { if (scopeLocks.get(key) === current) scopeLocks.delete(key) }
  )
  return current
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
    text(context.refreshToken),
    text(context.authGeneration || context.authRevision || context.authVersion || context.tokenVersion)
  ].join('\u0000')
  if (signature !== contextSignature) {
    contextSignature = signature
    contextRevision += 1
  }
  return contextRevision
}

function authIdentity (context) {
  return {
    contextRevision: observeContextRevision(context),
    patientRef: text(context.patientRef || context.patientId),
    activeRole: text(context.activeRole),
    identityId: text(context.identityId || context.principalId),
    accessToken: text(context.accessToken),
    refreshToken: text(context.refreshToken),
    // Newer callers may expose an explicit generation.  Keep it in the
    // provenance when present so a logout/login cycle cannot be mistaken for
    // the same value merely because a token happens to be reused.
    authGeneration: text(context.authGeneration || context.authRevision || context.authVersion || context.tokenVersion)
  }
}

function authIdentityIsCurrent (identity) {
  if (!identity) return false
  const current = appContext()
  const live = authIdentity(current)
  return live.contextRevision === identity.contextRevision &&
    live.patientRef === identity.patientRef &&
    live.activeRole === identity.activeRole &&
    live.identityId === identity.identityId &&
    live.accessToken === identity.accessToken &&
    live.refreshToken === identity.refreshToken &&
    live.authGeneration === identity.authGeneration
}

function operationGuardIsCurrent (guard) {
  if (!guard) return true
  try {
    if (typeof guard === 'function') return !!guard()
    if (typeof guard.isOperationCurrent === 'function') return !!guard.isOperationCurrent()
    if (typeof guard.isCurrent === 'function') return !!guard.isCurrent()
  } catch (_) {
    return false
  }
  return false
}

function sameAuthIdentity (left, right) {
  if (!left || !right) return false
  return left.contextRevision === right.contextRevision &&
    left.patientRef === right.patientRef &&
    left.activeRole === right.activeRole &&
    left.identityId === right.identityId &&
    left.accessToken === right.accessToken &&
    left.refreshToken === right.refreshToken &&
    left.authGeneration === right.authGeneration
}

function captureInvocationProvenance (context, requestedDeviceRef, providedSession) {
  const scopedSession = isCompleteSession(providedSession) ? providedSession : null
  const patientRef = text(scopedSession?.patientRef || context.patientRef || context.patientId)
  return {
    auth: authIdentity(context),
    patientRef,
    deviceRef: text(requestedDeviceRef || scopedSession?.deviceRef || context.wearableDeviceRef || context.deviceRef),
    session: scopedSession || sessionSnapshot(context)
  }
}

function sessionBelongsToInvocation (session, invocation) {
  if (!session || !invocation || !isCompleteSession(session)) return false
  if (session.patientRef !== invocation.patientRef || session.deviceRef !== invocation.deviceRef) return false
  const identity = sessionProvenance.get(session)
  if (!identity) return session === invocation.session ||
    (session.wearableSessionId === invocation.session.wearableSessionId &&
      session.wearableToken === invocation.session.wearableToken)
  return identity.patientRef === invocation.auth.patientRef &&
    identity.activeRole === invocation.auth.activeRole &&
    identity.identityId === invocation.auth.identityId &&
    identity.accessToken === invocation.auth.accessToken &&
    identity.refreshToken === invocation.auth.refreshToken &&
    identity.authGeneration === invocation.auth.authGeneration
}

function queueableInvocationSession (invocation, candidate) {
  // The invocation snapshot is the caller's original scope.  Its provenance
  // may intentionally be stale by the time we reach this boundary, but it is
  // still the only safe batch owner to retain locally.
  if (isCompleteSession(invocation?.session) &&
    invocation.session.patientRef === invocation.patientRef &&
    invocation.session.deviceRef === invocation.deviceRef) return invocation.session
  if (sessionBelongsToInvocation(candidate, invocation)) return candidate
  return null
}

function invocationIsCurrent (invocation, candidate, operationGuard) {
  if (!authIdentityIsCurrent(invocation?.auth)) return false
  if (!operationGuardIsCurrent(operationGuard)) return false
  return !candidate || isCurrentSessionSnapshot(candidate)
}

function beginSessionRequest (context, deviceRef) {
  const patientRef = text(context.patientRef || context.patientId)
  const identity = {
    generation: ++requestGeneration,
    contextRevision: observeContextRevision(context),
    patientRef,
    activeRole: text(context.activeRole),
    identityId: text(context.identityId || context.principalId),
    accessToken: text(context.accessToken),
    refreshToken: text(context.refreshToken),
    authGeneration: text(context.authGeneration || context.authRevision || context.authVersion || context.tokenVersion),
    deviceRef: text(deviceRef),
    sessionGeneration: sessionGeneration(patientRef || 'anonymous', deviceRef),
    initialDeviceRef: text(context.wearableDeviceRef || context.deviceRef),
    initialIotBaseUrl: text(context.iotBaseUrl)
  }
  latestRequest = identity
  return identity
}

function mayPublishSession (identity) {
  const context = appContext()
  if (sessionGeneration(identity.patientRef || 'anonymous', identity.deviceRef) !== identity.sessionGeneration) return false
  if (observeContextRevision(context) !== identity.contextRevision) return false
  const currentPatientRef = text(context.patientRef || context.patientId)
  if (currentPatientRef !== identity.patientRef) return false
  if (text(context.activeRole) !== identity.activeRole) return false
  if (text(context.identityId || context.principalId) !== identity.identityId) return false
  if (text(context.accessToken) !== identity.accessToken) return false
  if (text(context.refreshToken) !== identity.refreshToken) return false
  if (text(context.authGeneration || context.authRevision || context.authVersion || context.tokenVersion) !== identity.authGeneration) return false
  if (!latestRequest || latestRequest.generation !== identity.generation ||
    latestRequest.deviceRef !== identity.deviceRef) return false
  const currentDeviceRef = text(context.wearableDeviceRef || context.deviceRef)
  if (currentDeviceRef && currentDeviceRef !== identity.deviceRef &&
    currentDeviceRef !== identity.initialDeviceRef) return false
  return true
}

function publishSessionIfCurrent (identity, session) {
  if (!mayPublishSession(identity)) return immutableSnapshot(session, identity)
  cacheSession(session)
  return immutableSnapshot(publishSession(session), identity)
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
  if (targetDeviceRef) {
    invalidateSessionScope(context.patientRef || context.patientId || 'anonymous', targetDeviceRef)
    removeCachedSession(context.patientRef || context.patientId, targetDeviceRef)
  }
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

async function renewPatientSessionUnlocked (deviceRef, expiredSessionId, expectedPatientRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef)
  if (!canRenewPatientSession(context) || !targetDeviceRef) {
    throw new Error('患者登录状态不完整，无法续期 IoT 会话')
  }
  const patientRef = text(context.patientRef || context.patientId)
  if (expectedPatientRef && patientRef !== text(expectedPatientRef)) {
    throw new Error('患者登录状态已切换，拒绝续期旧设备会话')
  }
  clearWearableSession(targetDeviceRef)
  const identity = beginSessionRequest(appContext(), targetDeviceRef)
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
  // A late renewal for a previously active device/patient must not overwrite
  // the global convenience context. The immutable snapshot remains available
  // to the caller for its own retry.
  return publishSessionIfCurrent(identity, session)
}

function renewPatientSession (deviceRef, expiredSessionId, expectedPatientRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef)
  const patientRef = text(context.patientRef || context.patientId) || 'anonymous'
  return runScopeOperation(
    sessionKey(patientRef, targetDeviceRef),
    () => renewPatientSessionUnlocked(targetDeviceRef, expiredSessionId, expectedPatientRef),
    true
  )
}

async function ensureIoTSessionUnlocked (targetDeviceRef) {
  let context = appContext()
  if (!targetDeviceRef) throw new Error('缺少设备标识，无法建立 IoT 会话')
  // The release may have cleared the old snapshot before this scoped
  // operation starts. A fresh identity also prevents an old session
  // generation from publishing.
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
  return publishSessionIfCurrent(identity, session)
}

function ensureIoTSession (deviceRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef || context.wearableDeviceRef || context.deviceRef)
  if (!targetDeviceRef) return Promise.reject(new Error('缺少设备标识，无法建立 IoT 会话'))
  const patientRef = text(context.patientRef || context.patientId) || 'anonymous'
  const key = sessionKey(patientRef, targetDeviceRef)
  const auth = authIdentity(context)
  const existing = scopeEnsureFlights.get(key)
  if (existing && sameAuthIdentity(existing.auth, auth)) return existing.promise
  const operation = runScopeOperation(key, () => ensureIoTSessionUnlocked(targetDeviceRef), true)
  const flight = { auth, promise: operation }
  scopeEnsureFlights.set(key, flight)
  const clearFlight = () => {
    if (scopeEnsureFlights.get(key) === flight) scopeEnsureFlights.delete(key)
  }
  operation.then(clearFlight, clearFlight)
  return operation
}

function releaseWearableSession (deviceRef) {
  const context = appContext()
  const targetDeviceRef = text(deviceRef || context.wearableDeviceRef || context.deviceRef)
  const shouldReleaseRemote = !!(targetDeviceRef && canRenewPatientSession(context))
  const patientRef = text(context.patientRef || context.patientId) || 'anonymous'
  const key = sessionKey(patientRef, targetDeviceRef)
  // A release invalidates every in-flight ensure for this scope. The old
  // promise may still settle, but a later ensure must queue behind this
  // release instead of reusing that stale result.
  scopeEnsureFlights.delete(key)
  // Register the lock before clearing so an immediately following ensure
  // waits, while invalidation itself still happens synchronously at release
  // entry (before the DELETE request is started).
  const lock = runScopeOperation(key, async () => {
    if (shouldReleaseRemote) await api.releasePatientWearableSession(targetDeviceRef)
  })
  clearWearableSession(targetDeviceRef)
  return lock
}

function sessionMatchesLiveContext (session) {
  const context = appContext()
  const patientRef = text(context.patientRef || context.patientId)
  const deviceRef = text(context.wearableDeviceRef || context.deviceRef)
  return patientRef === session.patientRef &&
    (!deviceRef || deviceRef === session.deviceRef) &&
    (!text(context.wearableSessionId) || text(context.wearableSessionId) === session.wearableSessionId) &&
    (!text(context.wearableToken) || text(context.wearableToken) === session.wearableToken)
}

function isCurrentSessionSnapshot (session) {
  const identity = sessionProvenance.get(session)
  return identity ? mayPublishSession(identity) : sessionMatchesLiveContext(session)
}

function staleSessionError () {
  const error = new Error('IoT 会话上下文已切换或已过期，已保留待当前作用域重试')
  error.code = 'STALE_WEARABLE_CONTEXT'
  error.statusCode = 409
  return error
}

function enqueueStaleInvocation (invocation, candidate, recordsByType, records) {
  const session = queueableInvocationSession(invocation, candidate)
  if (session) api.enqueue(createUploadBatch({
    sessionId: session.wearableSessionId,
    patientRef: session.patientRef,
    deviceRef: session.deviceRef,
    recordsByType,
    records
  }))
  throw staleSessionError()
}

async function enqueueAndFlush ({ deviceRef, recordsByType, records, syncScope, session, operationGuard, isOperationCurrent }) {
  const requestedDeviceRef = text(deviceRef || syncScope?.deviceRef)
  const providedSession = session && typeof session === 'object' ? session : null
  const contextAtInvocation = appContext()
  const invocation = captureInvocationProvenance(contextAtInvocation, requestedDeviceRef, providedSession)
  const externalGuard = isOperationCurrent || operationGuard
  if (!invocationIsCurrent(invocation, null, externalGuard)) {
    enqueueStaleInvocation(invocation, null, recordsByType, records)
  }
  const context = providedSession
    ? sessionSnapshot(providedSession)
    : await ensureIoTSession(requestedDeviceRef)
  if (!isCompleteSession(context)) throw new Error('IoT 会话范围不完整，无法上传健康数据')
  const candidateSession = providedSession || context
  // The bridge owns this boundary check as well as the caller.  ensure may
  // have waited on the network long enough for auth/connection ownership to
  // change, in which case these records must remain under the invocation's
  // original snapshot and never be sent with the new context.
  if (!invocationIsCurrent(invocation, candidateSession, externalGuard)) {
    enqueueStaleInvocation(invocation, candidateSession, recordsByType, records)
  }
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
  if (!invocationIsCurrent(invocation, candidateSession, externalGuard)) {
    throw staleSessionError()
  }
  try {
    return await api.flushQueue({ baseUrl: context.iotBaseUrl, token: context.wearableToken, scope })
  } catch (error) {
    if (!invocationIsCurrent(invocation, candidateSession, externalGuard)) throw staleSessionError()
    const unauthorized = Number(error?.statusCode) === 401 ||
      Number(error?.code) === 401 || Number(error?.response?.code) === 401
    if (!unauthorized || !canRenewPatientSession(appContext())) throw error
    // A 401 is the last point at which it is still safe to renew.  Both the
    // app auth provenance and the caller's external ownership guard must be
    // current; the bridge deliberately does not know about BLE manager state.
    if (!invocationIsCurrent(invocation, candidateSession, externalGuard)) throw staleSessionError()
    const renewed = await renewPatientSession(context.deviceRef, context.wearableSessionId, context.patientRef)
    if (!authIdentityIsCurrent(invocation.auth) ||
      !operationGuardIsCurrent(externalGuard) ||
      !isCurrentSessionSnapshot(renewed)) throw staleSessionError()
    if (!authIdentityIsCurrent(invocation.auth) || !operationGuardIsCurrent(externalGuard)) throw staleSessionError()
    api.rebindQueueSession({
      patientRef: context.patientRef,
      deviceRef: context.deviceRef,
      fromSessionId: context.wearableSessionId,
      toSessionId: renewed.wearableSessionId
    })
    if (!authIdentityIsCurrent(invocation.auth) || !operationGuardIsCurrent(externalGuard)) throw staleSessionError()
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
