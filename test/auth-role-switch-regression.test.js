const assert = require('assert')

global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  removeStorageSync: () => {}
}
let appConfig
global.App = config => { appConfig = config }
global.getApp = () => ({ globalData: {} })

const appPath = require.resolve('../miniprogram/app.js')
delete require.cache[appPath]
require(appPath)

let unbindCalled = false
appConfig.globalData.identityId = 'identity-1'
appConfig.globalData.activeRole = 'PATIENT'
appConfig.globalData.patientRef = 'patient-1'
appConfig.globalData.bleManager.unbind = async () => { unbindCalled = true }

appConfig.saveAuth({
  identityId: 'identity-2',
  activeRole: 'PATIENT',
  roles: [{ roleType: 'PATIENT', patientId: 2 }],
  token: 'token-2',
  refreshToken: 'refresh-2'
})

assert.strictEqual(unbindCalled, true,
  'switching patient identity must release the previous wearable binding')
assert.strictEqual(appConfig.globalData.patientRef, '2')
console.log('Miniapp role switch regression passed')
