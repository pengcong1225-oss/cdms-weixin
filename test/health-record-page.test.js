const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..')
const read = relativePath => fs.readFileSync(path.join(root, relativePath), 'utf8')

// app.json 注册 pages/health-record/index 且四件套齐全
const appConfig = JSON.parse(read('miniprogram/app.json'))
assert.ok(appConfig.pages.includes('pages/health-record/index'), 'app.json must register pages/health-record/index')
for (const ext of ['js', 'json', 'wxml', 'wxss']) {
  const file = 'miniprogram/pages/health-record/index.' + ext
  const content = read(file)
  assert.ok(content.length > 0, 'empty file: ' + file)
}

// 页面配置：标题 + 下拉刷新
const pageJson = JSON.parse(read('miniprogram/pages/health-record/index.json'))
assert.strictEqual(pageJson.navigationBarTitleText, '健康档案')
assert.strictEqual(pageJson.enablePullDownRefresh, true)

// 页面 js：走 health-record-api 封装 + 三个接口都在用，不出现 handoff/web-view
const pageJs = read('miniprogram/pages/health-record/index.js')
assert.ok(pageJs.includes("require('../../utils/health-record-api')"), 'page must require health-record-api')
assert.ok(pageJs.includes('getPatient360'))
assert.ok(pageJs.includes('getMyFollowUps'))
assert.ok(pageJs.includes('getFollowUpDetail'))
assert.ok(!pageJs.includes('createHandoff'), 'native page must not use handoff')
assert.ok(pageJs.includes('onPullDownRefresh'), 'page must support pull-down refresh')

// workspace-entry.js：PATIENT 只保留健康档案原生入口，删除 profile/followups/mymonitoring
const workspaceEntry = read('miniprogram/utils/workspace-entry.js')
assert.ok(workspaceEntry.includes("key: 'healthRecord'"))
assert.ok(!workspaceEntry.includes('mymonitoring'))
assert.ok(!workspaceEntry.includes("key: 'profile'"))
assert.ok(!workspaceEntry.includes("key: 'followups'"))

// home.js：健康档案先 /me 拿 patientId 再 navigateTo 原生页面；旧分支清理干净
const homeJs = read('miniprogram/pages/home/home.js')
assert.ok(homeJs.includes('healthRecord: "档"'), 'WORKSPACE_ICONS must map healthRecord')
assert.ok(homeJs.includes('_healthRecordPatientId'), 'patientId cached on page instance')
assert.ok(homeJs.includes('/pages/health-record/index?patientId='))
assert.ok(homeJs.includes('/api/v1/miniapp/auth/me'))
assert.ok(!homeJs.includes('mymonitoring'))
assert.ok(!homeJs.includes('/h5/patients/${patientId}/360'), 'profile 360 branch must be removed')
assert.ok(!homeJs.includes("entry.key === 'profile'"))

// app.json 不新增 tabBar
assert.strictEqual(appConfig.tabBar.list.length, 2)

console.log('health record page tests passed')
