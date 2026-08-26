const assert = require('assert')
const path = require('path')

const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

async function run () {
  const values = new Map()
  const globalData = {
    activeRole: 'PATIENT',
    patientRef: 'patient-1'
  }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key)
  }

  delete require.cache[storagePath]
  delete require.cache[bridgePath]
  delete require.cache[bleManagerPath]
  const storage = require(storagePath)
  const bleManager = require(bleManagerPath)

  storage.saveHealthRecord('device-1', 'heartRate', {
    id: 'hr-1',
    measuredAt: 1787720000000,
    value: 78,
    unit: 'bpm'
  })
  bleManager.state.boundDevice = { deviceId: 'device-1', name: 'SY02' }

  await bleManager.unbind()

  assert.deepStrictEqual(
    storage.getHealthRecords('device-1', 'heartRate').map(record => record.id),
    ['hr-1'],
    'unbind must retain the current patient history'
  )

  globalData.patientRef = 'patient-2'
  assert.deepStrictEqual(
    storage.getHealthRecords('device-1', 'heartRate'),
    [],
    'another patient must not see history retained for the previous patient'
  )

  globalData.patientRef = 'patient-1'
  assert.deepStrictEqual(
    storage.getHealthRecords('device-1', 'heartRate').map(record => record.id),
    ['hr-1'],
    'the original patient must still see retained history after signing in again'
  )

  console.log('Unbind history retention tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
