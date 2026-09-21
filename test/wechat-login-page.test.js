// 患者登录页契约：患者使用「姓名 + 已建档手机号」直登（api.loginPatient），
// 不再出现微信授权入口，也不再调用 wx.login；医生登录与角色跳转逻辑保持原样。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

// ---------- 静态契约 ----------
const wxml = fs.readFileSync('miniprogram/pages/auth/login.wxml', 'utf8')
const js = fs.readFileSync('miniprogram/pages/auth/login.js', 'utf8')
const homeWxml = fs.readFileSync('miniprogram/pages/home/home.wxml', 'utf8')
const homeJs = fs.readFileSync('miniprogram/pages/home/home.js', 'utf8')

assert.ok(wxml.includes('患者姓名'), '患者模式应提供姓名输入框')
assert.ok(wxml.includes('onRealName'), '姓名输入框应绑定 onRealName')
assert.ok(wxml.includes('患者手机号'))
assert.ok(wxml.includes('医生登录'))
assert.ok(wxml.includes('医生账号'))
assert.ok(wxml.includes('进入医生工作台'))
assert.ok(wxml.includes('type="password"'))
assert.ok(wxml.includes('>登录<'), '患者登录按钮文案应为「登录」')
assert.ok(!wxml.includes('微信授权'), '页面不得再出现微信授权文案')
assert.ok(js.includes('loginDoctor'))
assert.ok(js.includes('loginPatient'))
assert.ok(js.includes('onRealName'))
assert.ok(js.includes('selectRole'))
assert.ok(!js.includes('loginWithWechat'), '页面不得再调用 loginWithWechat')
assert.ok(!js.includes('wx.login'), '页面不得再调用 wx.login')
assert.ok(!homeWxml.includes('切换身份'))
assert.ok(!homeWxml.includes('bindtap="switchRole"'))
assert.ok(!homeJs.includes('async switchRole'))

// ---------- 行为契约（mock Page / wx / api） ----------
const pagePath = path.resolve(__dirname, '../miniprogram/pages/auth/login.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')

const VALIDATION_MESSAGE = '请输入患者姓名和已建档的 11 位手机号'

let apiCalls = []
let wxLoginCalls = 0
let toastCalls = []
let relaunchCalls = []
let redirectCalls = []
let savedSession = null

require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    loginDoctor: async payload => {
      apiCalls.push({ fn: 'loginDoctor', payload })
      return { data: { token: 'doctor-token', activeRole: 'DOCTOR' } }
    },
    loginPatient: async payload => {
      apiCalls.push({ fn: 'loginPatient', payload })
      return { data: { token: 'patient-token', activeRole: 'PATIENT' } }
    },
    switchRole: async roleType => {
      apiCalls.push({ fn: 'switchRole', payload: roleType })
      return { data: { token: 'switched', activeRole: roleType } }
    },
    createHandoff: async targetPath => {
      apiCalls.push({ fn: 'createHandoff', payload: targetPath })
      return { data: { handoffUrl: 'https://h5.example.com/cdms/#/patients' } }
    }
  }
}

global.wx = {
  login () {
    wxLoginCalls += 1
    throw new Error('wx.login 不应再被调用')
  },
  showToast (options) { toastCalls.push(options || {}) },
  reLaunch (options) { relaunchCalls.push(options && options.url) },
  redirectTo (options) { redirectCalls.push(options && options.url) }
}
global.getApp = () => ({ globalData: {}, saveAuth: session => { savedSession = session } })

let pageConfig
global.Page = config => { pageConfig = config }

function loadPage () {
  delete require.cache[pagePath]
  require(pagePath)
  const page = Object.assign({}, pageConfig)
  page.data = Object.assign({}, pageConfig.data)
  page.setData = patch => { Object.assign(page.data, patch) }
  return page
}

function resetLogs () {
  apiCalls = []
  toastCalls = []
  relaunchCalls = []
  redirectCalls = []
  savedSession = null
}

async function run () {
  // 1) 患者姓名为空 → 前端拦截，不发请求、不调 wx.login
  let page = loadPage()
  resetLogs()
  page.data.mode = 'patient'
  page.data.realName = ''
  page.data.phone = '13900000000'
  await page.login()
  assert.strictEqual(apiCalls.length, 0, '姓名为空不得发起登录请求')
  assert.deepStrictEqual(toastCalls.map(item => item.title), [VALIDATION_MESSAGE])
  assert.strictEqual(page.data.loading, false, '拦截后不应停留在 loading')

  // 2) 姓名仅 1 个字符 → 前端拦截
  page = loadPage()
  resetLogs()
  page.data.mode = 'patient'
  page.data.realName = '张'
  page.data.phone = '13900000000'
  await page.login()
  assert.strictEqual(apiCalls.length, 0, '姓名过短不得发起登录请求')
  assert.deepStrictEqual(toastCalls.map(item => item.title), [VALIDATION_MESSAGE])

  // 3) 手机号非法 → 前端拦截
  page = loadPage()
  resetLogs()
  page.data.mode = 'patient'
  page.data.realName = '张三'
  page.data.phone = '1234567890'
  await page.login()
  assert.strictEqual(apiCalls.length, 0, '手机号非法不得发起登录请求')
  assert.deepStrictEqual(toastCalls.map(item => item.title), [VALIDATION_MESSAGE])

  // 4) 合法患者登录 → loginPatient({ realName, phone })，姓名 trim 后提交
  page = loadPage()
  resetLogs()
  page.data.mode = 'patient'
  page.data.realName = '  张三  '
  page.data.phone = '13900000000'
  await page.login()
  assert.deepStrictEqual(apiCalls, [{
    fn: 'loginPatient',
    payload: { realName: '张三', phone: '13900000000' }
  }])
  assert.deepStrictEqual(savedSession, { token: 'patient-token', activeRole: 'PATIENT' })
  assert.deepStrictEqual(relaunchCalls, ['/pages/home/home'], '患者登录后进入患者首页')
  assert.strictEqual(wxLoginCalls, 0, '患者登录全程不得调用 wx.login')

  // 5) 医生登录与 H5 handoff 跳转保持不变
  page = loadPage()
  resetLogs()
  page.data.mode = 'doctor'
  page.data.username = 'doctor-1'
  page.data.password = 'secret'
  await page.login()
  assert.deepStrictEqual(apiCalls[0], {
    fn: 'loginDoctor',
    payload: { username: 'doctor-1', password: 'secret' }
  })
  assert.strictEqual(apiCalls[1].fn, 'createHandoff')
  assert.strictEqual(apiCalls[1].payload, '/h5/patients')
  assert.deepStrictEqual(redirectCalls, ['/pages/h5/index?url=' + encodeURIComponent('https://h5.example.com/cdms/#/patients')])
  assert.strictEqual(wxLoginCalls, 0)

  console.log('wechat-login-page tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
