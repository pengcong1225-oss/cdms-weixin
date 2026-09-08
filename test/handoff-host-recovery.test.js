// §8.2 / §16.3：web-view 宿主监听 H5 handoff 失败消息（postMessage / URL 约定），
// 执行 navigateBack；返回失败则 reLaunch 小程序登录页，杜绝 H5 死路。
// 纯 node assert，mock Page/wx/storage。
const assert = require('assert')
const path = require('path')

const pagePath = path.resolve(__dirname, '../miniprogram/pages/h5/index.js')
const sessionStorePath = path.resolve(__dirname, '../miniprogram/utils/session-store.js')
const authGuardPath = path.resolve(__dirname, '../miniprogram/utils/auth-guard.js')

let store, navCalls, relaunchCalls, toastCalls, timers
global.wx = {
  getStorageSync: key => (store.has(key) ? store.get(key) : ''),
  setStorageSync: (key, value) => store.set(key, value),
  removeStorageSync: key => store.delete(key),
  showToast: () => { toastCalls.push(1) },
  navigateBack: options => {
    navCalls.push(options || {})
    if (options && typeof options.fail === 'function') options.fail({ errMsg: 'navigateBack:fail no page' })
  },
  reLaunch: options => { relaunchCalls.push(options.url) }
}
let pageConfig
global.Page = config => { pageConfig = config }
global.getApp = () => ({ globalData: {} })
global.setTimeout = (fn) => { timers.push(fn); return timers.length }

function loadPage (opts) {
  const o = opts || {}
  store = new Map()
  navCalls = []; relaunchCalls = []; toastCalls = []; timers = []
  // 预置一份完整会话，验证恢复流程会整体清空它。
  store.set('cdms.miniapp.session.v1', {
    version: 1, refreshToken: 'r', accessToken: 'a', activeRole: 'DOCTOR',
    patientId: 'patient-old', principalId: 'p-1', identityId: 'p-1', orgId: '',
    tokenVersion: null, issuedAt: 1, roles: [], cdmsBaseUrl: '', orgName: '', patientRef: 'patient-old',
    handoffSession: { code: 'one-time-code', url: '', targetPath: '', issuedAt: null },
    wearableSession: { iotBaseUrl: '', wearableToken: 'wear', wearableSessionId: '', deviceRef: '', patientId: '' }
  })
  delete require.cache[pagePath]
  delete require.cache[sessionStorePath]
  delete require.cache[authGuardPath]
  require(pagePath)
  // 绑定到一个带 setData 的页面实例（小程序运行时会自动提供 this）。
  const page = Object.create(null)
  Object.assign(page, pageConfig)
  page.data = Object.assign({}, pageConfig.data)
  page.setData = patch => { Object.assign(page.data, patch) }
  return page
}

function drainTimers () { timers.forEach(fn => fn()) }

async function run () {
  // —— 1. postMessage 携带 handoff 失败信令 → navigateBack —— 
  let page = loadPage()
  page.onLoad({ url: encodeURIComponent('https://h5/cdms/#/handoff?code=abc') })
  assert.strictEqual(navCalls.length, 0, '正常地址不触发恢复')
  page.onWebViewMessage({ detail: { data: [{ type: 'height', value: 300 }] } })
  assert.strictEqual(navCalls.length, 0, '普通业务消息（height）不得误触发恢复')
  page.onWebViewMessage({ detail: { data: [{ type: 'cdms:handoff-failed' }] } })
  assert.strictEqual(navCalls.length, 1, 'handoff 失败信令必须触发 navigateBack')
  assert.strictEqual(navCalls[0].delta, 1)
  // 会话被整体清空（含一次性 handoff code、旧患者、穿戴 token）
  assert.strictEqual(store.has('cdms.miniapp.session.v1'), false, 'recovery purges the whole session object')
  assert.strictEqual(store.has('cdms.miniapp.auth'), false, 'legacy keys also purged')

  // —— 2. navigateBack 失败 → reLaunch 登录页兜底 —— 
  page = loadPage()
  page.onLoad({ url: encodeURIComponent('https://h5/cdms/#/handoff') })
  page.onWebViewMessage({ detail: { data: { action: 'handoff_failed' } } })
  assert.strictEqual(navCalls.length, 1, '尝试返回宿主')
  assert.deepStrictEqual(relaunchCalls, ['/pages/auth/login'],
    '返回失败后必须 reLaunch 小程序登录页（§8.2 / §16.3）')
  assert.strictEqual(store.has('cdms.miniapp.session.v1'), false, '兜底路径同样整体清会话')

  // —— 3. navigateBack 既不 success 也不 fail（无回调）→ 超时兜底 reLaunch —— 
  page = loadPage()
  global.wx.navigateBack = options => { navCalls.push(options || {}) } // 故意不调用任何回调
  page.onLoad({ url: encodeURIComponent('https://h5/cdms/#/handoff') })
  page.onWebViewMessage({ detail: { data: [{ event: 'cdms-handoff-failed' }] } })
  assert.strictEqual(navCalls.length, 1)
  assert.deepStrictEqual(relaunchCalls, [], '回调未回来前不应立即 reLaunch')
  drainTimers()
  assert.deepStrictEqual(relaunchCalls, ['/pages/auth/login'], '超时后转 reLaunch 登录页')
  global.wx.navigateBack = options => {
    navCalls.push(options || {})
    if (options && typeof options.fail === 'function') options.fail({})
  }

  // —— 4. URL 约定：进入即带失败标记 → 直接走恢复（navigateBack，失败则 reLaunch）—— 
  page = loadPage()
  page.onLoad({ url: encodeURIComponent('https://h5/cdms/#/login?cdmsHandoffFailed=1') })
  assert.strictEqual(navCalls.length, 1, 'URL 失败标记应触发恢复')
  assert.deepStrictEqual(relaunchCalls, ['/pages/auth/login'], '返回失败后兜底登录页')

  // —— 5. 单次加载只恢复一次（防抖，避免兑换失败循环重试同一 code）—— 
  page = loadPage()
  page.onLoad({ url: encodeURIComponent('https://h5/cdms/#/handoff') })
  page.onWebViewMessage({ detail: { data: [{ type: 'handoff-failed' }] } })
  const firstNav = navCalls.length
  page.onWebViewMessage({ detail: { data: [{ type: 'handoff-failed' }] } })
  assert.strictEqual(navCalls.length, firstNav, '重复失败信令不得反复触发恢复')

  console.log('handoff host recovery tests passed')
}

run().catch(error => { console.error(error); process.exit(1) })