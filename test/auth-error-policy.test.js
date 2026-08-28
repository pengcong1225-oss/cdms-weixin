const assert = require('assert')
const test = require('node:test')

function shouldClearAuth (error) {
  return error && error.statusCode === 401 &&
    ['TOKEN_REVOKED', 'ACCOUNT_DISABLED', 'ROLE_REVOKED', 'CREDENTIAL_CHANGED'].includes(error.code)
}

test('network, timeout and 5xx retain refresh token', () => {
  const auth = { refreshToken: 'refresh-1', identityId: 'identity-1', activeRole: 'PATIENT' }
  assert.equal(shouldClearAuth({ kind: 'NETWORK', auth }), false)
  assert.equal(shouldClearAuth({ kind: 'TIMEOUT', auth }), false)
  assert.equal(shouldClearAuth({ kind: 'HTTP', statusCode: 500, auth }), false)
  assert.equal(shouldClearAuth({ kind: 'HTTP', statusCode: 401, code: 'TOKEN_REVOKED', auth }), true)
})

test('refresh network failure keeps persisted auth', async () => {
  const storage = new Map()
  const cleared = []
  const auth = {
    refreshToken: 'refresh-1',
    identityId: 'identity-1',
    activeRole: 'PATIENT',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }],
    patientRef: 'patient-1',
    cdmsBaseUrl: 'https://cdms.example.com'
  }
  storage.set('cdms.miniapp.auth', auth)

  global.getApp = () => ({
    globalData: {
      cdmsBaseUrl: 'https://cdms.example.com',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1',
      identityId: 'identity-1',
      activeRole: 'PATIENT',
      roles: auth.roles,
      patientRef: 'patient-1'
    },
    saveAuth: () => {},
    clearAuth: () => cleared.push('clearAuth')
  })
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request (options) {
      if (options.url.endsWith('/api/v1/patients')) {
        options.success({ statusCode: 401, data: { code: 401, message: 'expired' } })
        return
      }
      if (options.url.endsWith('/api/v1/miniapp/auth/refresh')) {
        options.fail({ errMsg: 'request:fail timeout' })
        return
      }
      options.fail(new Error(`unexpected request: ${options.url}`))
    }
  }

  delete require.cache[require.resolve('../miniprogram/utils/api')]
  const api = require('../miniprogram/utils/api')

  await assert.rejects(
    () => api.cdmsRequest('/api/v1/patients', 'GET', null, 'expired-token'),
    /timeout/
  )
  assert.deepStrictEqual(storage.get('cdms.miniapp.auth'), auth)
  assert.deepStrictEqual(cleared, [])
})

test('server-confirmed refresh revocation clears persisted auth', async () => {
  const storage = new Map([['cdms.miniapp.auth', {
    refreshToken: 'refresh-1',
    identityId: 'identity-1',
    activeRole: 'PATIENT',
    roles: [],
    patientRef: 'patient-1',
    cdmsBaseUrl: 'https://cdms.example.com'
  }]])
  const cleared = []

  global.getApp = () => ({
    globalData: {
      cdmsBaseUrl: 'https://cdms.example.com',
      accessToken: 'expired-token',
      refreshToken: 'refresh-1'
    },
    clearAuth: () => {
      cleared.push('clearAuth')
      storage.delete('cdms.miniapp.auth')
    }
  })
  global.wx = {
    getStorageSync: key => storage.get(key),
    setStorageSync: (key, value) => storage.set(key, value),
    removeStorageSync: key => storage.delete(key),
    request (options) {
      if (options.url.endsWith('/api/v1/patients')) {
        options.success({ statusCode: 401, data: { code: 401, message: 'expired' } })
        return
      }
      if (options.url.endsWith('/api/v1/miniapp/auth/refresh')) {
        options.success({ statusCode: 401, data: { code: 'TOKEN_REVOKED', message: 'revoked' } })
        return
      }
      options.fail(new Error(`unexpected request: ${options.url}`))
    }
  }

  delete require.cache[require.resolve('../miniprogram/utils/api')]
  const api = require('../miniprogram/utils/api')

  await assert.rejects(
    () => api.cdmsRequest('/api/v1/patients', 'GET', null, 'expired-token'),
    /HTTP 401/
  )
  assert.deepStrictEqual(cleared, ['clearAuth'])
  assert.equal(storage.has('cdms.miniapp.auth'), false)
})

test('explicit logout clears local auth before best-effort server logout', async () => {
  const sequence = []
  global.getApp = () => ({
    globalData: {
      cdmsBaseUrl: 'https://cdms.example.com',
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      identityId: 'identity-1',
      activeRole: 'PATIENT',
      patientRef: 'patient-1'
    },
    clearAuth: () => sequence.push('clearAuth')
  })
  global.wx = {
    request (options) {
      sequence.push(`request:${options.url}`)
      options.fail({ errMsg: 'request:fail timeout' })
    }
  }

  delete require.cache[require.resolve('../miniprogram/utils/api')]
  const api = require('../miniprogram/utils/api')

  await assert.rejects(() => api.logout(), /timeout/)
  assert.deepStrictEqual(sequence, [
    'clearAuth',
    'request:https://cdms.example.com/api/v1/miniapp/auth/logout'
  ])
})
