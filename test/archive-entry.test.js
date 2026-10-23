// 患者登录页「建档」入口：复用 cdmsManager 既有 H5 建档问卷（提交即创建患者档案）。
// 校验三件事：①登录页有入口且能跳到真实页面；②页面已注册路由；③web-view 只允许受信任域名。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'miniprogram')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

// ---- 1. 登录页入口 ----

const loginWxml = read('pages/auth/login.wxml')
const loginJs = read('pages/auth/login.js')
const appJson = JSON.parse(read('app.json'))

assert.ok(loginWxml.includes('bindtap="openArchive"'), '登录页必须提供建档入口')
assert.ok(loginWxml.includes('填写建档问卷'), '入口文案需明确是「填写建档问卷」')
assert.ok(loginWxml.includes('还没有档案'), '缺少「还没有档案？」引导语')
// 入口必须在患者登录分支内（医生分支不得出现建档入口）
const doctorBlock = loginWxml.split("mode === 'doctor'")[1].split("wx:else")[0] || ''
assert.ok(!doctorBlock.includes('openArchive'), '医生登录分支不得出现患者建档入口')

assert.ok(/openArchive\s*\(\)\s*\{/.test(loginJs), 'login.js 缺少 openArchive 方法')
assert.ok(loginJs.includes("'/pages/archive/index'"), 'openArchive 必须跳转建档页面')

// ---- 2. 路由注册与页面文件 ----

assert.ok(appJson.pages.includes('pages/archive/index'), 'app.json 未注册 pages/archive/index')
for (const ext of ['js', 'json', 'wxml', 'wxss']) {
  assert.ok(fs.existsSync(path.join(root, 'pages/archive/index.' + ext)),
    'missing file: pages/archive/index.' + ext)
}
const archiveWxml = read('pages/archive/index.wxml')
assert.ok(archiveWxml.includes('<web-view'), '建档页必须用 web-view 承载既有 H5 问卷')
assert.ok(archiveWxml.includes('无法打开建档问卷'), '缺少地址非法时的兜底提示')

// ---- 3. 运行时地址 + 域名白名单 ----

const runtimeConfig = require('../miniprogram/config/runtime')
assert.ok(runtimeConfig.archiveQuestionnaireUrl, 'runtime.js 缺少 archiveQuestionnaireUrl')
assert.ok(runtimeConfig.archiveQuestionnaireUrl.startsWith('https://'), '建档问卷必须是 https')
assert.ok(runtimeConfig.archiveQuestionnaireUrl.includes('/mzf-sq/'), '应指向 cdmsManager 既有 H5 问卷')

// ---- 4. 页面逻辑：默认地址 / query 覆盖 / 域名与协议拦截 ----

let pageConfig = null
let modalCalls = 0
global.Page = config => { pageConfig = config }
global.wx = {
  showModal () { modalCalls += 1 },
  navigateTo () {}
}
require('../miniprogram/pages/archive/index.js')
assert.ok(pageConfig && typeof pageConfig.onLoad === 'function', 'archive 页面未导出 Page 配置')

function loadWith (query) {
  const page = {
    data: { src: '', error: '' },
    setData (patch) { Object.assign(this.data, patch) }
  }
  pageConfig.onLoad.call(page, query)
  return page
}

// 4.1 默认打开配置地址
const byDefault = loadWith({})
assert.strictEqual(byDefault.data.src, runtimeConfig.archiveQuestionnaireUrl)
assert.strictEqual(byDefault.data.error, '')

// 4.2 允许 https 白名单域名覆盖（联调用）
const override = 'https://jq.mockr.com.cn/mzf-sq/#/screen?orgId=1'
assert.strictEqual(loadWith({ url: encodeURIComponent(override) }).data.src, override)

// 4.3 非白名单域名被拒绝，且不渲染 web-view
const evil = loadWith({ url: encodeURIComponent('https://evil.example.com/phish') })
assert.strictEqual(evil.data.src, '', '非白名单域名不得加载')
assert.ok(evil.data.error.includes('域名'), '应提示域名不被允许，实际: ' + evil.data.error)

// 4.4 非 https 被拒绝
const insecure = loadWith({ url: encodeURIComponent('http://jq.mockr.com.cn/mzf-sq/') })
assert.strictEqual(insecure.data.src, '', 'http 地址不得加载')
assert.ok(insecure.data.error.includes('https'), '应提示必须使用 https')

// 4.5 从问卷返回时给一次性提示（首次进入不提示）
const returned = loadWith({})
returned.entered = false
modalCalls = 0
pageConfig.onShow.call(returned) // 进入
assert.strictEqual(modalCalls, 0, '首次进入不应弹提示')
pageConfig.onShow.call(returned) // 从问卷返回
assert.strictEqual(modalCalls, 1, '从问卷返回应提示一次')
pageConfig.onShow.call(returned) // 再次显示
assert.strictEqual(modalCalls, 1, '提示只弹一次')

console.log('Archive questionnaire entry tests passed')
