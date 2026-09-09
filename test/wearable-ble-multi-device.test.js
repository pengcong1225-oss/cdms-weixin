const assert = require('assert')
const path = require('path')

const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

async function run () {
  const values = new Map()
  const globalData = { activeRole: 'PATIENT', patientRef: 'patient-1' }
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete()
  }
  ;[storagePath, bridgePath, bleManagerPath].forEach(file => { delete require.cache[file] })
  const storage = require(storagePath)
  const bleManager = require(bleManagerPath)

  storage.saveBoundDevice({ deviceId: 'ring-a', name: 'A' })
  storage.saveBoundDevice({ deviceId: 'ring-b', name: 'B' })
  bleManager.state.boundDevice = storage.getBoundDevice('ring-a', 'patient-1')

  await bleManager.unbind()

  assert.deepStrictEqual(storage.listBoundDevices('patient-1').map(item => item.deviceId), ['ring-b'])
  assert.strictEqual(storage.getBoundDevice('ring-a', 'patient-1'), null)
  assert.strictEqual(bleManager.state.boundDevice, null)
  console.log('BLE multi-device binding tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
