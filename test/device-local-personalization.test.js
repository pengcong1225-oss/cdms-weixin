const assert = require('assert')
const path = require('path')

const deviceSettingsPath = path.resolve(__dirname, '../miniprogram/utils/device-settings.js')
const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const capabilitiesPath = path.resolve(__dirname, '../miniprogram/utils/capabilities.js')

// 内存版 wx 存储：device-settings / storage 依赖 wx.getStorageSync / setStorageSync / removeStorageSync
const store = {}
global.wx = {
  getStorageSync: key => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''),
  setStorageSync: (key, value) => { store[key] = value },
  removeStorageSync: key => { delete store[key] }
}
global.getApp = () => ({ globalData: { patientRef: '' } })

const deviceSettings = require(deviceSettingsPath)
const storage = require(storagePath)
const capabilities = require(capabilitiesPath)

const DEVICE_ID = 'dev-001'

function resetStore () {
  Object.keys(store).forEach(key => delete store[key])
}

async function run () {
  // ---- (a) syncIntervalMinutes 存取与默认 15 ----
  resetStore()
  assert.strictEqual(deviceSettings.getSyncIntervalMinutes(DEVICE_ID), 15, '默认应为 15 分钟')

  deviceSettings.save(DEVICE_ID, { syncIntervalMinutes: 30 })
  assert.strictEqual(deviceSettings.load(DEVICE_ID).syncIntervalMinutes, 30, '保存后应读回 30')
  assert.strictEqual(deviceSettings.getSyncIntervalMinutes(DEVICE_ID), 30, '配置 30 应生效')

  // 与其他字段并存，不互相覆盖
  deviceSettings.save(DEVICE_ID, { heartRateAlert: { enabled: true, high: 100 } })
  assert.strictEqual(deviceSettings.load(DEVICE_ID).syncIntervalMinutes, 30, '并存字段不应被覆盖')
  assert.deepStrictEqual(deviceSettings.load(DEVICE_ID).heartRateAlert, { enabled: true, high: 100 })

  // 非法值回落到默认 15
  deviceSettings.save(DEVICE_ID, { syncIntervalMinutes: 'abc' })
  assert.strictEqual(deviceSettings.getSyncIntervalMinutes(DEVICE_ID), 15, '非数字应回落 15')
  deviceSettings.save(DEVICE_ID, { syncIntervalMinutes: 0 })
  assert.strictEqual(deviceSettings.getSyncIntervalMinutes(DEVICE_ID), 15, '0 应回落 15')
  deviceSettings.save(DEVICE_ID, { syncIntervalMinutes: -5 })
  assert.strictEqual(deviceSettings.getSyncIntervalMinutes(DEVICE_ID), 15, '负数应回落 15')

  console.log('(a) syncIntervalMinutes 存取与默认 15 通过')

  // ---- (d) 阈值比较 Number() 归一 / 非法值跳过 ----
  const hrSettings = { enabled: true, high: 120 }
  const boSettings = { enabled: true, low: 90 }
  assert.strictEqual(capabilities.isHeartRateOutOfRange(130, hrSettings), true, '130 > 120 应命中')
  assert.strictEqual(capabilities.isHeartRateOutOfRange('130', hrSettings), true, '字符串 "130" 归一后应命中')
  assert.strictEqual(capabilities.isHeartRateOutOfRange(100, hrSettings), false, '100 不超阈值')
  assert.strictEqual(capabilities.isHeartRateOutOfRange('--', hrSettings), false, '"--" 应跳过')
  assert.strictEqual(capabilities.isHeartRateOutOfRange('abc', hrSettings), false, '非数字字符串应跳过')
  assert.strictEqual(capabilities.isHeartRateOutOfRange(undefined, hrSettings), false, 'undefined 应跳过')

  assert.strictEqual(capabilities.isBloodOxygenOutOfRange(80, boSettings), true, '80 < 90 应命中')
  assert.strictEqual(capabilities.isBloodOxygenOutOfRange('80', boSettings), true, '字符串 "80" 归一后应命中')
  assert.strictEqual(capabilities.isBloodOxygenOutOfRange(95, boSettings), false, '95 未低于下限')
  assert.strictEqual(capabilities.isBloodOxygenOutOfRange('--', boSettings), false, '"--" 应跳过')

  // enabled=false 时不命中
  assert.strictEqual(capabilities.isHeartRateOutOfRange(150, { enabled: false, high: 120 }), false, 'disabled 不提醒')
  assert.strictEqual(capabilities.isBloodOxygenOutOfRange(60, { enabled: false, low: 90 }), false, 'disabled 不提醒')

  console.log('(d) 阈值比较 Number 归一 / 非法值跳过 通过')

  // ---- (c) getHealthCards 超阈值打 isAlert ----
  resetStore()
  // 写入存储记录：心率 130（超 120 上限）、血氧 80（低于 90 下限）
  storage.saveHealthRecord(DEVICE_ID, 'heartRate', { value: 130, measuredAt: Date.now() - 1000 })
  storage.saveHealthRecord(DEVICE_ID, 'bloodOxygen', { value: 80, measuredAt: Date.now() - 1000 })

  deviceSettings.save(DEVICE_ID, {
    heartRateAlert: { enabled: true, high: 120, low: 0xff },
    bloodOxygenAlert: { enabled: true, low: 90 }
  })

  const device = {
    deviceId: DEVICE_ID,
    supportMenu: { hr: true, bloodOxy: true, step: true }
  }
  const cards = capabilities.getHealthCards(device, {})
  const hrCard = cards.find(c => c.type === 'heartRate')
  const boCard = cards.find(c => c.type === 'bloodOxygen')
  const stepCard = cards.find(c => c.type === 'steps')

  assert.ok(hrCard, '应有心率卡片')
  assert.strictEqual(hrCard.isAlert, true, '心率 130 超 120 应 isAlert=true')
  assert.ok(boCard, '应有血氧卡片')
  assert.strictEqual(boCard.isAlert, true, '血氧 80 低于 90 应 isAlert=true')
  assert.ok(stepCard, '应有计步卡片')
  assert.strictEqual(stepCard.isAlert, false, '计步卡片 isAlert 应为 false')

  // 关闭启用后不应再命中
  deviceSettings.save(DEVICE_ID, { heartRateAlert: { enabled: false, high: 120 }, bloodOxygenAlert: { enabled: false, low: 90 } })
  const cardsOff = capabilities.getHealthCards(device, {})
  assert.strictEqual(cardsOff.find(c => c.type === 'heartRate').isAlert, false, 'disabled 心率不应 alert')
  assert.strictEqual(cardsOff.find(c => c.type === 'bloodOxygen').isAlert, false, 'disabled 血氧不应 alert')

  console.log('(c) getHealthCards 超阈值打 isAlert 通过')

  // ---- (e) 首页健康卡片屏蔽：睡眠/多运动不展示，历史页定义保留 ----
  resetStore()
  const deviceFull = {
    deviceId: DEVICE_ID,
    supportMenu: { hr: true, bloodOxy: true, step: true, sleep: true, newSport: true }
  }
  const cardsFull = capabilities.getHealthCards(deviceFull, {})
  assert.ok(!cardsFull.some(c => c.type === 'sleep'), '睡眠卡片应被屏蔽')
  assert.ok(!cardsFull.some(c => c.type === 'workout'), '多运动卡片应被屏蔽')
  assert.ok(cardsFull.some(c => c.type === 'steps') && cardsFull.some(c => c.type === 'heartRate'), '其余卡片不受影响')
  assert.ok(capabilities.findHealthType('sleep'), '历史页 sleep 定义应保留')
  assert.ok(capabilities.findHealthType('workout'), '历史页 workout 定义应保留')

  console.log('(e) 首页健康卡片屏蔽 sleep/workout 通过')

  // ---- (b) evaluateHealthAlerts / getSyncIntervalMinutes 纯函数 ----
  const alert = capabilities.evaluateHealthAlerts(
    { heartRate: [{ value: '150', measuredAt: Date.now() }], bloodOxygen: [{ value: '--', measuredAt: Date.now() }] },
    { heartRateAlert: { enabled: true, high: 120 }, bloodOxygenAlert: { enabled: true, low: 90 } }
  )
  assert.strictEqual(alert.heartRate, true)
  assert.strictEqual(alert.bloodOxygen, false, '"--" 应跳过')
  assert.strictEqual(alert.text, '心率超出您设置的提醒值')

  const alertNone = capabilities.evaluateHealthAlerts(
    { heartRate: [{ value: '--', measuredAt: Date.now() }] },
    { heartRateAlert: { enabled: true, high: 120 } }
  )
  assert.strictEqual(alertNone.heartRate, false)
  assert.strictEqual(alertNone.text, '')

  console.log('(b) evaluateHealthAlerts 纯函数 通过')

  console.log('device-local-personalization tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
