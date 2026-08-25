const assert = require('assert')

const storage = new Map()
global.wx = {
  getStorageSync: key => storage.get(key),
  setStorageSync: (key, value) => storage.set(key, value),
  request: options => options.success({
    statusCode: 401,
    data: { code: 'IoT-1002', message: '令牌已过期' }
  })
}

const api = require('../miniprogram/utils/api')

storage.set(api.queueStorageKey('patient-legacy'), [
  { batchId: 'legacy-old', patientRef: 'patient-legacy' },
  { batchId: 'legacy-latest', patientRef: 'patient-legacy' }
])
assert.deepStrictEqual(api.readQueue('patient-legacy'), [
  { batchId: 'legacy-latest', patientRef: 'patient-legacy' }
])
assert.deepStrictEqual(storage.get(api.queueStorageKey('patient-legacy')), [
  { batchId: 'legacy-latest', patientRef: 'patient-legacy' }
])

api.enqueue({ batchId: 'batch-old', patientRef: 'patient-1' })
api.enqueue({ batchId: 'batch-latest', patientRef: 'patient-1' })

assert.deepStrictEqual(api.readQueue('patient-1'), [
  { batchId: 'batch-latest', patientRef: 'patient-1' }
])

async function run () {
  await assert.rejects(
    () => api.request('https://iot/v1/wearable-upload-batches', 'POST', {}, 'expired-token'),
    error => {
      assert.strictEqual(error.message, 'HTTP 401')
      assert.strictEqual(error.statusCode, 401)
      assert.strictEqual(error.code, 'IoT-1002')
      assert.deepStrictEqual(error.response, { code: 'IoT-1002', message: '令牌已过期' })
      return true
    }
  )
  console.log('IoT upload API tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
