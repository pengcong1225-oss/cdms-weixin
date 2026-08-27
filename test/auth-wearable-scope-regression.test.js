const assert = require('assert')

const values = new Map([
  ['cdms.miniapp.auth', {
    identityId: 'identity-2', activeRole: 'PATIENT', patientRef: 'patient-2',
    accessToken: 'token-2', refreshToken: 'refresh-2'
  }],
  ['cdms.miniapp.wearable', {
    patientRef: 'patient-1', wearableToken: 'old-token', wearableSessionId: 'old-session'
  }]
])

global.wx = {
  getStorageSync: key => values.get(key),
  setStorageSync: (key, value) => values.set(key, value),
  removeStorageSync: key => values.delete(key)
}
let appConfig
global.App = config => { appConfig = config }
global.getApp = () => ({ globalData: {} })

const appPath = require.resolve('../miniprogram/app.js')
delete require.cache[appPath]
require(appPath)

appConfig.globalData = {}
appConfig.restoreAuth()

assert.strictEqual(appConfig.globalData.patientRef, 'patient-2',
  'a stale wearable session must not overwrite the authenticated patient')
assert.strictEqual(values.has('cdms.miniapp.wearable'), false,
  'a wearable session belonging to another patient must be discarded')
console.log('Miniapp wearable scope regression passed')
