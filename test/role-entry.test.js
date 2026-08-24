const assert = require('assert')
const { getRoleEntry } = require('../miniprogram/utils/role-entry')

assert.deepStrictEqual(getRoleEntry('DOCTOR'), {
  type: 'H5',
  targetPath: '/h5/patients'
})

assert.deepStrictEqual(getRoleEntry('PATIENT'), {
  type: 'HOME'
})

assert.deepStrictEqual(getRoleEntry(''), {
  type: 'LOGIN'
})

console.log('role-entry tests passed')
