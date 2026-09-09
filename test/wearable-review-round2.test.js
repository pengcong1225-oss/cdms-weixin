const assert = require('assert')
const path = require('path')

const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')
const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const pagePath = path.resolve(__dirname, '../miniprogram/pages/wearable/sync/index.js')
const rwfitPath = path.resolve(__dirname, '../miniprogram/utils/rwfit-sdk.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

function clearModules () {
  ;[apiPath, bridgePath, storagePath, pagePath, rwfitPath, bleManagerPath].forEach(file => {
    delete require.cache[file]
  })
}

function mockModule (file, exports) {
  require.cache[file] = { id: file, filename: file, loaded: true, exports }
}

function pageScenario ({ globalData, queue = [], rwfitConnect, bridge, bleManager } = {}) {
  let pageConfig
  global.getApp = () => ({ globalData })
  global.Page = config => { pageConfig = config }
  global.wx = {}
  mockModule(apiPath, {
    readQueue: () => queue.slice(),
    enqueue: () => true,
    flushQueue: async () => ({ accepted: 0, duplicates: 0, rejected: 0 })
  })
  mockModule(rwfitPath, {
    scan: async () => ({ stop () {} }),
    connect: rwfitConnect || (async () => ({
      syncAllHealthData: async () => ({ records: {}, errors: {} }),
      disconnect: async () => {}
    })),
    flattenRecords: () => [{ type: 'heartRate', measuredAt: 1, value: 70 }]
  })
  mockModule(bridgePath, bridge || {
    updateContext: values => Object.assign(globalData, values),
    ensureIoTSession: async deviceRef => ({
      iotBaseUrl: 'https://iot',
      wearableToken: 'token-' + deviceRef,
      wearableSessionId: 'session-' + deviceRef,
      patientRef: globalData.patientRef,
      deviceRef
    }),
    enqueueAndFlush: async () => ({ accepted: 1, duplicates: 0, rejected: 0 })
  })
  mockModule(bleManagerPath, bleManager || {})
  clearModules()
  // clearModules removes the mocks above, so install them again after clearing.
  mockModule(apiPath, {
    readQueue: () => queue.slice(),
    enqueue: () => true,
    flushQueue: async () => ({ accepted: 0, duplicates: 0, rejected: 0 })
  })
  mockModule(rwfitPath, {
    scan: async () => ({ stop () {} }),
    connect: rwfitConnect || (async () => ({
      syncAllHealthData: async () => ({ records: {}, errors: {} }),
      disconnect: async () => {}
    })),
    flattenRecords: () => [{ type: 'heartRate', measuredAt: 1, value: 70 }]
  })
  mockModule(bridgePath, bridge || {
    updateContext: values => Object.assign(globalData, values),
    ensureIoTSession: async deviceRef => ({
      iotBaseUrl: 'https://iot',
      wearableToken: 'token-' + deviceRef,
      wearableSessionId: 'session-' + deviceRef,
      patientRef: globalData.patientRef,
      deviceRef
    }),
    enqueueAndFlush: async () => ({ accepted: 1, duplicates: 0, rejected: 0 })
  })
  mockModule(bleManagerPath, bleManager || {})
  delete require.cache[pagePath]
  require(pagePath)
  const page = Object.assign({}, pageConfig)
  page.data = Object.assign({}, pageConfig.data)
  page.setData = patch => Object.assign(page.data, patch)
  return page
}

function bridgeScenario ({ globalData, request } = {}) {
  const values = new Map()
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    request
  }
  clearModules()
  return { values, bridge: require(bridgePath) }
}

function apiScenario ({ globalData = { patientRef: 'patient-1' }, request } = {}) {
  const values = new Map()
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    request: request || (options => options.success({ statusCode: 200, data: {} }))
  }
  clearModules()
  return { values, api: require(apiPath) }
}

