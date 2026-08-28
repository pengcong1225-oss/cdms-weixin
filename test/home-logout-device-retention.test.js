const assert = require('assert')
const path = require('path')

const homePath = path.resolve(__dirname, '../miniprogram/pages/home/home.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')

const app = {
  globalData: { activeRole: 'PATIENT', cdmsBaseUrl: '', accessToken: '' },
  clearAuthCalled: false,
  clearAuth () { this.clearAuthCalled = true }
}
let pageConfig
let disconnectForLogoutCalled = false
let unbindCalled = false
let relaunchUrl = ''

global.getApp = () => app
global.Page = config => { pageConfig = config }
global.wx = {
  showModal: options => options.success({ confirm: true }),
  reLaunch: options => { relaunchUrl = options.url }
}

require.cache[bleManagerPath] = {
  id: bleManagerPath,
  filename: bleManagerPath,
  loaded: true,
  exports: {
    disconnectForLogout: async () => { disconnectForLogoutCalled = true },
    unbind: async () => { unbindCalled = true }
  }
}
require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: { logout: async () => undefined }
}

delete require.cache[homePath]
require(homePath)

async function run () {
  pageConfig.logout()
  await new Promise(resolve => setImmediate(resolve))

  assert.strictEqual(disconnectForLogoutCalled, true, 'logout must only disconnect the local BLE connection')
  assert.strictEqual(unbindCalled, false, 'logout must not release the server-side binding')
  assert.strictEqual(app.clearAuthCalled, true)
  assert.strictEqual(relaunchUrl, '/pages/auth/login')
  console.log('Home logout device retention test passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
