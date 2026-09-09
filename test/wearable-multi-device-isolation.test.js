const assert = require('assert')
const path = require('path')
const test = require('node:test')

const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')

function resetModules () {
  ;[storagePath, apiPath, bridgePath].forEach(file => { delete require.cache[file] })
}

function installStorageEnv (globalData = {}) {
  const values = new Map()
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key)
  }
  resetModules()
  return { values, globalData, storage: require(storagePath) }
}

test('stores multiple bound rings per patient and removes only the target ring', () => {
  const { storage } = installStorageEnv({ activeRole: 'PATIENT', patientRef: 'patient-1' })
  assert.strictEqual(typeof storage.listBoundDevices, 'function', 'storage must expose a patient-scoped binding collection')
  assert.strictEqual(typeof storage.getBoundDevice, 'function')
  assert.strictEqual(typeof storage.clearBoundDevice, 'function')
  storage.saveBoundDevice({ deviceId: 'ring-a', name: 'A' })
  storage.saveBoundDevice({ deviceId: 'ring-b', name: 'B' })

  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['ring-a', 'ring-b'])
  assert.strictEqual(storage.getBoundDevice('ring-a', 'patient-1').name, 'A')
  storage.clearBoundDevice('ring-a', 'patient-1')
  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['ring-b'])
})

test('migrates the legacy single bound ring once without dropping it', () => {
  const values = new Map([
    ['rwsdk.boundDevice.v1', { deviceId: 'legacy-ring', name: 'Legacy' }]
  ])
  global.getApp = () => ({ globalData: { activeRole: 'PATIENT', patientRef: 'patient-1' } })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key)
  }
  resetModules()
  const storage = require(storagePath)

  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['legacy-ring'])
  assert.strictEqual(values.has('rwsdk.boundDevice.v1'), false)
  assert.ok(Array.isArray(values.get('rwsdk.boundDevice.v2')))
  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['legacy-ring'])
})

test('appends upload batches into independent patient-device queues', () => {
  const { storage } = installStorageEnv({ activeRole: 'PATIENT', patientRef: 'patient-1' })
  const api = require(apiPath)
  assert.strictEqual(typeof api.listQueueScopes, 'function', 'api must expose independent queue scopes')
  api.enqueue({ batchId: 'a-1', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
  api.enqueue({ batchId: 'a-2', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
  api.enqueue({ batchId: 'b-1', patientRef: 'patient-1', deviceRef: 'ring-b', sessionId: 'session-b' })

  assert.deepStrictEqual(api.readQueue('patient-1', 'ring-a').map(item => item.batchId), ['a-1', 'a-2'])
  assert.deepStrictEqual(api.readQueue('patient-1', 'ring-b').map(item => item.batchId), ['b-1'])
  assert.ok(storage, 'storage environment remains installed for this scenario')
})

test('returns immutable device-scoped IoT session snapshots after switching devices', async () => {
  const values = new Map()
  const globalData = {
    cdmsBaseUrl: 'https://cdms',
    accessToken: 'access-token',
    activeRole: 'PATIENT',
    patientRef: 'patient-1',
    wearableToken: '',
    wearableSessionId: '',
    wearableDeviceRef: ''
  }
  const sessionRequests = []
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    request: options => {
      sessionRequests.push(options)
      const deviceRef = options.data && options.data.deviceRef
      options.success({ statusCode: 200, data: { data: {
        sessionId: `session-${deviceRef}`,
        patientRef: 'patient-1',
        deviceRef,
        uploadToken: `token-${deviceRef}`,
        iotBaseUrl: `https://iot-${deviceRef}`
      } } })
    }
  }
  resetModules()
  const bridge = require(bridgePath)
  const sessionA = await bridge.ensureIoTSession('ring-a')
  const sessionB = await bridge.ensureIoTSession('ring-b')

  assert.notStrictEqual(sessionA, sessionB)
  assert.strictEqual(sessionA.deviceRef, 'ring-a')
  assert.strictEqual(sessionA.wearableSessionId, 'session-ring-a')
  assert.strictEqual(sessionA.wearableToken, 'token-ring-a')
  assert.strictEqual(sessionB.deviceRef, 'ring-b')
  assert.strictEqual(sessionB.wearableSessionId, 'session-ring-b')
  assert.strictEqual(sessionA.wearableSessionId, 'session-ring-a')
  assert.strictEqual(sessionA.wearableToken, 'token-ring-a')
  assert.strictEqual(sessionRequests.length, 2)
})

test('creates a new IoT session id on 401 recovery instead of reusing the expired id', async () => {
  const values = new Map()
  const globalData = {
    cdmsBaseUrl: 'https://cdms',
    iotBaseUrl: 'https://iot',
    accessToken: 'access-token',
    activeRole: 'PATIENT',
    patientRef: 'patient-1',
    wearableToken: 'expired-token',
    wearableSessionId: 'session-old',
    wearableDeviceRef: 'ring-a'
  }
  const sessionRequests = []
  const uploadRequests = []
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    request: options => {
      if (options.url.endsWith('/wearable-session')) {
        sessionRequests.push(options)
        options.success({ statusCode: 200, data: { data: {
          sessionId: 'session-new', patientRef: 'patient-1', deviceRef: 'ring-a', uploadToken: 'fresh-token', iotBaseUrl: 'https://iot'
        } } })
        return
      }
      if (options.url.endsWith('/wearable-upload-batches')) {
        uploadRequests.push(options)
        options.success({ statusCode: 401, data: { code: 'IoT-1002', message: '令牌已过期' } })
        return
      }
      options.fail(new Error(`unexpected request: ${options.url}`))
    }
  }
  resetModules()
  const bridge = require(bridgePath)
  await assert.rejects(() => bridge.enqueueAndFlush({
    deviceRef: 'ring-a',
    records: [{ type: 'heartRate', measuredAt: 1, value: 75 }]
  }), error => error.statusCode === 401)

  assert.strictEqual(sessionRequests.length, 1)
  assert.notStrictEqual(sessionRequests[0].data.sessionId, 'session-old')
  assert.strictEqual(uploadRequests.length, 2)
})