async function c1AlwaysScopesEveryUpload () {
  const ensureCalls = []
  const uploadScopes = []
  const globalData = {
    patientRef: 'patient-1',
    wearableToken: 'token-ring-a',
    wearableSessionId: 'session-ring-a',
    wearableDeviceRef: 'ring-a'
  }
  const sdk = {
    syncAllHealthData: async () => {
      // Simulate a late foreground context update while B is still syncing.
      globalData.wearableDeviceRef = 'ring-a'
      globalData.wearableToken = 'token-ring-a'
      return { records: { heartRate: [{ measuredAt: 1, value: 70 }] }, errors: {} }
    },
    disconnect: async () => {}
  }
  const page = pageScenario({
    globalData,
    rwfitConnect: async () => sdk,
    bleManager: {
      connect: async () => ({ deviceId: 'ring-b' }),
      getSdk: () => sdk,
      disconnect: async () => {}
    },
    bridge: {
      updateContext: values => Object.assign(globalData, values),
      ensureIoTSession: async deviceRef => {
        ensureCalls.push(deviceRef)
        return {
          iotBaseUrl: 'https://iot', wearableToken: 'token-ring-b',
          wearableSessionId: 'session-ring-b', patientRef: 'patient-1', deviceRef
        }
      },
      enqueueAndFlush: async options => {
        uploadScopes.push(options.syncScope)
        return { accepted: 1, duplicates: 0, rejected: 0 }
      }
    }
  })
  page.onLoad({})
  page.selectDevice({ currentTarget: { dataset: { id: 'ring-b' } } })
  await page.startSync()
  assert.deepStrictEqual(ensureCalls, ['ring-b'], 'upload must resolve a session for the selected device even when an old token exists')
  assert.deepStrictEqual(uploadScopes[0], {
    patientRef: 'patient-1', deviceRef: 'ring-b', sessionId: 'session-ring-b'
  }, 'upload must use the immutable B scope captured before the global context changed')
}

async function c2SlowEnsureCannotPublishAfterFastDeviceSwitch () {
  const pending = {}
  const globalData = {
    cdmsBaseUrl: 'https://cdms', accessToken: 'access-token', activeRole: 'PATIENT', patientRef: 'patient-1',
    iotBaseUrl: '', wearableToken: '', wearableSessionId: '', wearableDeviceRef: ''
  }
  const scenario = bridgeScenario({
    globalData,
    request: options => {
      const deviceRef = options.data.deviceRef
      if (deviceRef === 'ring-a') {
        pending[deviceRef] = options
        return
      }
      setImmediate(() => options.success({ statusCode: 200, data: { data: {
        sessionId: 'session-ring-b', patientRef: 'patient-1', deviceRef: 'ring-b', uploadToken: 'token-ring-b', iotBaseUrl: 'https://iot-b'
      } } }))
    }
  })
  const slow = scenario.bridge.ensureIoTSession('ring-a')
  const fast = await scenario.bridge.ensureIoTSession('ring-b')
  pending['ring-a'].success({ statusCode: 200, data: { data: {
    sessionId: 'session-ring-a', patientRef: 'patient-1', deviceRef: 'ring-a', uploadToken: 'token-ring-a', iotBaseUrl: 'https://iot-a'
  } } })
  const stale = await slow
  assert.strictEqual(fast.deviceRef, 'ring-b')
  assert.strictEqual(stale.deviceRef, 'ring-a')
  assert.strictEqual(globalData.wearableDeviceRef, 'ring-b', 'late A response must not publish over the newer B context')
  assert.strictEqual(globalData.wearableToken, 'token-ring-b')
}

async function c2EnsureCannotPublishAfterPatientSwitch () {
  let resolveRequest
  const globalData = {
    cdmsBaseUrl: 'https://cdms', accessToken: 'access-token', activeRole: 'PATIENT', patientRef: 'patient-a',
    iotBaseUrl: '', wearableToken: '', wearableSessionId: '', wearableDeviceRef: ''
  }
  const scenario = bridgeScenario({
    globalData,
    request: options => { resolveRequest = options }
  })
  const request = scenario.bridge.ensureIoTSession('ring-a')
  globalData.patientRef = 'patient-b'
  resolveRequest.success({ statusCode: 200, data: { data: {
    sessionId: 'session-ring-a', patientRef: 'patient-a', deviceRef: 'ring-a', uploadToken: 'token-a', iotBaseUrl: 'https://iot'
  } } })
  const snapshot = await request
  assert.strictEqual(snapshot.patientRef, 'patient-a')
  assert.strictEqual(globalData.patientRef, 'patient-b', 'late A response must not restore the old patient context')
  assert.strictEqual(globalData.wearableToken, '')
}

