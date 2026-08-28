const assert = require('assert')
const test = require('node:test')

function createWxStorage (initial = {}) {
  const storage = new Map(Object.entries(initial))
  return {
    storage,
    wx: {
      getStorageSync: key => storage.get(key),
      setStorageSync: (key, value) => storage.set(key, value),
      removeStorageSync: key => storage.delete(key),
      request: () => {},
      cloud: { init: () => {} },
      onBluetoothAdapterStateChange: () => {},
      openBluetoothAdapter: options => options.success({})
    }
  }
}

async function restoreFromStorage (snapshot) {
  const redirects = []
  const { storage, wx } = createWxStorage({
    'cdms.miniapp.auth': Object.assign({
      identityId: 'identity-1',
      activeRole: 'PATIENT',
      roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }],
      patientRef: 'patient-1',
      cdmsBaseUrl: 'https://cdms.example.com'
    }, snapshot)
  })

  const requests = []
  wx.reLaunch = options => redirects.push(options)
  wx.request = options => {
    requests.push(options)
    if (options.url.endsWith('/api/v1/miniapp/auth/refresh')) {
      options.success({ statusCode: 200, data: { data: {
        token: 'access-2',
        refreshToken: 'refresh-2',
        identityId: 'identity-1',
        activeRole: 'PATIENT',
        roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }]
      } } })
      return
    }
    options.fail(new Error(`unexpected request: ${options.url}`))
  }

  global.wx = wx
  let appConfig
  global.App = config => { appConfig = config }
  global.getApp = () => appConfig

  delete require.cache[require.resolve('../miniprogram/utils/session-store')]
  delete require.cache[require.resolve('../miniprogram/utils/api')]
  delete require.cache[require.resolve('../miniprogram/app.js')]
  require('../miniprogram/app.js')

  appConfig.onLaunch({})
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(requests.length, 1)
  return Object.assign({}, appConfig.globalData, {
    storedAuth: storage.get('cdms.miniapp.auth'),
    redirects
  })
}

test('restart restores from refresh token without login form', async () => {
  const result = await restoreFromStorage({ refreshToken: 'refresh-1' })
  assert.equal(result.activeRole, 'PATIENT')
  assert.equal(result.refreshToken, 'refresh-2')
  assert.equal(result.accessToken, 'access-2')
  assert.deepStrictEqual(result.redirects, [])
})

test('restart refresh-token-only storage uses runtime default cdms base url', async () => {
  const requests = []
  const redirects = []
  const { storage, wx } = createWxStorage({
    'cdms.miniapp.auth': { refreshToken: 'refresh-1' }
  })
  wx.reLaunch = options => redirects.push(options)
  wx.request = options => {
    requests.push(options)
    options.success({ statusCode: 200, data: { data: {
      token: 'access-2',
      refreshToken: 'refresh-2',
      identityId: 'identity-1',
      activeRole: 'PATIENT',
      roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }]
    } } })
  }

  global.wx = wx
  let appConfig
  global.App = config => { appConfig = config }
  global.getApp = () => appConfig

  delete require.cache[require.resolve('../miniprogram/utils/session-store')]
  delete require.cache[require.resolve('../miniprogram/utils/api')]
  delete require.cache[require.resolve('../miniprogram/app.js')]
  require('../miniprogram/app.js')

  appConfig.onLaunch({})
  await appConfig.restoreSessionPromise

  assert.equal(requests.length, 1)
  assert.equal(requests[0].url, 'https://jq.mockr.com.cn/cdmsapi/api/v1/miniapp/auth/refresh')
  assert.equal(appConfig.globalData.cdmsBaseUrl, 'https://jq.mockr.com.cn/cdmsapi')
  assert.equal(storage.get('cdms.miniapp.auth').cdmsBaseUrl, 'https://jq.mockr.com.cn/cdmsapi')
  assert.deepStrictEqual(redirects, [])
})

