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
let refreshCalls = 0

global.getApp = () => ({
  globalData,
  saveAuth: session => { savedSession = session }
})
function createMockRequest () {
  return function mockRequest (options) {
    requests.push(options)
    if (options.url.endsWith('/api/v1/miniapp/auth/refresh')) {
      refreshCalls += 1
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
    if (options.url.endsWith('/api/v1/messages')) {
      if (options.header.Authorization === 'Bearer expired-token') {
        options.success({ statusCode: 401, data: { code: 401, message: 'expired' } })
      } else {
        options.success({ statusCode: 200, data: { data: { items: [] } } })
      }
      return
    }
    options.fail(new Error(`unexpected request: ${options.url}`))
  }
}
global.wx = {
  request: createMockRequest()
}

delete require.cache[require.resolve('../miniprogram/utils/api')]
const api = require('../miniprogram/utils/api')

Promise.all([
  api.createPatientWearableSession('device-1'),
  api.cdmsRequest('/api/v1/messages', 'GET', null, 'expired-token')
]).then(() => {
  assert.strictEqual(requests.length, 5, 'two expired requests must share one refresh and retry independently')
  assert.strictEqual(requests.filter(item => item.url.endsWith('/api/v1/miniapp/auth/refresh')).length, 1)
  assert.strictEqual(refreshCalls, 1)
  assert.strictEqual(requests[3].header.Authorization, 'Bearer fresh-token')
  assert.strictEqual(requests[4].header.Authorization, 'Bearer fresh-token')
  assert.deepStrictEqual(savedSession, {
    token: 'fresh-token', refreshToken: 'fresh-refresh', activeRole: 'PATIENT'
  })
  console.log('Miniapp auth refresh regression passed')
}).catch(error => {
  console.error(error)
  process.exit(1)
})