async function c2LateRenewCannotUploadAfterDeviceSwitch () {
  let pendingRenew
  let resolveRenewStarted
  const renewStarted = new Promise(resolve => { resolveRenewStarted = resolve })
  const uploads = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms', iotBaseUrl: 'https://iot-a', accessToken: 'access-token', activeRole: 'PATIENT', patientRef: 'patient-1',
    wearableToken: 'old-token', wearableSessionId: 'old-session', wearableDeviceRef: 'ring-a'
  }
  const scenario = bridgeScenario({
    globalData,
    request: options => {
      if (options.url.endsWith('/wearable-session')) {
        pendingRenew = options
        resolveRenewStarted()
        return
      }
      uploads.push(options)
      options.success({ statusCode: 401, data: { code: 401, message: 'expired' } })
    }
  })
  const uploading = scenario.bridge.enqueueAndFlush({
    deviceRef: 'ring-a',
    records: [{ type: 'heartRate', value: 70, measuredAt: 1 }]
  })
  await renewStarted
  Object.assign(globalData, {
    wearableDeviceRef: 'ring-b', deviceRef: 'ring-b',
    wearableSessionId: 'session-b', wearableToken: 'token-b', iotBaseUrl: 'https://iot-b'
  })
  pendingRenew.success({ statusCode: 200, data: { data: {
    sessionId: 'renewed-a', patientRef: 'patient-1', deviceRef: 'ring-a', uploadToken: 'renewed-token-a', iotBaseUrl: 'https://iot-a'
  } } })
  await assert.rejects(() => uploading, /上下文已切换/)
  assert.strictEqual(uploads.length, 1, 'late A renewal must not upload with A after B becomes current')
  assert.strictEqual(globalData.wearableDeviceRef, 'ring-b')
  assert.strictEqual(globalData.wearableToken, 'token-b')
}

async function c2EnsureCannotPublishAfterSamePatientRelogin () {
  let resolveRequest
  const globalData = {
    cdmsBaseUrl: 'https://cdms', accessToken: 'access-old', identityId: 'identity-old', activeRole: 'PATIENT', patientRef: 'patient-1',
    iotBaseUrl: '', wearableToken: '', wearableSessionId: '', wearableDeviceRef: ''
  }
  const scenario = bridgeScenario({
    globalData,
    request: options => { resolveRequest = options }
  })
  const pending = scenario.bridge.ensureIoTSession('ring-a')
  // Logout + login of the same patient keeps the patientRef but changes the
  // authenticated identity; the old response must not seed the new session.
  Object.assign(globalData, { accessToken: 'access-new', identityId: 'identity-new' })
  resolveRequest.success({ statusCode: 200, data: { data: {
    sessionId: 'session-ring-a', patientRef: 'patient-1', deviceRef: 'ring-a', uploadToken: 'token-ring-a', iotBaseUrl: 'https://iot-a'
  } } })
  const snapshot = await pending
  assert.strictEqual(snapshot.deviceRef, 'ring-a')
  assert.strictEqual(globalData.wearableToken, '', 'old identity response must not publish after same-patient relogin')
}

