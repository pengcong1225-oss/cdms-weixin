const assert = require('assert')

global.wx = {
  getStorageSync: () => null,
  setStorageSync: () => {},
  removeStorageSync: () => {}
}
let appConfig
global.App = config => { appConfig = config }
global.getApp = () => ({ globalData: {} })

function switchRoleContext (snapshot, roleType) {
  const next = Object.assign({}, snapshot, { activeRole: roleType })
  if (roleType !== 'PATIENT') {
    next.patientRef = ''
    next.taskId = ''
    next.wearableToken = ''
    next.wearableSessionId = ''
    next.wearableDeviceRef = ''
    next.deviceRef = ''
  }
  return next
}

const appPath = require.resolve('../miniprogram/app.js')
delete require.cache[appPath]
require(appPath)

let unbindCalled = false
appConfig.globalData.identityId = 'identity-1'
appConfig.globalData.activeRole = 'PATIENT'
appConfig.globalData.patientRef = 'patient-1'
appConfig.globalData.taskId = 'task-1'
appConfig.globalData.wearableToken = 'wearable-token-1'
appConfig.globalData.wearableSessionId = 'wearable-session-1'
appConfig.globalData.wearableDeviceRef = 'device-1'
appConfig.globalData.deviceRef = 'device-1'
appConfig.globalData.bleManager.unbind = async () => { unbindCalled = true }

assert.deepStrictEqual(switchRoleContext({
  refreshToken: 'refresh-1',
  identityId: 'identity-1',
  roles: [{ roleType: 'DOCTOR' }],
  patientRef: 'patient-1',
  taskId: 'task-1',
  wearableToken: 'wearable-token-1',
  wearableSessionId: 'wearable-session-1',
  wearableDeviceRef: 'device-1',
  deviceRef: 'device-1'
}, 'DOCTOR'), {
  refreshToken: 'refresh-1',
  identityId: 'identity-1',
  roles: [{ roleType: 'DOCTOR' }],
  activeRole: 'DOCTOR',
  patientRef: '',
  taskId: '',
  wearableToken: '',
  wearableSessionId: '',
  wearableDeviceRef: '',
  deviceRef: ''
})

appConfig.saveAuth({
  identityId: 'identity-1',
  activeRole: 'DOCTOR',
  roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }, { roleType: 'DOCTOR', principalId: 'doctor-1' }],
  token: 'token-2',
  refreshToken: 'refresh-2'
})

assert.strictEqual(unbindCalled, true,
  'switching role context must release the previous wearable binding')
assert.strictEqual(appConfig.globalData.refreshToken, 'refresh-2')
assert.strictEqual(appConfig.globalData.identityId, 'identity-1')
assert.deepStrictEqual(appConfig.globalData.roles, [{ roleType: 'PATIENT', patientId: 'patient-1' }, { roleType: 'DOCTOR', principalId: 'doctor-1' }])
assert.strictEqual(appConfig.globalData.patientRef, '')
assert.strictEqual(appConfig.globalData.taskId, '')
assert.strictEqual(appConfig.globalData.wearableToken, '')
assert.strictEqual(appConfig.globalData.wearableSessionId, '')
assert.strictEqual(appConfig.globalData.wearableDeviceRef, '')
assert.strictEqual(appConfig.globalData.deviceRef, '')
console.log('Miniapp role switch regression passed')
