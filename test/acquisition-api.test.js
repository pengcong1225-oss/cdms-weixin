const assert = require('assert')
const crypto = require('crypto')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const acquisitionApiPath = path.join(root, 'miniprogram/utils/acquisition-api.js')
const apiPath = path.join(root, 'miniprogram/utils/api.js')

function installEnv (session = {}) {
  const requests = []
  const previous = {
    getApp: global.getApp,
    wx: global.wx
  }
  global.getApp = () => ({
    globalData: Object.assign({
      iotBaseUrl: 'https://iot.example',
      acquisitionClientId: 'miniapp-client',
      acquisitionClientSecret: 'client-secret'
    }, session)
  })
  global.wx = {
    request: options => {
      requests.push(options)
      const url = String(options.url || '')
      if (url.endsWith('/v1/acquisition-sessions') && options.method === 'POST') {
        options.success && options.success({
          statusCode: 201,
          data: {
            sessionId: 'session-1',
            businessSessionId: 'BUS-1',
            status: 'CREATED',
            expiresAt: '2026-08-29T12:00:00',
            captureId: null,
            failureCode: null,
            failureMessage: null
          }
        })
        return
      }
      if (url.endsWith('/v1/acquisition-sessions/session-1') && options.method === 'GET') {
        options.success && options.success({
          statusCode: 200,
          data: {
            sessionId: 'session-1',
            businessSessionId: 'BUS-1',
            status: 'CONNECTING',
            expiresAt: '2026-08-29T12:00:00',
            captureId: 'capture-1',
            failureCode: null,
            failureMessage: null
          }
        })
        return
      }
      if (url.endsWith('/v1/acquisition-sessions/session-1/wss-token') && options.method === 'POST') {
        options.success && options.success({
          statusCode: 200,
          data: {
            token: 'token-1',
            wssUrl: 'wss://iot.example/socket',
            expiresAt: '2026-08-29T12:05:00'
          }
        })
        return
      }
      if (url.endsWith('/v1/acquisition-sessions/session-1/cancel') && options.method === 'POST') {
        options.success && options.success({
          statusCode: 200,
          data: {
            sessionId: 'session-1',
            businessSessionId: 'BUS-1',
            status: 'CANCELLED',
            expiresAt: '2026-08-29T12:00:00',
            captureId: null,
            failureCode: 'CANCELLED',
            failureMessage: 'cancelled'
          }
        })
        return
      }
      options.fail && options.fail(new Error(`unexpected request: ${options.method} ${options.url}`))
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

function expectedSignature (secret, method, pathValue, timestamp, nonce, rawBody) {
  const canonical = [
    String(method).toUpperCase(),
    pathValue,
    timestamp,
    nonce,
    crypto.createHash('sha256').update(rawBody || '', 'utf8').digest('hex')
  ].join('\n')
  return crypto.createHmac('sha256', secret).update(canonical, 'utf8').digest('hex')
}

test('acquisition api signs create/get/token/cancel requests with the configured HMAC client', async () => {
  const env = installEnv()
  try {
    const acquisitionApi = require(acquisitionApiPath)
    const created = await acquisitionApi.createSession({
      businessSessionId: 'BUS-1',
      orgId: '1972545374712086529',
      patientRef: '768495013408443',
      deviceType: 'MFA1',
      sourceChannel: 'BLE',
      traceId: 'trace-1',
      expiresInSeconds: 600
    })
    assert.strictEqual(created.sessionId, 'session-1')

    const createRequest = env.requests[0]
    const createBody = JSON.parse(createRequest.data)
    assert.strictEqual(createBody.clientId, 'miniapp-client')
    assert.ok(createBody.timestamp)
    assert.ok(createBody.nonce)
    assert.ok(createBody.signature)
    const createRaw = JSON.stringify(Object.assign({}, createBody, { signature: undefined }))
    delete createBody.signature
    const createExpected = expectedSignature(
      'client-secret',
      'POST',
      '/v1/acquisition-sessions',
      createBody.timestamp,
      createBody.nonce,
      createRaw
    )
    assert.strictEqual(JSON.parse(createRequest.data).signature, createExpected)

    const session = await acquisitionApi.getSession('session-1')
    assert.strictEqual(session.status, 'CONNECTING')
    const sessionRequest = env.requests[1]
    const sessionHeaders = sessionRequest.header
    const sessionTimestamp = sessionHeaders['X-CDMS-Timestamp']
    const sessionNonce = sessionHeaders['X-CDMS-Nonce']
    assert.strictEqual(
      sessionHeaders['X-CDMS-Signature'],
      expectedSignature('client-secret', 'GET', '/v1/acquisition-sessions/session-1', sessionTimestamp, sessionNonce, '')
    )

    const token = await acquisitionApi.getWssToken('session-1')
    assert.strictEqual(token.token, 'token-1')
    const tokenRequest = env.requests[2]
    assert.strictEqual(
      tokenRequest.header['X-CDMS-Signature'],
      expectedSignature('client-secret', 'POST', '/v1/acquisition-sessions/session-1/wss-token', tokenRequest.header['X-CDMS-Timestamp'], tokenRequest.header['X-CDMS-Nonce'], '')
    )

    const retryToken = await acquisitionApi.retrySession('session-1')
    assert.strictEqual(retryToken.token, 'token-1')

    const cancelled = await acquisitionApi.cancelSession('session-1', 'stop')
    assert.strictEqual(cancelled.status, 'CANCELLED')
    const cancelRequest = env.requests[4]
    assert.deepStrictEqual(cancelRequest.data, { reason: 'stop' })
    assert.strictEqual(
      cancelRequest.header['X-CDMS-Signature'],
      expectedSignature('client-secret', 'POST', '/v1/acquisition-sessions/session-1/cancel', cancelRequest.header['X-CDMS-Timestamp'], cancelRequest.header['X-CDMS-Nonce'], '')
    )

    const launched = await acquisitionApi.launchSession('session-1')
    assert.strictEqual(launched.token, 'token-1')
  } finally {
    env.cleanup()
  }
})

test('acquisition api rejects missing hmac secret before issuing a session', async () => {
  const env = installEnv({
    acquisitionClientSecret: ''
  })
  try {
    const acquisitionApi = require(acquisitionApiPath)
    await assert.rejects(
      () => acquisitionApi.createSession({
        businessSessionId: 'BUS-2',
        orgId: '1972545374712086529',
        patientRef: '768495013408443',
        deviceType: 'MFA1',
        sourceChannel: 'BLE',
        traceId: 'trace-2'
      }),
      /缺少 acquisition HMAC 密钥配置/
    )
  } finally {
    env.cleanup()
  }
})
