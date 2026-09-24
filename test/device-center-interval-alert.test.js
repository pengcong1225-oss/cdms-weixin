const assert = require('assert')
const path = require('path')

const devicePath = path.resolve(__dirname, '../miniprogram/pages/device/device.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')
const deviceSettingsPath = path.resolve(__dirname, '../miniprogram/utils/device-settings.js')

const DEVICE_ID = 'dev-center-1'

let pageConfig
const store = {}
const toasts = []
const monitoringCalls = []
const heartRateAlertCalls = []
const bloodOxygenAlertCalls = []

const sdk = {
  setMonitoring: async (...args) => monitoringCalls.push(args),
  setHeartRateAlert: async (...args) => heartRateAlertCalls.push(args),
  setBloodOxygenAlert: async (...args) => bloodOxygenAlertCalls.push(args)
}

// 内存版 wx 存储：device-settings 依赖 getStorageSync/setStorageSync/removeStorageSync
global.wx = {
  getStorageSync: key => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''),
  setStorageSync: (key, value) => { store[key] = value },
  removeStorageSync: key => { delete store[key] },
  showToast: options => toasts.push(options)
}

global.Page = config => { pageConfig = config }

require.cache[bleManagerPath] = {
  id: bleManagerPath,
  filename: bleManagerPath,
  loaded: true,
  exports: {
    getSdk: () => sdk,
    snapshot: () => ({ boundDevice: { deviceId: DEVICE_ID }, connected: true }),
    subscribe: () => () => {}
  }
}

delete require.cache[devicePath]
require(devicePath)

const deviceSettings = require(deviceSettingsPath)

const page = Object.assign({}, pageConfig, {
  data: Object.assign({}, pageConfig.data, { boundDevice: { deviceId: DEVICE_ID }, dialog: null }),
  setData (values) { Object.assign(this.data, values) },
  updateSettingValue: () => undefined
})

function resetStore () {
  Object.keys(store).forEach(key => delete store[key])
}

function resetToasts () {
  toasts.length = 0
}

function toastTitles () {
  return toasts.map(item => item.title)
}

async function reopenAndConfirm (settingId, patch) {
  await page.executeSetting(settingId)
  page.setData({ dialog: Object.assign({}, page.data.dialog, patch) })
  await page.confirmDialog()
}

const SCHEDULE_BASE = {
  startHour: 0,
  startMinute: 0,
  endHour: 23,
  endMinute: 59
}

