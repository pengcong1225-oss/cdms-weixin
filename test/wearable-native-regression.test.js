const assert = require('assert')
const test = require('node:test')

const { createUploadBatch } = require('../miniprogram/utils/cdms-bridge')

test('ring upload batch preserves string patient references without object coercion', () => {
  const batch = createUploadBatch({
    patientRef: '768495013408443',
    records: []
  })

  assert.strictEqual(batch.patientRef, '768495013408443')
  assert.equal(String(batch.patientRef).includes('[object Object]'), false)
})
