const assert = require('assert')
const path = require('path')

const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')

function scenario () {
  const storage = new Map()
  const requests = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms',
    accessToken: 'patient-token',
    activeRole: 'PATIENT',
    patientRef: 'patient-1',
    iotBaseUrl: 'https://iot',
    wearableToken: 'old-token',
    wearableSessionId: 'old-session',
    wearableDeviceRef: 'device-old'
  }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request: options => {
      requests.push(options)
      if (options.url === 'https://cdms/api/v1/miniapp/iot/wearable-session') {
        options.success({ statusCode: 200, data: { data: {
          sessionId: 'new-session', patientRef: 'patient-1', deviceRef: 'device-new', uploadToken: 'new-token'
        } } })
        return
      }
      if (options.url === 'https://cdms/api/v1/miniapp/iot/wearable-session?deviceRef=device-new') {
        options.success({ statusCode: 200, data: { code: 200 } })
        return
      }
      if (options.url === 'https://cdms/api/v1/miniapp/iot/wearable-session?deviceRef=device-old') {
        options.success({ statusCode: 200, data: { code: 200 } })
        return
      }
      options.fail(new Error(`unexpected request: ${options.url}`))
    }
  }
  delete require.cache[apiPath]
  delete require.cache[bridgePath]
  return { api: require(apiPath), bridge: require(bridgePath), globalData, requests }
}

async function run () {
  const s = scenario()
  await s.bridge.ensureIoTSession('device-new')
  assert.strictEqual(s.requests.length, 1, 'device switch must not reuse the old device session')
  assert.strictEqual(s.globalData.wearableDeviceRef, 'device-new')
  assert.strictEqual(s.globalData.wearableSessionId, 'new-session')
  assert.strictEqual(typeof s.bridge.clearWearableSession, 'function')
  await s.bridge.releaseWearableSession('device-new')
  assert.strictEqual(s.requests[1].method, 'DELETE')
  assert.strictEqual(s.globalData.wearableToken, '')
  assert.strictEqual(s.globalData.wearableSessionId, '')
  console.log('IoT rebind tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
