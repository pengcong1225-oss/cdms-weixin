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
let ownershipRefreshed = false
appConfig.globalData.identityId = 'identity-1'
appConfig.globalData.activeRole = 'PATIENT'
appConfig.globalData.patientRef = 'patient-1'
appConfig.globalData.bleManager.unbind = async () => { unbindCalled = true }
appConfig.globalData.bleManager.refreshBoundDeviceOwnership = async () => { ownershipRefreshed = true }

appConfig.saveAuth({
  identityId: 'identity-2',
  activeRole: 'PATIENT',
  roles: [{ roleType: 'PATIENT', patientId: 2 }],
  token: 'token-2',
  refreshToken: 'refresh-2'
})

assert.strictEqual(ownershipRefreshed, true,
  'switching patient identity must refresh the bound-device ownership check (Task A/Task B)')
assert.strictEqual(unbindCalled, false,
  'switching patient identity must NOT unbind (binding history is retained; foreign device is hidden instead)')
assert.strictEqual(appConfig.globalData.patientRef, '2')

// token 刷新等会话缺 identityId 时不得当作身份切换：保留既有身份标记（Task B）
appConfig.globalData.bleManager.refreshBoundDeviceOwnership = async () => {}
appConfig.saveAuth({
  token: 'token-3',
  refreshToken: 'refresh-3',
  activeRole: 'PATIENT',
  roles: [{ roleType: 'PATIENT', patientId: 2 }]
})
assert.strictEqual(appConfig.globalData.identityId, 'identity-2',
  'token refresh without identityId must retain the previous identity marker')
console.log('Miniapp role switch regression passed')
