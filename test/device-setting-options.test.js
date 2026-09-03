const assert = require('assert')
const path = require('path')

const devicePath = path.resolve(__dirname, '../miniprogram/pages/device/device.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

let pageConfig
let selectedIndex = 0
let actionSheetItems = []
const monitoringCalls = []
const heartRateAlertCalls = []
const bloodOxygenAlertCalls = []

const sdk = {
  setMonitoring: async (...args) => monitoringCalls.push(args),
  setHeartRateAlert: async (...args) => heartRateAlertCalls.push(args),
  setBloodOxygenAlert: async (...args) => bloodOxygenAlertCalls.push(args)
}

global.Page = config => { pageConfig = config }
global.wx = {
  showActionSheet: options => {
    actionSheetItems = options.itemList
    options.success({ tapIndex: selectedIndex })
  },
  showToast: () => undefined
}

require.cache[bleManagerPath] = {
  id: bleManagerPath,
  filename: bleManagerPath,
  loaded: true,
  exports: { getSdk: () => sdk }
}

delete require.cache[devicePath]
require(devicePath)

const page = Object.assign({}, pageConfig, {
  updateSettingValue: () => undefined
})

async function run () {
  selectedIndex = 1
  await page.executeSetting('heartRateMonitoring')
  assert.deepStrictEqual(actionSheetItems, ['关闭', '每 1 分钟', '每 30 分钟', '每 60 分钟'])
  assert.deepStrictEqual(monitoringCalls[0], ['heartRate', {
    enabled: true,
    startHour: 0,
    startMinute: 0,
    endHour: 23,
    endMinute: 59,
    intervalMinutes: 1
  }])

  selectedIndex = 1
  await page.executeSetting('heartRateAlert')
  assert.deepStrictEqual(actionSheetItems, ['关闭', '上限 50 bpm', '上限 120 bpm', '上限 140 bpm', '上限 160 bpm'])
  assert.deepStrictEqual(heartRateAlertCalls[0], [true, 50, 0xff])

  selectedIndex = 1
  await page.executeSetting('bloodOxygenAlert')
  assert.deepStrictEqual(actionSheetItems, ['关闭', '下限 50%', '下限 90%', '下限 92%', '下限 94%'])
  assert.deepStrictEqual(bloodOxygenAlertCalls[0], [true, 50])

  console.log('Device setting options test passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
