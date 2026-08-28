const assert = require('assert')
const { getRoleEntry } = require('../miniprogram/utils/role-entry')

assert.deepStrictEqual(getRoleEntry('DOCTOR'), {
  type: 'NATIVE',
  url: '/pages/doctor/workspace/index'
})

assert.deepStrictEqual(getRoleEntry('PATIENT'), {
  type: 'NATIVE',
  url: '/pages/patient/workspace/index'
})

assert.deepStrictEqual(getRoleEntry(''), {
  type: 'LOGIN'
})

console.log('role-entry tests passed')
