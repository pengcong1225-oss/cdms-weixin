const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const acquisitionApiPath = path.join(root, 'miniprogram/utils/acquisition-api.js')
const apiPath = path.join(root, 'miniprogram/utils/api.js')

function installEnv (session = {}) {
  const requests = []
  const previous = { getApp: global.getApp, wx: global.wx }
  const app = { globalData: Object.assign({ cdmsBaseUrl: 'https://cdms.example', accessToken: 'jwt-token', refreshToken: 'refresh-token' }, session) }
  global.getApp = () => app
  global.wx = {
    request: options => {
      requests.push(options)
      const url = String(options.url || '')
      const data = options.method === 'POST' && url.endsWith('/acquisition-sessions')
        ? { sessionId: 'session-1', businessSessionId: 'BUS-1', status: 'CREATED', expiresAt: '2026-08-30T12:00:00' }
        : url.endsWith('/acquisition-sessions/session-1')
          ? { sessionId: 'session-1', businessSessionId: 'BUS-1', status: 'CONNECTING', expiresAt: '2026-08-30T12:00:00' }
          : url.endsWith('/wss-token')
            ? { token: 'token-1', wssUrl: 'wss://iot.example/socket', expiresAt: '2026-08-30T12:05:00' }
            : { sessionId: 'session-1', businessSessionId: 'BUS-1', status: 'CANCELLED', expiresAt: '2026-08-30T12:00:00' }
      options.success && options.success({ statusCode: 200, data: { code: 200, data } })
    }
  }
  delete require.cache[apiPath]
  delete require.cache[acquisitionApiPath]
  return {
    requests,
    cleanup () {
      global.getApp = previous.getApp
      global.wx = previous.wx
      delete require.cache[apiPath]
      delete require.cache[acquisitionApiPath]
    }
  }
}

test('acquisition api uses the authenticated cdms facade for all operations', async () => {
  const env = installEnv()
  try {
    const acquisitionApi = require(acquisitionApiPath)
    const payload = { businessSessionId: 'BUS-1', orgId: '1972545374712086529', patientRef: '768495013408443', deviceType: 'MFA1', sourceChannel: 'BLE', traceId: 'trace-1', expiresInSeconds: 600 }
    assert.strictEqual((await acquisitionApi.createSession(payload)).sessionId, 'session-1')
    assert.strictEqual((await acquisitionApi.getSession('session-1')).status, 'CONNECTING')
    assert.strictEqual((await acquisitionApi.getWssToken('session-1')).token, 'token-1')
    assert.strictEqual((await acquisitionApi.cancelSession('session-1', 'stop')).status, 'CANCELLED')
    assert.deepStrictEqual(env.requests.map(request => `${request.method} ${request.url}`), [
      'POST https://cdms.example/api/v1/miniapp/iot/acquisition-sessions',
      'GET https://cdms.example/api/v1/miniapp/iot/acquisition-sessions/session-1',
      'POST https://cdms.example/api/v1/miniapp/iot/acquisition-sessions/session-1/wss-token',
      'POST https://cdms.example/api/v1/miniapp/iot/acquisition-sessions/session-1/cancel'
    ])
    for (const request of env.requests) {
      assert.strictEqual(request.header.Authorization, 'Bearer jwt-token')
      assert.strictEqual(request.header['X-CDMS-Signature'], undefined)
      assert.strictEqual(request.header['X-CDMS-Client-Id'], undefined)
    }
    assert.strictEqual(env.requests[0].data.clientSecret, undefined)
    assert.strictEqual(env.requests[0].data.signature, undefined)
    assert.deepStrictEqual(env.requests[3].data, { reason: 'stop' })
  } finally {
    env.cleanup()
  }
})

test('acquisition api preserves opaque string ids and rejects malformed session ids', async () => {
  const env = installEnv()
  try {
    const acquisitionApi = require(acquisitionApiPath)
    await assert.rejects(() => acquisitionApi.getSession('opaque/session-1'), /会话 ID 无效/)
  } finally {
    env.cleanup()
  }
})
