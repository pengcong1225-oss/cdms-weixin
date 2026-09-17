const assert = require('assert')
const fs = require('fs')
const path = require('path')

const homePath = path.resolve(__dirname, '../miniprogram/pages/home/home.js')
const homeWxmlPath = path.resolve(__dirname, '../miniprogram/pages/home/home.wxml')
const devicePath = path.resolve(__dirname, '../miniprogram/pages/device/device.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const capabilitiesPath = path.resolve(__dirname, '../miniprogram/utils/capabilities.js')

const store = {}
global.getApp = () => ({ globalData: { activeRole: 'PATIENT', patientRef: '', cdmsBaseUrl: '', accessToken: '' } })
global.wx = {
  getStorageSync: key => (Object.prototype.hasOwnProperty.call(store, key) ? store[key] : ''),
  setStorageSync: (key, value) => { store[key] = value },
  removeStorageSync: key => { delete store[key] },
  showToast: () => undefined
}

async function run () {
  // ---------- 1) HRV/压力 已从健康卡片与设置项移除 ----------
  delete require.cache[capabilitiesPath]
  const capabilities = require(capabilitiesPath)
  const fullMenu = {
    step: true, hr: true, sleep: true, newSport: true, workout: true, bloodOxy: true,
    hrv: true, pressure: true, bloodPress: true, bloodSugar: true, temperature: true,
    alarm: true, dnd: true, findDevice: true, takePhoto: true, supportPPGMonitoring: true
  }
  const cards = capabilities.getHealthCards({ deviceId: 'dev-1', supportMenu: fullMenu }, {})
  const cardTypes = cards.map(item => item.type)
  assert.ok(!cardTypes.includes('hrv'), 'HRV 不应出现在首页健康卡片')
  assert.ok(!cardTypes.includes('stress'), '压力 不应出现在首页健康卡片')
  assert.ok(cardTypes.includes('heartRate') && cardTypes.includes('bloodOxygen'), '心率/血氧卡片应保留')
  const settingIds = capabilities.getSettings(fullMenu).map(item => item.id)
  assert.ok(!settingIds.includes('hrvMonitoring'), '全天 HRV 设置项应已移除')
  assert.ok(!settingIds.includes('stressMonitoring'), '全天压力 设置项应已移除')
  assert.ok(settingIds.includes('heartRateMonitoring'), '全天心率设置项应保留')

  // ---------- 2) device.js 不再下发 HRV/压力 监测配置 ----------
  let pageConfig
  const monitoringCalls = []
  global.Page = config => { pageConfig = config }
  const sdk = { setMonitoring: async (...args) => monitoringCalls.push(args) }
  require.cache[bleManagerPath] = { id: bleManagerPath, filename: bleManagerPath, loaded: true, exports: { getSdk: () => sdk } }
  delete require.cache[devicePath]
  require(devicePath)
  const devicePage = Object.assign({}, pageConfig, { updateSettingValue: () => undefined })
  await assert.rejects(() => devicePage.executeSetting('hrvMonitoring'), /暂未配置操作模型/,
    'HRV 设置项应不再是可执行监测项')
  await assert.rejects(() => devicePage.executeSetting('stressMonitoring'), /暂未配置操作模型/,
    '压力 设置项应不再是可执行监测项')
  assert.deepStrictEqual(monitoringCalls, [], '不应再下发 HRV/压力 监测配置')

  // ---------- 3) 首页新增“同步数据”按钮并触发同步 ----------
  const wxml = fs.readFileSync(homeWxmlPath, 'utf8')
  assert.ok(/bindtap="syncNow"/.test(wxml), '首页应有绑定 syncNow 的同步数据按钮')
  assert.ok(wxml.includes('同步数据'), '按钮文案应为“同步数据”')

  let syncCalls = 0
  const toasts = []
  require.cache[bleManagerPath] = {
    id: bleManagerPath, filename: bleManagerPath, loaded: true,
    exports: {
      subscribe: () => () => {},
      snapshot: () => ({ boundDevice: { deviceId: 'dev-1', lastHealthSyncAt: 0 }, connected: true, realtimeHealth: {} }),
      reconnect: async () => {},
      syncAllHealthData: async () => { syncCalls += 1; return { failedTypes: [], uploadError: null } },
      scheduleAutoSync: () => {}, stopAutoSync: () => {}, safeAutoSync: async () => {}
    }
  }
  require.cache[apiPath] = { id: apiPath, filename: apiPath, loaded: true, exports: { readQueue: () => [] } }
  global.wx.showToast = options => toasts.push(options)
  delete require.cache[homePath]
  require(homePath)
  const homePage = Object.assign({}, pageConfig, {
    data: Object.assign({}, pageConfig.data, { healthSyncing: false }),
    setData (values) { Object.assign(this.data, values) }
  })
  await homePage.syncNow()
  assert.strictEqual(syncCalls, 1, '点击“同步数据”应触发一次同步')
  assert.ok(toasts.some(item => item.title === '同步完成'), '同步成功应提示“同步完成”')
  homePage.data.healthSyncing = true
  await homePage.syncNow()
  assert.strictEqual(syncCalls, 1, '同步进行中应忽略重复点击')

  console.log('home sync button + hrv/stress removal tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
