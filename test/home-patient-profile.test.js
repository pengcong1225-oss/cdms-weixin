const assert = require('assert')
const path = require('path')

const homePath = path.resolve(__dirname, '../miniprogram/pages/home/home.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')

let pageConfig
let meRequests = 0
let meIdentityId = '10'
let mePatientId = '42'
let mePatientName = '张三'
let mePatientPhone = '13812345678'
let rotateTokenOnMe = false

const app = {
  globalData: {
    activeRole: 'PATIENT',
    cdmsBaseUrl: 'https://cdms.example',
    accessToken: 'access-token',
    identityId: '10',
    patientId: '42'
  }
}

global.getApp = () => app
global.Page = config => { pageConfig = config }
global.wx = {
  reLaunch: () => undefined,
  navigateTo: () => undefined,
  switchTab: () => undefined
}

require.cache[bleManagerPath] = {
  id: bleManagerPath,
  filename: bleManagerPath,
  loaded: true,
  exports: {
    subscribe: () => () => undefined,
    snapshot: () => ({ boundDevice: null, realtimeHealth: {}, foreignDevice: false }),
    scheduleAutoSync: () => undefined,
    stopAutoSync: () => undefined
  }
}

require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    readQueue: () => [],
    cdmsRequest: async (pathName, method, body, accessToken) => {
      assert.strictEqual(method, 'GET')
      assert.strictEqual(body, null)
      assert.strictEqual(accessToken, 'access-token')
      assert.strictEqual(pathName, '/api/v1/miniapp/auth/me', 'home profile must use the authenticated /me contract only')
      meRequests += 1
      if (rotateTokenOnMe) app.globalData.accessToken = 'refreshed-access-token'
      return { data: {
        identityId: meIdentityId,
        patientId: mePatientId,
        patientName: mePatientName,
        patientPhone: mePatientPhone
      } }
    }
  }
}

delete require.cache[homePath]
require(homePath)

function createPage () {
  return Object.assign({}, pageConfig, {
    data: Object.assign({}, pageConfig.data),
    setData (patch) { Object.assign(this.data, patch) }
  })
}

async function run () {
  const page = createPage()
  app.globalData.patientId = '99'

  page.onLoad()
  await new Promise(resolve => setImmediate(resolve))

  assert.strictEqual(meRequests, 1, 'must resolve patientId from /me even when the local session has a stale patientId')
  assert.strictEqual(app.globalData.patientId, '42', 'must replace the stale local patientId')
  assert.deepStrictEqual({
    patientName: page.data.patientName,
    patientPhone: page.data.patientPhone,
    patientInitial: page.data.patientInitial,
    patientProfileReady: page.data.patientProfileReady
  }, {
    patientName: '张三',
    patientPhone: '13812345678',
    patientInitial: '张',
    patientProfileReady: true
  })

  app.globalData.patientId = ''
  mePatientId = '84'
  mePatientName = '李四'
  mePatientPhone = '13900000000'
  const fallbackPage = createPage()
  await fallbackPage.loadPatientProfile()

  assert.strictEqual(meRequests, 2, 'must resolve patientId from /me when session lacks it')
  assert.strictEqual(fallbackPage.data.patientName, '李四')
  assert.strictEqual(fallbackPage.data.patientPhone, '13900000000')
  assert.strictEqual(fallbackPage.data.patientInitial, '李')

  app.globalData.accessToken = 'access-token'
  rotateTokenOnMe = true
  mePatientName = '王五'
  mePatientPhone = '13700000000'
  const refreshedPage = createPage()
  await refreshedPage.loadPatientProfile()

  assert.strictEqual(refreshedPage.data.patientProfileReady, true, 'a successful /me response remains valid after transparent token refresh')
  assert.strictEqual(refreshedPage.data.patientName, '王五')
  assert.strictEqual(refreshedPage.data.patientPhone, '13700000000')
  assert.strictEqual(refreshedPage.data.patientProfileLoading, false)

  app.globalData.accessToken = 'access-token'
  rotateTokenOnMe = false
  mePatientName = ''
  mePatientPhone = ''
  const emptyPage = createPage()
  const originalWarn = console.warn
  console.warn = () => undefined
  try {
    await emptyPage.loadPatientProfile()
  } finally {
    console.warn = originalWarn
  }

  assert.strictEqual(emptyPage.data.patientProfileReady, false)
  assert.strictEqual(emptyPage.data.patientName, '')
  assert.strictEqual(emptyPage.data.patientPhone, '')
  assert.strictEqual(emptyPage.data.patientInitial, '')

  console.log('Home patient profile tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