async function c7MigratesFullyScopedLegacyBatches () {
  const scenario = apiScenario()
  scenario.values.set(scenario.api.queueStorageKey('patient-1'), [
    { batchId: 'legacy-scoped', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
  ])
  assert.deepStrictEqual(scenario.api.readQueue('patient-1', 'ring-a', 'session-a').map(item => item.batchId), ['legacy-scoped'])
  assert.deepStrictEqual((scenario.values.get(scenario.api.queueStorageKey({
    patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a'
  })) || []).map(item => item.batchId), ['legacy-scoped'], 'fully scoped legacy batch must be moved to its exact key')
  assert.deepStrictEqual(scenario.values.get(scenario.api.queueStorageKey('patient-1')) || [], [], 'legacy source queue must no longer own migrated data')
  // A second read is part of the migration contract: it must not duplicate the
  // destination or resurrect the already-cleared source queue.
  assert.deepStrictEqual(scenario.api.readQueue('patient-1', 'ring-a', 'session-a').map(item => item.batchId), ['legacy-scoped'])
  assert.deepStrictEqual((scenario.values.get(scenario.api.queueStorageKey({
    patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a'
  })) || []).map(item => item.batchId), ['legacy-scoped'])
}

async function c7MigratesLegacyModeQueueForKnownPatient () {
  const scenario = apiScenario({ globalData: { patientRef: 'patient-1', mode: 'PATIENT' } })
  const modeKey = scenario.api.queueStorageKey('PATIENT')
  scenario.values.set(modeKey, [
    { batchId: 'mode-scoped', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
  ])
  assert.deepStrictEqual(scenario.api.readQueue('patient-1', 'ring-a', 'session-a').map(item => item.batchId), ['mode-scoped'])
  assert.deepStrictEqual(scenario.values.get(modeKey) || [], [], 'legacy mode key must be cleared after migration')
}

async function c7DoesNotMixTwoSessionsForOneDevice () {
  const uploads = []
  const scenario = apiScenario({
    request: options => {
      uploads.push(options.data)
      options.success({ statusCode: 200, data: { accepted: 1, duplicates: 0, rejected: 0 } })
    }
  })
  scenario.api.enqueue({ batchId: 'a-1', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
  scenario.api.enqueue({ batchId: 'a-2', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-b' })
  await scenario.api.flushQueue({
    baseUrl: 'https://iot', token: 'token-a',
    scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
  })
  assert.deepStrictEqual(uploads.map(item => item.sessionId), ['session-a'])
  assert.deepStrictEqual(scenario.api.readQueue('patient-1', 'ring-a', 'session-b').map(item => item.batchId), ['a-2'])
}

async function c3UsesTheSharedBleManager () {
  let directConnectCalls = 0
  let sharedConnectCalls = 0
  const globalData = { patientRef: 'patient-1', wearableToken: '', wearableSessionId: '', wearableDeviceRef: '' }
  const sdk = {
    syncAllHealthData: async () => ({ records: { heartRate: [{ measuredAt: 1, value: 70 }] }, errors: {} }),
    disconnect: async () => {}
  }
  const page = pageScenario({
    globalData,
    rwfitConnect: async () => { directConnectCalls += 1; return sdk },
    bleManager: {
      connect: async target => { sharedConnectCalls += 1; assert.strictEqual(target.deviceId, 'ring-b'); return { deviceId: 'ring-b' } },
      getSdk: () => sdk,
      disconnect: async () => {}
    }
  })
  page.onLoad({})
  page.selectDevice({ currentTarget: { dataset: { id: 'ring-b' } } })
  await page.startSync()
  assert.strictEqual(sharedConnectCalls, 1, 'sync page must connect through the singleton BLE manager')
  assert.strictEqual(directConnectCalls, 0, 'sync page must not create a second BLE connection')
}

async function c4ClaimsLegacyBindingOnlyInPatientScope () {
  const values = new Map([['rwsdk.boundDevice.v1', { deviceId: 'legacy-ring', name: 'Legacy' }]])
  const globalData = { activeRole: '', patientRef: '' }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key)
  }
  clearModules()
  const storage = require(storagePath)

  assert.deepStrictEqual(storage.listBoundDevices(), [], 'unauthenticated storage reads must not expose legacy bindings')
  assert.strictEqual(values.has('rwsdk.boundDevice.v1'), true, 'legacy binding must remain until a patient scope is known')

  globalData.activeRole = 'PATIENT'
  globalData.patientRef = 'patient-a'
  assert.deepStrictEqual(storage.listBoundDevices().map(item => item.deviceId), ['legacy-ring'])
  assert.strictEqual(values.has('rwsdk.boundDevice.v1'), false)

  globalData.patientRef = 'patient-b'
  assert.deepStrictEqual(storage.listBoundDevices().map(item => item.deviceId), [], 'another patient must not see the claimed legacy binding')
}

async function c4DoesNotExposeOwnerlessV2AcrossPatients () {
  const values = new Map([['rwsdk.boundDevice.v2', [{ deviceId: 'orphan-ring' }]]])
  const globalData = { activeRole: 'PATIENT', patientRef: 'patient-b' }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key)
  }
  clearModules()
  const storage = require(storagePath)
  assert.deepStrictEqual(storage.listBoundDevices('patient-b'), [])
}

async function c5RetryRejectsWithoutUniqueDevice () {
  const ensureCalls = []
  const queue = []
  const page = pageScenario({
    globalData: { patientRef: 'patient-1', wearableToken: 'old-token' },
    queue,
    bridge: {
      updateContext: () => {},
      ensureIoTSession: async deviceRef => { ensureCalls.push(deviceRef); return { deviceRef, patientRef: 'patient-1', wearableToken: 'token', wearableSessionId: 'session', iotBaseUrl: 'https://iot' } },
      enqueueAndFlush: async () => ({ accepted: 0, duplicates: 0, rejected: 0 })
    }
  })
  page.onLoad({})
  await assert.rejects(() => page.retry(), /无法确定.*设备/)
  assert.deepStrictEqual(ensureCalls, [], 'retry must not create a fake sentinel-device session')
  assert.deepStrictEqual(queue, [])
}

async function c5RetryUsesTheOnlyQueuedDevice () {
  const ensureCalls = []
  const flushCalls = []
  const queue = [{ batchId: 'queued', patientRef: 'patient-1', deviceRef: 'ring-b', sessionId: 'session-b' }]
  const page = pageScenario({
    globalData: { patientRef: 'patient-1', wearableToken: '' },
    queue,
    bridge: {
      updateContext: () => {},
      ensureIoTSession: async deviceRef => { ensureCalls.push(deviceRef); return { deviceRef, patientRef: 'patient-1', wearableToken: 'token-b', wearableSessionId: 'session-b', iotBaseUrl: 'https://iot' } },
      enqueueAndFlush: async () => ({ accepted: 0, duplicates: 0, rejected: 0 })
    }
  })
  // Replace the page-local API mock so retry's exact flush can be inspected.
  const api = require(apiPath)
  api.flushQueue = async options => { flushCalls.push(options); return { accepted: 1, duplicates: 0, rejected: 0 } }
  page.onLoad({})
  await page.retry()
  assert.deepStrictEqual(ensureCalls, ['ring-b'])
  assert.strictEqual(flushCalls[0].scope.deviceRef, 'ring-b')
  assert.strictEqual(flushCalls[0].scope.sessionId, 'session-b')
}

async function c6NormalizesBusinessUnauthorizedStatus () {
  const scenario = apiScenario({
    request: options => options.success({ statusCode: 200, data: { code: 401, message: 'expired' } })
  })
  await assert.rejects(() => scenario.api.request('https://iot/upload', 'POST', {}, 'token'), error => {
    assert.strictEqual(error.statusCode, 401)
    assert.strictEqual(error.code, 401)
    return true
  })
}

async function c6BridgeRenewsOnBusinessUnauthorized () {
  const uploads = []
  const sessions = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms', iotBaseUrl: 'https://iot', accessToken: 'access-token', activeRole: 'PATIENT', patientRef: 'patient-1',
    wearableToken: 'old-token', wearableSessionId: 'old-session', wearableDeviceRef: 'ring-a'
  }
  const scenario = bridgeScenario({
    globalData,
    request: options => {
      if (options.url.endsWith('/wearable-session')) {
        sessions.push(options)
        options.success({ statusCode: 200, data: { data: {
          sessionId: 'new-session', patientRef: 'patient-1', deviceRef: 'ring-a', uploadToken: 'new-token', iotBaseUrl: 'https://iot'
        } } })
        return
      }
      uploads.push(options)
      options.success(uploads.length === 1
        ? { statusCode: 200, data: { code: 401, message: 'expired' } }
        : { statusCode: 200, data: { accepted: 1, duplicates: 0, rejected: 0 } })
    }
  })
  const result = await scenario.bridge.enqueueAndFlush({ deviceRef: 'ring-a', records: [{ type: 'heartRate', value: 70, measuredAt: 1 }] })
  assert.deepStrictEqual(result, { accepted: 1, duplicates: 0, rejected: 0 })
  assert.strictEqual(sessions.length, 1)
  assert.strictEqual(uploads.length, 2)
}

async function c7KeepsIncompleteLegacyBatchOutOfExactFlush () {
  const requests = []
  const scenario = apiScenario({
    request: options => { requests.push(options); options.success({ statusCode: 200, data: { accepted: 1 } }) }
  })
  scenario.values.set(scenario.api.queueStorageKey('patient-1'), [
    { batchId: 'missing-session', patientRef: 'patient-1', deviceRef: 'ring-a' }
  ])
  await assert.rejects(() => scenario.api.flushQueue({
    baseUrl: 'https://iot', token: 'token-a',
    scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
  }), error => error.code === 'QUEUE_SCOPE_MISMATCH')
  assert.strictEqual(requests.length, 0)
  assert.strictEqual(scenario.values.get(scenario.api.queueStorageKey('patient-1')).length, 1)
}

async function c7RejectsPatientOnlyFlushScope () {
  const requests = []
  const scenario = apiScenario({
    request: options => { requests.push(options); options.success({ statusCode: 200, data: { accepted: 1 } }) }
  })
  scenario.api.enqueue({ batchId: 'patient-only', patientRef: 'patient-1', records: [] })
  await assert.rejects(() => scenario.api.flushQueue({
    baseUrl: 'https://iot', token: 'token-a', scope: 'patient-1'
  }), error => error.code === 'QUEUE_SCOPE_REQUIRED')
  assert.strictEqual(requests.length, 0, 'patient-only flush must fail closed before any upload request')
  assert.strictEqual(scenario.api.readQueue('patient-1').length, 1, 'rejected queue must remain intact')
}

async function c7RecoversExactQueueIndex () {
  const values = new Map()
  const exactKey = 'cdms.iot.wearable.upload.queue.patient-1.ring-a.session-a'
  values.set(exactKey, [{ batchId: 'a-1', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }])
  global.getApp = () => ({ globalData: { patientRef: 'patient-1' } })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    getStorageInfoSync: () => ({ keys: [exactKey] })
  }
  clearModules()
  const api = require(apiPath)
  assert.deepStrictEqual(api.listQueueScopes(), [{ key: exactKey, patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }])
}

