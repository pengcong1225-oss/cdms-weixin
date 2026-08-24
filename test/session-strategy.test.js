const assert = require('assert')
const { getSessionStrategy } = require('../miniprogram/utils/session-strategy')

assert.strictEqual(getSessionStrategy({
  activeRole: 'PATIENT', cdmsBaseUrl: 'https://cdms', accessToken: 'token', patientRef: 'p-1'
}), 'CDMS_PATIENT')
assert.strictEqual(getSessionStrategy({
  iotBaseUrl: 'https://iot', wearableToken: 'token', wearableSessionId: 's-1'
}), 'EXISTING')
assert.strictEqual(getSessionStrategy({
  managerBaseUrl: 'https://manager', handoffCode: 'launch'
}), 'MANAGER_HANDOFF')
assert.strictEqual(getSessionStrategy({}), 'MISSING')

console.log('session strategy tests passed')
