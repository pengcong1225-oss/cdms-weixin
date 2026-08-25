const assert = require('assert')
const path = require('path')

const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')

function loadScenario (uploadStatuses) {
  const storage = new Map()
  const uploadRequests = []
  const sessionRequests = []
  const globalData = {
    iotBaseUrl: 'https://iot',
    cdmsBaseUrl: 'https://cdms',
    accessToken: 'cdms-access-token',
    activeRole: 'PATIENT',
    patientRef: 'patient-1',
    wearableToken: 'expired-token',
    wearableSessionId: 'session-old',
    wearableDeviceRef: 'device-1'
  }

  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request: options => {
      if (options.url === 'https://cdms/api/v1/miniapp/iot/wearable-session') {
        sessionRequests.push(options)
        options.success({
          statusCode: 200,
          data: {
            code: 200,
            data: {
              sessionId: 'session-old',
              patientRef: 'patient-1',
              deviceRef: 'device-1',
              uploadToken: 'fresh-token'
            }
          }
        })
        return
      }

      if (options.url === 'https://iot/v1/wearable-upload-batches') {
        uploadRequests.push(options)
        const statusCode = uploadStatuses[uploadRequests.length - 1]
        options.success(statusCode === 200
          ? { statusCode, data: { accepted: 1, duplicates: 0, rejected: 0 } }
          : { statusCode, data: { code: 'IoT-1002', message: '令牌已过期' } })
        return
      }

      options.fail(new Error(`unexpected request: ${options.url}`))
    }
  }

  delete require.cache[apiPath]
  delete require.cache[bridgePath]
  const api = require(apiPath)
  const bridge = require(bridgePath)
  return { api, bridge, globalData, uploadRequests, sessionRequests }
}

async function testRenewsPatientSessionAndRetriesOnce () {
  const scenario = loadScenario([401, 200])

  const result = await scenario.bridge.enqueueAndFlush({
    deviceRef: 'device-1',
    records: [{ type: 'heartRate', measuredAt: 1, value: 75 }]
  })

  assert.deepStrictEqual(result, { accepted: 1, duplicates: 0, rejected: 0 })
  assert.strictEqual(scenario.sessionRequests.length, 1)
  assert.deepStrictEqual(scenario.sessionRequests[0].data, {
    deviceRef: 'device-1',
    sessionId: 'session-old'
  })
  assert.deepStrictEqual(scenario.sessionRequests[0].header, {
    Authorization: 'Bearer cdms-access-token'
  })
  assert.strictEqual(scenario.uploadRequests.length, 2)
  assert.strictEqual(scenario.uploadRequests[0].header.Authorization, 'Bearer expired-token')
  assert.strictEqual(scenario.uploadRequests[1].header.Authorization, 'Bearer fresh-token')
  assert.strictEqual(scenario.uploadRequests[1].data.sessionId, 'session-old')
  assert.strictEqual(scenario.globalData.wearableToken, 'fresh-token')
  assert.deepStrictEqual(scenario.api.readQueue('patient-1'), [])
}

async function testDoesNotLoopAfterSecondUnauthorizedResponse () {
  const scenario = loadScenario([401, 401])

  await assert.rejects(
    () => scenario.bridge.enqueueAndFlush({
      deviceRef: 'device-1',
      records: [{ type: 'heartRate', measuredAt: 1, value: 75 }]
    }),
    error => error.statusCode === 401
  )

  assert.strictEqual(scenario.sessionRequests.length, 1)
  assert.strictEqual(scenario.uploadRequests.length, 2)
  assert.strictEqual(scenario.api.readQueue('patient-1').length, 1)
}

async function run () {
  await testRenewsPatientSessionAndRetriesOnce()
  await testDoesNotLoopAfterSecondUnauthorizedResponse()
  console.log('IoT session recovery tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
