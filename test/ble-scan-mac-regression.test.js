const assert = require('assert')
const path = require('path')

const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')
const sdkPath = path.resolve(__dirname, '../miniprogram/sdk/rw-ble-sdk.min.js')
const bleMacPath = path.resolve(__dirname, '../miniprogram/utils/ble-mac.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

async function run () {
  const values = new Map()
  global.getApp = () => ({ globalData: { activeRole: 'PATIENT', patientRef: 'patient-1' } })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete()
  }

  // 用假 SDK 替身驱动 bleManager.startScan -> applyDevices 真实链路
  const emitted = { onDevices: null, session: null }
  const fakeDevice = {
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    name: 'RW 智能戒指',
    localName: 'RW',
    RSSI: -60,
    macAddress: 'CE:06:02:00:20:34',
    systemConnected: false
  }
  const fakeSession = {
    getDevices: () => [fakeDevice],
    stop: async () => {},
    finished: Promise.resolve([fakeDevice])
  }
  ;[storagePath, bridgePath, sdkPath, bleMacPath, bleManagerPath].forEach(file => { delete require.cache[file] })
  require.cache[sdkPath] = { id: sdkPath, filename: sdkPath, loaded: true, exports: { RingSdk: { startScan: async options => { emitted.onDevices = options.onDevices; return fakeSession } } } }
  const bleManager = require(bleManagerPath)

  await bleManager.startScan()
  await bleManager.stopScan()
  // 等 finished 回调落地
  await new Promise(resolve => setTimeout(resolve, 10))

  const shown = bleManager.snapshot().devices[0]
  assert.ok(shown, '扫描结果应有设备')
  assert.strictEqual(shown.macAddress, '34:20:00:02:06:CE', 'iOS 扫描列表应展示反转后的真实 MAC')

  console.log('BLE scan MAC regression passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