test('saveAuth persists refresh snapshot without access token', () => {
  const { storage, wx } = createWxStorage()
  global.wx = wx
  let appConfig
  global.App = config => { appConfig = config }

  delete require.cache[require.resolve('../miniprogram/utils/session-store')]
  delete require.cache[require.resolve('../miniprogram/app.js')]
  require('../miniprogram/app.js')

  appConfig.saveAuth({
    token: 'access-1',
    refreshToken: 'refresh-1',
    identityId: 'identity-1',
    activeRole: 'PATIENT',
    roles: [{ roleType: 'PATIENT', patientId: '768495013408443' }]
  })

  const persisted = storage.get('cdms.miniapp.auth')
  assert.equal(appConfig.globalData.accessToken, 'access-1')
  assert.equal(persisted.accessToken, undefined)
  assert.equal(persisted.refreshToken, 'refresh-1')
  assert.equal(persisted.patientRef, '768495013408443')
  assert.equal(typeof persisted.patientRef, 'string')
})

test('auth guard redirects missing or wrong role sessions', async () => {
  const redirects = []
  global.wx = { reLaunch: options => redirects.push(options) }
  global.getApp = () => ({
    globalData: {
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      activeRole: 'PATIENT'
    }
  })

  delete require.cache[require.resolve('../miniprogram/utils/auth-guard')]
  const { ensureSession } = require('../miniprogram/utils/auth-guard')

  await assert.rejects(() => ensureSession({ role: 'DOCTOR' }), /DOCTOR/)
  assert.deepStrictEqual(redirects, [{ url: '/pages/auth/login' }])
})

test('auth guard refreshes restored session before redirecting', async () => {
  const requests = []
  const redirects = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms.example.com',
    accessToken: '',
    refreshToken: 'refresh-1',
    activeRole: 'PATIENT',
    patientRef: 'patient-1'
  }
  global.wx = {
    reLaunch: options => redirects.push(options),
    request: options => {
      requests.push(options)
      options.success({ statusCode: 200, data: { data: {
        token: 'access-2',
        refreshToken: 'refresh-2',
        activeRole: 'PATIENT',
        identityId: 'identity-1',
        roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }]
      } } })
    }
  }
  global.getApp = () => ({
    globalData,
    saveAuth: session => {
      globalData.accessToken = session.token
      globalData.refreshToken = session.refreshToken
      globalData.activeRole = session.activeRole
    }
  })

  delete require.cache[require.resolve('../miniprogram/utils/api')]
  delete require.cache[require.resolve('../miniprogram/utils/auth-guard')]
  const { ensureSession } = require('../miniprogram/utils/auth-guard')

  const auth = await ensureSession({ role: 'PATIENT' })
  assert.equal(auth.accessToken, 'access-2')
  assert.equal(auth.refreshToken, 'refresh-2')
  assert.equal(requests.length, 1)
  assert.deepStrictEqual(redirects, [])
})

test('login page enters restored patient session after silent refresh', async () => {
  const redirects = []
  const requests = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms.example.com',
    accessToken: '',
    refreshToken: 'refresh-1',
    activeRole: 'PATIENT',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }],
    patientRef: 'patient-1'
  }
  const app = {
    globalData,
    saveAuth: session => {
      globalData.accessToken = session.token
      globalData.refreshToken = session.refreshToken
      globalData.activeRole = session.activeRole
      globalData.roles = session.roles
    },
    clearAuth: () => {
      globalData.accessToken = ''
      globalData.refreshToken = ''
    }
  }
  let pageConfig
  global.Page = config => { pageConfig = config }
  global.getApp = () => app
  global.wx = {
    reLaunch: options => redirects.push(options),
    showToast: () => {},
    request: options => {
      requests.push(options)
      options.success({ statusCode: 200, data: { data: {
        token: 'access-2',
        refreshToken: 'refresh-2',
        activeRole: 'PATIENT',
        identityId: 'identity-1',
        roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }]
      } } })
    }
  }

  delete require.cache[require.resolve('../miniprogram/utils/api')]
  delete require.cache[require.resolve('../miniprogram/pages/auth/login.js')]
  require('../miniprogram/pages/auth/login.js')
  pageConfig.setData = values => { pageConfig.data = Object.assign({}, pageConfig.data, values) }

  pageConfig.onLoad({})
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(requests.length, 1)
  assert.equal(globalData.accessToken, 'access-2')
  assert.deepStrictEqual(redirects, [{ url: '/pages/home/home' }])
})

