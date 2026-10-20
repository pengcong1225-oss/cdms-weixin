// 2026-10-20 用户报障：医生小程序「退出登录」/会话过期后会在「登录会话已过期」页反复循环。
// 根因：home.onShow 在医生角色(H5)时自动 redirectDoctorWorkspace() —— 过期页点返回 → home → 又被弹进 H5。
// 本用例是判别性的（mutant 必须变红）：
//   ① 带 returnedFromExpired 标记 → onLoad 不自动进（去掉标志判断应必红）；
//   ② 首次 onLoad（无标记）→ 仍自动进一次（回归，保持原体验）；
//   ③ onShow 常规 / 角色切到医生 → 不自动进（恢复旧自动跳逻辑应必红）。
const assert = require('assert')
const path = require('path')

const homePath = path.resolve(__dirname, '../miniprogram/pages/home/home.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')

let pageConfig
let app
let handoffCalls = []
let redirectCalls = []
let relaunchCalls = []
let navigateCalls = []

function resetWx () {
  handoffCalls = []
  redirectCalls = []
  relaunchCalls = []
  navigateCalls = []
}

global.getApp = () => app
global.Page = config => { pageConfig = config }
global.wx = {
  redirectTo: options => { redirectCalls.push(options && options.url) },
  navigateTo: options => { navigateCalls.push(options && options.url) },
  reLaunch: options => { relaunchCalls.push(options && options.url) },
  switchTab: () => undefined,
  showToast: () => undefined,
  showModal: options => { if (options && options.success) options.success({ confirm: true }) },
  getStorageSync: () => '',
  setStorageSync: () => undefined,
  removeStorageSync: () => undefined
}

require.cache[bleManagerPath] = {
  id: bleManagerPath,
  filename: bleManagerPath,
  loaded: true,
  exports: {
    subscribe: () => () => undefined,
    snapshot: () => ({ boundDevice: null, realtimeHealth: {}, foreignDevice: false, healthSyncing: false, connected: false }),
    scheduleAutoSync: () => undefined,
    stopAutoSync: () => undefined,
    safeAutoSync: () => Promise.resolve(),
    disconnectForLogout: async () => undefined
  }
}

require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    readQueue: () => [],
    createHandoff: async targetPath => {
      handoffCalls.push(targetPath)
      return { data: { handoffUrl: 'https://h5.example.com/cdms/#/patients' } }
    },
    cdmsRequest: async () => ({ data: { count: 0, patientId: '42', patientName: '张三', patientPhone: '13812345678' } }),
    logout: async () => undefined
  }
}

delete require.cache[homePath]
require(homePath)

function createPage () {
  return Object.assign({}, pageConfig, {
    data: Object.assign({}, pageConfig.data),
    setData (patch) { Object.assign(this.data, patch) }
  })
}

function doctorApp (extra) {
  return { globalData: Object.assign({ activeRole: 'DOCTOR', cdmsBaseUrl: 'https://cdms.example', accessToken: 'doctor-token' }, extra || {}) }
}

const tick = () => new Promise(resolve => setImmediate(resolve))

async function run () {
  // ① 带 returnedFromExpired（query）→ 不自动进工作台
  app = doctorApp()
  resetWx()
  let page = createPage()
  page.onLoad({ returnedFromExpired: '1' })
  await tick()
  assert.strictEqual(handoffCalls.length, 0, 'returnedFromExpired 时不得自动进医生工作台（否则死循环重现）')
  assert.strictEqual(redirectCalls.length, 0, 'returnedFromExpired 时不得 redirectTo H5')

  // ①b globalData 标记同样生效，且读取后清掉
  app = doctorApp({ returnedFromExpired: true })
  resetWx()
  page = createPage()
  page.onLoad({})
  await tick()
  assert.strictEqual(handoffCalls.length, 0, 'globalData.returnedFromExpired 时不得自动进')
  assert.strictEqual(app.globalData.returnedFromExpired, false, '返回标记必须被清掉')

  // ② 首次 onLoad（无标记）→ 仍自动进一次
  app = doctorApp()
  resetWx()
  page = createPage()
  page.onLoad({})
  await tick()
  assert.deepStrictEqual(handoffCalls, ['/h5/patients'], '首次进入仍应自动 createHandoff 一次')
  assert.strictEqual(redirectCalls.length, 1, '首次进入仍应跳一次 H5')
  assert.ok(String(redirectCalls[0]).startsWith('/pages/h5/index?url='), '跳转目标应为 H5 容器页')
  assert.strictEqual(page.workspaceAutoEntered, true, '应记录已自动进过工作台')

  // ③ onShow（常规，非首次）→ 不再自动进
  resetWx()
  page.onShow()
  await tick()
  assert.strictEqual(handoffCalls.length, 0, 'onShow 不得自动 createHandoff')
  assert.strictEqual(redirectCalls.length, 0, 'onShow 不得自动 redirectTo H5')

  // ③b 角色切到 DOCTOR 后再 onShow → 也不得自动进
  app = { globalData: { activeRole: 'PATIENT', cdmsBaseUrl: 'https://cdms.example', accessToken: 'patient-token' } }
  resetWx()
  page = createPage()
  page.onLoad({})
  await tick()
  assert.strictEqual(handoffCalls.length, 0, '患者首页不得 createHandoff')
  app.globalData.activeRole = 'DOCTOR'
  page.onShow()
  await tick()
  assert.strictEqual(handoffCalls.length, 0, '角色切到医生后 onShow 也不得自动进工作台')
  assert.strictEqual(redirectCalls.length, 0, '角色切到医生后 onShow 也不得 redirectTo H5')

  console.log('home workspace redirect tests passed')
}

run().catch(error => { console.error(error); process.exit(1) })