async function c8RejectsAmbiguousUnbindWhileConnecting () {
  const values = new Map()
  const globalData = { activeRole: 'PATIENT', patientRef: 'patient-1' }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete()
  }
  clearModules()
  const storage = require(storagePath)
  const bridge = require(bridgePath)
  const manager = require(bleManagerPath)
  storage.saveBoundDevice({ deviceId: 'ring-a' })
  storage.saveBoundDevice({ deviceId: 'ring-b' })
  manager.state.boundDevice = storage.getBoundDevice('ring-a', 'patient-1')
  manager.activeDeviceId = 'ring-b'
  manager.connectingDeviceId = 'ring-b'
  manager.connectPromise = Promise.resolve()
  const releases = []
  bridge.releaseWearableSession = async deviceRef => { releases.push(deviceRef) }
  await assert.rejects(() => manager.unbind(), /连接进行中.*明确.*设备/)
  assert.deepStrictEqual(releases, [])
  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['ring-a', 'ring-b'])
}

async function c8ExplicitUnbindTargetsRequestedDevice () {
  const values = new Map()
  const globalData = { activeRole: 'PATIENT', patientRef: 'patient-1' }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete()
  }
  clearModules()
  const storage = require(storagePath)
  const bridge = require(bridgePath)
  const manager = require(bleManagerPath)
  storage.saveBoundDevice({ deviceId: 'ring-a' })
  storage.saveBoundDevice({ deviceId: 'ring-b' })
  manager.state.boundDevice = storage.getBoundDevice('ring-a', 'patient-1')
  manager.activeDeviceId = 'ring-a'
  const releases = []
  bridge.releaseWearableSession = async deviceRef => { releases.push(deviceRef) }
  await manager.unbind('ring-b')
  assert.deepStrictEqual(releases, ['ring-b'])
  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['ring-a'])
}

