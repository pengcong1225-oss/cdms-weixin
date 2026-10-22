// 2026-10-22 需求：患者小程序登录页《隐私政策》链接 + 登录前必须勾选同意（首次同意记忆）。
// 判别性用例（mutant 必须变红）：
//   ① 未勾选 → 不发登录请求（去掉校验必红）；
//   ③ 医生模式未勾选 → 照常登录（给医生加校验必红）；
//   ④ storage 已同意同版本 → 进页面自动勾选（去掉读取逻辑必红）；
//   ⑤ storage 旧版本 → 不自动勾选（去掉版本判断必红）。
const { test } = require('node:test')
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const loginPath = path.resolve(__dirname, '../miniprogram/pages/auth/login.js')
const privacyPath = path.resolve(__dirname, '../miniprogram/pages/privacy/index.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const STORAGE_KEY = 'jq_privacy_agreed_version'
const CURRENT_VERSION = '2026-10'

let storage
let apiCalls
let toastCalls
let navigateToCalls
let navigateBackCalls
let relaunchCalls
let pageConfig

global.getApp = () => ({ globalData: { cdmsBaseUrl: '' }, saveAuth () {} })
global.Page = config => { pageConfig = config }
global.wx = {
  getStorageSync: key => (storage.has(key) ? storage.get(key) : ''),
  setStorageSync: (key, value) => storage.set(key, value),
  removeStorageSync: key => storage.delete(key),
  showToast: options => { toastCalls.push(options || {}) },
  navigateTo: options => { navigateToCalls.push(options && options.url) },
  navigateBack: options => {
    navigateBackCalls.push(options || {})
    if (options && typeof options.success === 'function') options.success()
  },
  reLaunch: options => { relaunchCalls.push(options && options.url) },
  redirectTo: () => undefined
}

require.cache[apiPath] = {
  id: apiPath,
  filename: apiPath,
  loaded: true,
  exports: {
    loginPatient: async payload => { apiCalls.push({ fn: 'loginPatient', payload }); return { data: { token: 't', activeRole: 'PATIENT' } } },
    loginDoctor: async payload => { apiCalls.push({ fn: 'loginDoctor', payload }); return { data: { token: 'd', activeRole: 'DOCTOR' } } },
    createHandoff: async targetPath => { apiCalls.push({ fn: 'createHandoff', payload: targetPath }); return { data: { handoffUrl: 'https://h5.example.com/cdms/#/patients' } } },
    switchRole: async () => ({ data: {} }),
    refreshAccessToken: async () => 'fresh-token'
  }
}

function reset () {
  storage = new Map()
  apiCalls = []
  toastCalls = []
  navigateToCalls = []
  navigateBackCalls = []
  relaunchCalls = []
  pageConfig = null
}

function loadPage (file) {
  delete require.cache[file]
  require(file)
  const page = Object.assign({}, pageConfig)
  page.data = Object.assign({}, pageConfig.data)
  page.setData = patch => { Object.assign(page.data, patch) }
  return page
}

function patientPage (privacyAgreed) {
  const page = loadPage(loginPath)
  page.data.mode = 'patient'
  page.data.realName = '张三'
  page.data.phone = '13900000000'
  page.data.privacyAgreed = privacyAgreed
  return page
}

test('① 患者未勾选《隐私政策》→ 不发起登录请求，只提示', async () => {
  reset()
  const page = patientPage(false)
  await page.login()
  assert.strictEqual(apiCalls.length, 0, '未勾选同意时不得发起任何登录请求（必须在接口调用之前拦截）')
  assert.deepStrictEqual(toastCalls.map(item => item.title), ['请先阅读并同意《隐私政策》'])
  assert.strictEqual(page.data.loading, false, '被拦截后不应进入 loading')
})

test('② 患者已勾选 → 正常发起 loginPatient', async () => {
  reset()
  const page = patientPage(true)
  await page.login()
  assert.deepStrictEqual(apiCalls.map(item => item.fn), ['loginPatient'])
  assert.deepStrictEqual(apiCalls[0].payload, { realName: '张三', phone: '13900000000' })
})

test('③ 医生模式未勾选 → 不受隐私政策影响，照常登录', async () => {
  reset()
  const page = loadPage(loginPath)
  page.data.mode = 'doctor'
  page.data.username = 'doctor-1'
  page.data.password = 'secret'
  page.data.privacyAgreed = false
  await page.login()
  assert.strictEqual(apiCalls[0] && apiCalls[0].fn, 'loginDoctor', '医生为工作人员，不适用患者隐私政策')
  assert.strictEqual(toastCalls.length, 0, '医生登录不得被隐私政策拦截')
})

test('④ storage 已记录同版本同意 → 进页面自动勾选', () => {
  reset()
  storage.set(STORAGE_KEY, CURRENT_VERSION)
  const page = loadPage(loginPath)
  page.onLoad({})
  assert.strictEqual(page.data.privacyAgreed, true, '同版本已同意必须自动勾选（首次同意后记忆）')
})

test('⑤ storage 为旧版本 → 不自动勾选，需重新同意', async () => {
  reset()
  storage.set(STORAGE_KEY, '2025-01')
  const page = loadPage(loginPath)
  page.onLoad({})
  assert.strictEqual(page.data.privacyAgreed, false, '政策版本升级后必须重新勾选同意')
  page.data.mode = 'patient'
  page.data.realName = '张三'
  page.data.phone = '13900000000'
  await page.login()
  assert.strictEqual(apiCalls.length, 0, '旧版本同意不能通过登录校验')
})

test('⑥ 点击《隐私政策》→ 打开隐私政策页', () => {
  reset()
  const page = loadPage(loginPath)
  page.openPrivacy()
  assert.deepStrictEqual(navigateToCalls, ['/pages/privacy/index'])
})

test('⑦ 隐私页：88 段全部渲染；同意写记录并返回；可撤回', () => {
  reset()
  const page = loadPage(privacyPath)
  page.onLoad()
  assert.strictEqual(page.data.paragraphs.length, 88, '隐私政策正文必须完整渲染 88 段')
  assert.strictEqual(page.data.paragraphs[0], '隐私政策', '首段为标题')
  assert.ok(String(page.data.paragraphs[87]).includes('生效时间'), '末段为生效时间')
  const wxml = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/privacy/index.wxml'), 'utf8')
  assert.ok(wxml.includes('wx:for="{{paragraphs}}"'), '正文必须按段循环渲染')
  assert.ok(wxml.includes('bindtap="agree"'), '底部必须有「我已阅读并同意」按钮')

  page.agree()
  assert.strictEqual(storage.get(STORAGE_KEY), CURRENT_VERSION, '同意后必须写入当前政策版本')
  assert.strictEqual(navigateBackCalls.length, 1, '同意后必须返回登录页')

  page.withdraw()
  assert.strictEqual(storage.has(STORAGE_KEY), false, '撤回同意必须清除记录')
  assert.strictEqual(page.data.agreed, false)
})

test('⑧ 同意页返回后登录页 onShow 自动勾选；取消勾选即撤回记录', () => {
  reset()
  storage.set(STORAGE_KEY, CURRENT_VERSION)
  const page = loadPage(loginPath)
  page.onShow()
  assert.strictEqual(page.data.privacyAgreed, true, '隐私页同意返回后登录页应自动勾选')
  page.togglePrivacyAgree()
  assert.strictEqual(page.data.privacyAgreed, false)
  assert.strictEqual(storage.has(STORAGE_KEY), false, '未勾选/取消勾选不得保留同意记录')
  page.togglePrivacyAgree()
  assert.strictEqual(page.data.privacyAgreed, true)
  assert.strictEqual(storage.get(STORAGE_KEY), CURRENT_VERSION, '勾选同意才写 storage')
})

test('⑨ 原生 checkbox 必须走 bindchange（受控）：data 与 storage 同步', () => {
  reset()
  const wxml = fs.readFileSync(path.resolve(__dirname, '../miniprogram/pages/auth/login.wxml'), 'utf8')
  assert.ok(/<checkbox-group[^>]*bindchange="onPrivacyChange"/.test(wxml),
    '原生 checkbox 必须由 checkbox-group 的 bindchange 驱动（受控），否则原生态与 data 会不同步')
  assert.ok(!/bindtap="onPrivacyChange"/.test(wxml),
    '不允许用 bindtap 驱动原生 checkbox')
  assert.ok(wxml.includes('value="agree"'), 'checkbox 必须带 value="agree"')

  const page = loadPage(loginPath)
  page.onPrivacyChange({ detail: { value: ['agree'] } })
  assert.strictEqual(page.data.privacyAgreed, true, 'bindchange 勾选后 data 必须为 true')
  assert.strictEqual(storage.get(STORAGE_KEY), CURRENT_VERSION, '勾选同意必须写入当前政策版本')

  page.onPrivacyChange({ detail: { value: [] } })
  assert.strictEqual(page.data.privacyAgreed, false, 'bindchange 取消后 data 必须为 false')
  assert.strictEqual(storage.has(STORAGE_KEY), false, '取消勾选不得保留同意记录（撤回）')
})
