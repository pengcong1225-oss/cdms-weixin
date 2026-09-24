const assert = require('assert')
const path = require('path')

const devicePath = path.resolve(__dirname, '../miniprogram/pages/device/device.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

let pageConfig
const toasts = []
const monitoringCalls = []
const heartRateAlertCalls = []
const bloodOxygenAlertCalls = []

const sdk = {
  setMonitoring: async (...args) => monitoringCalls.push(args),
  setHeartRateAlert: async (...args) => heartRateAlertCalls.push(args),
  setBloodOxygenAlert: async (...args) => bloodOxygenAlertCalls.push(args)
}

global.Page = config => { pageConfig = config }
global.wx = { showToast: options => toasts.push(options) }

require.cache[bleManagerPath] = {
  id: bleManagerPath,
  filename: bleManagerPath,
  loaded: true,
  exports: { getSdk: () => sdk }
}

delete require.cache[devicePath]
require(devicePath)

const page = Object.assign({}, pageConfig, {
  data: Object.assign({}, pageConfig.data, { dialog: null }),
  setData (values) { Object.assign(this.data, values) },
  updateSettingValue: () => undefined
})

async function run () {
  // 监测项：executeSetting 直接打开采集间隔弹层（关闭 + 1-60 分钟）
  await page.executeSetting('heartRateMonitoring')
  assert.strictEqual(page.data.dialog.kind, 'interval')
  assert.strictEqual(page.data.dialog.id, 'heartRateMonitoring')
  assert.strictEqual(page.data.dialog.options.length, 61)
  assert.strictEqual(page.data.dialog.options[0], '关闭')
  assert.strictEqual(page.data.dialog.options[30], '30 分钟')
  assert.strictEqual(page.data.dialog.index, 30)

  // 确认：index=7 → enabled=true / intervalMinutes=7
  page.setData({ dialog: Object.assign({}, page.data.dialog, { index: 7 }) })
  await page.confirmDialog()
  assert.deepStrictEqual(monitoringCalls[0], ['heartRate', {
    enabled: true,
    startHour: 0,
    startMinute: 0,
    endHour: 23,
    endMinute: 59,
    intervalMinutes: 7
  }])
  assert.strictEqual(page.data.dialog, null)

  // 确认：index=0（关闭）→ enabled=false / intervalMinutes=60
  await page.executeSetting('heartRateMonitoring')
  page.setData({ dialog: Object.assign({}, page.data.dialog, { index: 0 }) })
  await page.confirmDialog()
  assert.deepStrictEqual(monitoringCalls[1], ['heartRate', {
    enabled: false,
    startHour: 0,
    startMinute: 0,
    endHour: 23,
    endMinute: 59,
    intervalMinutes: 60
  }])

  // 心率预警：弹层可同时输入上限与下限
  await page.executeSetting('heartRateAlert')
  assert.strictEqual(page.data.dialog.kind, 'alert')
  assert.strictEqual(page.data.dialog.supportsUpper, true)
  page.setData({ dialog: Object.assign({}, page.data.dialog, { upperText: '120', lowerText: '50' }) })
  await page.confirmDialog()
  assert.deepStrictEqual(heartRateAlertCalls[0], [true, 120, 50])

  // 血氧预警：仅支持下限
  await page.executeSetting('bloodOxygenAlert')
  assert.strictEqual(page.data.dialog.kind, 'alert')
  assert.strictEqual(page.data.dialog.supportsUpper, false)
  page.setData({ dialog: Object.assign({}, page.data.dialog, { upperText: '', lowerText: '92' }) })
  await page.confirmDialog()
  assert.deepStrictEqual(bloodOxygenAlertCalls[0], [true, 92])

  console.log('Device setting options test passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