async function c8ExplicitUnbindDuringConnectKeepsActiveDevice () {
  const values = new Map()
  const globalData = { activeRole: 'PATIENT', patientRef: 'patient-1' }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete()
  }
  clearModules()
  const storage = require(storagePath)
  const bridge = require(bridgePath)
  const manager = require(bleManagerPath)
  storage.saveBoundDevice({ deviceId: 'ring-a' })
  storage.saveBoundDevice({ deviceId: 'ring-b' })
  manager.state.boundDevice = storage.getBoundDevice('ring-a', 'patient-1')
  manager.activeDeviceId = 'ring-a'
  manager.connectingDeviceId = 'ring-b'
  manager.connectPromise = Promise.resolve()
  const releases = []
  bridge.releaseWearableSession = async deviceRef => { releases.push(deviceRef) }
  await manager.unbind('ring-b')
  assert.deepStrictEqual(releases, ['ring-b'])
  assert.strictEqual(manager.activeDeviceId, 'ring-a', 'explicit B unbind must not disconnect active A')
  assert.strictEqual(manager.state.boundDevice.deviceId, 'ring-a')
  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['ring-a'])
}

async function run () {
  const cases = [
    ['C1 always scopes every upload', c1AlwaysScopesEveryUpload],
    ['C2 slow ensure cannot publish after fast device switch', c2SlowEnsureCannotPublishAfterFastDeviceSwitch],
    ['C2 ensure cannot publish after patient switch', c2EnsureCannotPublishAfterPatientSwitch],
    ['C2 late renew cannot upload after device switch', c2LateRenewCannotUploadAfterDeviceSwitch],
    ['C2 ensure cannot publish after same-patient relogin', c2EnsureCannotPublishAfterSamePatientRelogin],
    ['C7 migrates fully scoped legacy batches', c7MigratesFullyScopedLegacyBatches],
    ['C7 migrates legacy mode queue for known patient', c7MigratesLegacyModeQueueForKnownPatient],
    ['C7 does not mix two sessions for one device', c7DoesNotMixTwoSessionsForOneDevice],
    ['C3 uses the shared BLE manager', c3UsesTheSharedBleManager],
    ['C4 claims legacy binding only in patient scope', c4ClaimsLegacyBindingOnlyInPatientScope],
    ['C4 does not expose ownerless V2 across patients', c4DoesNotExposeOwnerlessV2AcrossPatients],
    ['C5 retry rejects without a unique device', c5RetryRejectsWithoutUniqueDevice],
    ['C5 retry uses the only queued device', c5RetryUsesTheOnlyQueuedDevice],
    ['C6 normalizes business unauthorized status', c6NormalizesBusinessUnauthorizedStatus],
    ['C6 bridge renews on business unauthorized', c6BridgeRenewsOnBusinessUnauthorized],
    ['C7 keeps incomplete legacy batch out of exact flush', c7KeepsIncompleteLegacyBatchOutOfExactFlush],
    ['C7 rejects patient-only flush scope', c7RejectsPatientOnlyFlushScope],
    ['C7 recovers exact queue index', c7RecoversExactQueueIndex],
    ['C8 rejects ambiguous unbind while connecting', c8RejectsAmbiguousUnbindWhileConnecting],
    ['C8 explicit unbind targets requested device', c8ExplicitUnbindTargetsRequestedDevice],
    ['C8 explicit unbind during connect keeps active device', c8ExplicitUnbindDuringConnectKeepsActiveDevice]
  ]
  let failures = 0
  for (const [name, scenario] of cases) {
    try {
      await scenario()
      console.log(`PASS ${name}`)
    } catch (error) {
      failures += 1
      console.error(`RED ${name}: ${error.message}`)
    }
  }
  if (failures) process.exitCode = 1
}

run().catch(error => {
  console.error(error)
  process.exitCode = 1
})