async function run () {
  // ---- (a) 无保存配置：executeSetting 打开弹层，默认 30 分钟 ----
  resetStore()
  await page.executeSetting('heartRateMonitoring')
  assert.strictEqual(page.data.dialog.kind, 'interval')
  assert.strictEqual(page.data.dialog.id, 'heartRateMonitoring')
  assert.strictEqual(page.data.dialog.options.length, 61, '关闭 + 1-60 分钟共 61 项')
  assert.strictEqual(page.data.dialog.index, 30, '无保存配置默认 30 分钟')
  page.closeDialog()

  // ---- (b) index=0 → 关闭采集并落盘 ----
  await reopenAndConfirm('heartRateMonitoring', { index: 0 })
  assert.deepStrictEqual(monitoringCalls[0], ['heartRate', Object.assign({
    enabled: false,
    intervalMinutes: 60
  }, SCHEDULE_BASE)])
  assert.strictEqual(page.data.dialog, null, '确认后应关闭弹层')
  assert.deepStrictEqual(deviceSettings.load(DEVICE_ID).heartRateMonitoring, Object.assign({
    enabled: false,
    intervalMinutes: 60
  }, SCHEDULE_BASE), 'persistSetting 后 deviceSettings.load 应能读到')

  // ---- (c) index=7 / index=60：开启采集并落盘（含 60 边界）----
  await page.executeSetting('heartRateMonitoring')
  assert.strictEqual(page.data.dialog.index, 0, '已保存为关闭时弹层应回显「关闭」')
  page.setData({ dialog: Object.assign({}, page.data.dialog, { index: 7 }) })
  await page.confirmDialog()
  assert.deepStrictEqual(monitoringCalls[1], ['heartRate', Object.assign({
    enabled: true,
    intervalMinutes: 7
  }, SCHEDULE_BASE)])

  await page.executeSetting('heartRateMonitoring')
  assert.strictEqual(page.data.dialog.index, 7, '已保存 7 分钟时弹层应回显 7')
  page.setData({ dialog: Object.assign({}, page.data.dialog, { index: 60 }) })
  await page.confirmDialog()
  assert.deepStrictEqual(monitoringCalls[2], ['heartRate', Object.assign({
    enabled: true,
    intervalMinutes: 60
  }, SCHEDULE_BASE)], '60 分钟为边界值，应原样下发')

  // ---- (d) 心率预警：预填、确认、下限留空、两值留空 ----
  resetStore()
  deviceSettings.save(DEVICE_ID, { heartRateAlert: { enabled: true, high: 120, low: 100 } })
  await page.executeSetting('heartRateAlert')
  assert.strictEqual(page.data.dialog.kind, 'alert')
  assert.strictEqual(page.data.dialog.supportsUpper, true)
  assert.strictEqual(page.data.dialog.upperText, '120', '上限应预填自 deviceSettings')
  assert.strictEqual(page.data.dialog.lowerText, '100', '下限应预填自 deviceSettings')

  await reopenAndConfirm('heartRateAlert', { upperText: '120', lowerText: '50' })
  assert.deepStrictEqual(heartRateAlertCalls[0], [true, 120, 50])

  await reopenAndConfirm('heartRateAlert', { upperText: '120', lowerText: '' })
  assert.deepStrictEqual(heartRateAlertCalls[1], [true, 120, 0xff], '下限留空 → 0xff(255)')

  await reopenAndConfirm('heartRateAlert', { upperText: '', lowerText: '' })
  assert.deepStrictEqual(heartRateAlertCalls[2], [false, 0, 0], '两值都空 → 关闭预警')
  assert.deepStrictEqual(deviceSettings.load(DEVICE_ID).heartRateAlert, { enabled: false, high: 0, low: 0 },
    '关闭预警应落盘 enabled=false')

  // ---- (e) 血氧预警：仅下限；上限填写 → toast 且不下发 ----
  resetStore()
  deviceSettings.save(DEVICE_ID, { bloodOxygenAlert: { enabled: true, low: 92 } })
  await page.executeSetting('bloodOxygenAlert')
  assert.strictEqual(page.data.dialog.kind, 'alert')
  assert.strictEqual(page.data.dialog.supportsUpper, false)
  assert.strictEqual(page.data.dialog.upperText, '', '血氧无上限配置，预填应为空')
  assert.strictEqual(page.data.dialog.lowerText, '92', '下限应预填自 deviceSettings')

  await reopenAndConfirm('bloodOxygenAlert', { upperText: '', lowerText: '92' })
  assert.deepStrictEqual(bloodOxygenAlertCalls[0], [true, 92])

  resetToasts()
  const boCallsBefore = bloodOxygenAlertCalls.length
  await reopenAndConfirm('bloodOxygenAlert', { upperText: '98', lowerText: '92' })
  assert.strictEqual(bloodOxygenAlertCalls.length, boCallsBefore, '填写上限时不应调 SDK')
  assert.ok(toastTitles().includes('血氧仅支持下限'), '应提示「血氧仅支持下限」')
  assert.strictEqual(page.data.dialog.kind, 'alert', '校验失败弹层不应关闭')

  await reopenAndConfirm('bloodOxygenAlert', { upperText: '', lowerText: '' })
  assert.deepStrictEqual(bloodOxygenAlertCalls[bloodOxygenAlertCalls.length - 1], [false, 0], '血氧两值都空 → 关闭预警')

  // ---- (f) 非法输入：只 toast，不调 SDK ----
  resetStore()
  resetToasts()
  const hrCallsBefore = heartRateAlertCalls.length

  await reopenAndConfirm('heartRateAlert', { upperText: '300', lowerText: '' })
  assert.strictEqual(heartRateAlertCalls.length, hrCallsBefore, '上限 300 不应调 SDK')
  assert.ok(toastTitles().includes('上限范围 30-250'), '上限超范围应 toast')

  await reopenAndConfirm('heartRateAlert', { upperText: '', lowerText: '300' })
  assert.strictEqual(heartRateAlertCalls.length, hrCallsBefore, '下限 300 不应调 SDK')
  assert.ok(toastTitles().includes('下限范围 30-250'), '下限超范围应 toast')

  await reopenAndConfirm('heartRateAlert', { upperText: '120', lowerText: '200' })
  assert.strictEqual(heartRateAlertCalls.length, hrCallsBefore, '下限≥上限不应调 SDK')
  assert.ok(toastTitles().includes('下限需小于上限'), '下限≥上限应 toast')

  await reopenAndConfirm('heartRateAlert', { upperText: 'abc', lowerText: '' })
  assert.strictEqual(heartRateAlertCalls.length, hrCallsBefore, '非数字不应调 SDK')
  assert.ok(toastTitles().includes('上限需为整数'), '非数字应 toast 需为整数')

  // 血氧非法输入：50-100 之外与非整数
  await reopenAndConfirm('bloodOxygenAlert', { upperText: '', lowerText: '40' })
  assert.ok(toastTitles().includes('血氧下限范围 50-100'), '血氧下限超范围应 toast')

  await reopenAndConfirm('bloodOxygenAlert', { upperText: '', lowerText: '9.5' })
  assert.ok(toastTitles().includes('下限需为整数'), '血氧非整数应 toast')

  // ---- (g) 400 不计入限流：设备中心无后端限流/重试逻辑（不属于本页契约），跳过 ----

  console.log('Device center interval/alert dialog tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
