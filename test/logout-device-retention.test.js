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

  delete require.cache[storagePath]
  delete require.cache[bridgePath]
  delete require.cache[bleManagerPath]
  const storage = require(storagePath)
  const bridge = require(bridgePath)
  const bleManager = require(bleManagerPath)

  const boundDevice = { deviceId: 'ring-1', name: 'SY01' }
  storage.saveBoundDevice(boundDevice)
  bleManager.state.boundDevice = boundDevice

  let releaseCalled = false
  bridge.releaseWearableSession = async () => { releaseCalled = true }

  await bleManager.disconnectForLogout()

  assert.strictEqual(releaseCalled, false, 'logout cleanup must not release the server-side device binding')
  assert.deepStrictEqual(storage.getBoundDevice(), boundDevice, 'logout cleanup must retain the local device binding')
  assert.deepStrictEqual(bleManager.state.boundDevice, boundDevice, 'logout cleanup must retain the in-memory device binding')

  console.log('Logout device retention test passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