test('home page waits for silent restore before login redirect', async () => {
  const redirects = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms.example.com',
    accessToken: '',
    refreshToken: 'refresh-1',
    activeRole: 'PATIENT',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }],
    patientRef: 'patient-1'
  }
  let resolveRestore
  const restoreSessionPromise = new Promise(resolve => {
    resolveRestore = () => {
      globalData.accessToken = 'access-2'
      globalData.refreshToken = 'refresh-2'
      resolve(globalData)
    }
  })
  const app = { globalData, restoreSessionPromise }

  global.getApp = () => app
  global.wx = {
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    reLaunch: options => redirects.push(options),
    showToast: () => {}
  }
  let pageConfig
  global.Page = config => { pageConfig = config }

  delete require.cache[require.resolve('../miniprogram/services/bleManager')]
  delete require.cache[require.resolve('../miniprogram/utils/storage')]
  delete require.cache[require.resolve('../miniprogram/utils/api')]
  delete require.cache[require.resolve('../miniprogram/utils/auth-guard')]
  delete require.cache[require.resolve('../miniprogram/pages/home/home.js')]
  require('../miniprogram/pages/home/home.js')
  pageConfig.setData = values => { pageConfig.data = Object.assign({}, pageConfig.data, values) }

  const onLoad = pageConfig.onLoad()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepStrictEqual(redirects, [])

  resolveRestore()
  await onLoad

  assert.deepStrictEqual(redirects, [])
  assert.equal(pageConfig.data.activeRole, 'PATIENT')
})

test('doctor home lifecycle shares one handoff after delayed restore', async () => {
  const redirects = []
  const requests = []
  const globalData = {
    cdmsBaseUrl: 'https://cdms.example.com',
    accessToken: '',
    refreshToken: 'refresh-1',
    activeRole: 'DOCTOR',
    roles: [{ roleType: 'DOCTOR', principalId: 'doctor-1' }]
  }
  let resolveRestore
  const restoreSessionPromise = new Promise(resolve => {
    resolveRestore = () => {
      globalData.accessToken = 'access-2'
      globalData.refreshToken = 'refresh-2'
      resolve(globalData)
    }
  })
  const app = { globalData, restoreSessionPromise }

  global.getApp = () => app
  global.wx = {
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    redirectTo: options => redirects.push(options),
    reLaunch: options => redirects.push(options),
    showToast: () => {},
    request: options => {
      requests.push(options)
      if (options.url.endsWith('/api/v1/miniapp/auth/handoff')) {
        options.success({ statusCode: 200, data: { data: { handoffUrl: 'https://cdms.example.com/h5/patients' } } })
        return
      }
      options.fail(new Error(`unexpected request: ${options.url}`))
    }
  }
  let pageConfig
  global.Page = config => { pageConfig = config }

  delete require.cache[require.resolve('../miniprogram/services/bleManager')]
  delete require.cache[require.resolve('../miniprogram/utils/storage')]
  delete require.cache[require.resolve('../miniprogram/utils/api')]
  delete require.cache[require.resolve('../miniprogram/utils/auth-guard')]
  delete require.cache[require.resolve('../miniprogram/pages/home/home.js')]
  require('../miniprogram/pages/home/home.js')
  pageConfig.setData = values => { pageConfig.data = Object.assign({}, pageConfig.data, values) }

  const load = pageConfig.onLoad()
  const show = pageConfig.onShow()
  await new Promise(resolve => setImmediate(resolve))
  assert.deepStrictEqual(requests, [])
  assert.deepStrictEqual(redirects, [])

  resolveRestore()
  await Promise.all([load, show])
  await new Promise(resolve => setImmediate(resolve))

  assert.equal(requests.filter(item => item.url.endsWith('/api/v1/miniapp/auth/handoff')).length, 1)
  assert.equal(redirects.length, 1)
  assert.deepStrictEqual(redirects[0], {
    url: '/pages/h5/index?url=https%3A%2F%2Fcdms.example.com%2Fh5%2Fpatients'
  })
})
