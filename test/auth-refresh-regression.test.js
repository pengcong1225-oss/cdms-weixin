const assert = require('assert')

const requests = []
const globalData = {
  cdmsBaseUrl: 'https://cdms.example.com',
  accessToken: 'expired-token',
  refreshToken: 'refresh-token',
  patientRef: 'patient-1',
  activeRole: 'PATIENT'
}
let savedSession = null

global.getApp = () => ({
  globalData,
  saveAuth: session => { savedSession = session }
})
global.wx = {
  request (options) {
    requests.push(options)
    if (options.url.endsWith('/api/v1/miniapp/auth/refresh')) {
      options.success({ statusCode: 200, data: { data: {
        token: 'fresh-token', refreshToken: 'fresh-refresh', activeRole: 'PATIENT'
      } } })
      return
    }
    if (options.url.endsWith('/api/v1/miniapp/iot/wearable-session')) {
      if (options.header.Authorization === 'Bearer expired-token') {
        options.success({ statusCode: 401, data: { code: 401, message: 'expired' } })
      } else {
        options.success({ statusCode: 200, data: { data: { sessionId: 'session-1' } } })
      }
      return
    }
    options.fail(new Error(`unexpected request: ${options.url}`))
  }
}

delete require.cache[require.resolve('../miniprogram/utils/api')]
const api = require('../miniprogram/utils/api')

api.createPatientWearableSession('device-1').then(() => {
  assert.strictEqual(requests.length, 3, 'expired session request must refresh and retry')
  assert.strictEqual(requests[1].url, 'https://cdms.example.com/api/v1/miniapp/auth/refresh')
  assert.strictEqual(requests[2].header.Authorization, 'Bearer fresh-token')
  assert.deepStrictEqual(savedSession, {
    token: 'fresh-token', refreshToken: 'fresh-refresh', activeRole: 'PATIENT'
  })
  console.log('Miniapp auth refresh regression passed')
}).catch(error => {
  console.error(error)
  process.exit(1)
})
