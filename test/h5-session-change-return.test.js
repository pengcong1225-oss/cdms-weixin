// 2026-10-20：H5 容器页 onShow 检测会话 token 变化 → 退回宿主首页，
// 不再让用户对着已失效的 H5 死页面（旧 handoff 复用的另一种死循环入口）。
// 判别性：去掉 onShow 的 token 变化检测应必红。
const assert = require('assert')
const path = require('path')

const h5Path = path.resolve(__dirname, '../miniprogram/pages/h5/index.js')
const sessionStorePath = path.resolve(__dirname, '../miniprogram/utils/session-store.js')
const authGuardPath = path.resolve(__dirname, '../miniprogram/utils/auth-guard.js')

let pageConfig
let app
let navCalls
let relaunchCalls
let toastCalls

global.Page = config => { pageConfig = config }
global.wx = {
  showToast: options => { toastCalls.push(options) },
  navigateBack: options => {
    navCalls.push(options || {})
    if (options && typeof options.success === 'function') options.success()
  },
  reLaunch: options => { relaunchCalls.push(options && options.url) }
}

require.cache[sessionStorePath] = {
  id: sessionStorePath, filename: sessionStorePath, loaded: true,
  exports: { clearSession: () => ({}) }
}
require.cache[authGuardPath] = {
  id: authGuardPath, filename: authGuardPath, loaded: true,
  exports: { purgeSession: () => undefined }
}

function loadPage (token) {
  navCalls = []
  relaunchCalls = []
  toastCalls = []
  app = { globalData: { accessToken: token } }
  global.getApp = () => app
  delete require.cache[h5Path]
  require(h5Path)
  const page = Object.assign({}, pageConfig, { data: Object.assign({}, pageConfig.data) })
  page.setData = patch => { Object.assign(page.data, patch) }
  return page
}

function openH5 (page) {
  page.onLoad({ url: encodeURIComponent('https://h5.example.com/cdms/#/patients') })
}

async function run () {
  // 1) 首次 onShow（token 未变）→ 不退出
  let page = loadPage('token-a')
  openH5(page)
  page.onShow()
  assert.strictEqual(navCalls.length, 0, '首次 onShow（token 未变）不得 navigateBack')

  // 2) token 变化 → navigateBack 回宿主，并置 returnedFromExpired 防死循环
  app.globalData.accessToken = 'token-b'
  page.onShow()
  assert.strictEqual(navCalls.length, 1, 'token 变化必须 navigateBack 回宿主')
  assert.strictEqual(navCalls[0].delta, 1)
  assert.strictEqual(app.globalData.returnedFromExpired, true, '必须置 returnedFromExpired 防死循环')

  // 3) 重复 onShow 不得反复 navigateBack
  page.onShow()
  page.onShow()
  assert.strictEqual(navCalls.length, 1, '重复 onShow 不得反复 navigateBack')
  assert.deepStrictEqual(relaunchCalls, [], 'navigateBack 成功时不应 reLaunch 登录页')

  // 4) token 未变时多次 onShow 也不退出
  page = loadPage('token-c')
  openH5(page)
  page.onShow()
  page.onShow()
  assert.strictEqual(navCalls.length, 0, 'token 未变时多次 onShow 不得退出')

  // 5) navigateBack 失败 → 降级 reLaunch 登录页
  global.wx.navigateBack = options => {
    navCalls.push(options || {})
    if (options && typeof options.fail === 'function') options.fail({ errMsg: 'navigateBack:fail no page' })
  }
  page = loadPage('token-d')
  openH5(page)
  app.globalData.accessToken = 'token-e'
  page.onShow()
  assert.deepStrictEqual(relaunchCalls, ['/pages/auth/login'], '返回失败应降级 reLaunch 登录页')

  console.log('h5 session change return tests passed')
}

run().catch(error => { console.error(error); process.exit(1) })
