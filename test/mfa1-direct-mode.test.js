/**
 * MFA-1 单人直接测量模式测试（V58 直测对齐体脂秤双模式）：
 * mode 页双入口契约、direct 页患者搜索/无手填/直测端点提交契约、mfa1-direct-api 路由与载荷、
 * 页面级端到端（建会话 → 设备结果 → 二次确认 → 确认落库）。风格对齐 mfa1-v2-contract.test.js。
 */
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const read = rel => fs.readFileSync(path.join(__dirname, '..', 'miniprogram', rel), 'utf8')
const appJson = JSON.parse(read('app.json'))

const directApiPath = path.resolve(__dirname, '../miniprogram/utils/mfa1-direct-api.js')
const directPagePath = path.resolve(__dirname, '../miniprogram/pages/device-mfa1/direct/index.js')

global.getApp = () => ({ globalData: { accessToken: 't', refreshToken: 'r', activeRole: 'DOCTOR', cdmsBaseUrl: 'https://cdms.example.com' } })
global.wx = {
  showToast: () => undefined, showModal: () => undefined, navigateBack: () => undefined,
  reLaunch: () => undefined, setClipboardData: () => undefined
}

// ---- 路由注册与四件套 ----

assert.ok(appJson.pages.includes('pages/device-mfa1/mode/index'), 'mode 页必须注册路由')
assert.ok(appJson.pages.includes('pages/device-mfa1/direct/index'), 'direct 页必须注册路由')
for (const route of ['pages/device-mfa1/mode/index', 'pages/device-mfa1/direct/index']) {
  for (const ext of ['js', 'json', 'wxml', 'wxss']) {
    assert.ok(fs.existsSync(path.join(__dirname, '..', 'miniprogram', route + '.' + ext)), `missing file: ${route}.${ext}`)
  }
}

// ---- mode 页契约：双入口与体脂秤模式页同构 ----

const modeJs = read('pages/device-mfa1/mode/index.js')
assert.ok(modeJs.includes("require('../../../utils/auth-guard')"), 'mode 页走 ensureSession 医生门禁')
assert.ok(modeJs.includes("ensureSession({ role: 'DOCTOR' })"))
assert.ok(modeJs.includes("'/pages/device-mfa1/index'"), '扫码轮测（推荐主入口）指向轮测工作站')
assert.ok(modeJs.includes("'/pages/device-mfa1/direct/index'"), '单人直接测量（备用）指向直测页')
const modeWxml = read('pages/device-mfa1/mode/index.wxml')
assert.ok(modeWxml.includes('扫码轮测') && modeWxml.includes('单人直接测量'), '两种模式文案齐备')
assert.ok(modeWxml.includes('推荐'), '扫码轮测为推荐主入口')
assert.ok(modeWxml.includes('备用'), '单人直测为备用入口')
const modeJson = JSON.parse(read('pages/device-mfa1/mode/index.json'))
assert.ok(modeJson.usingComponents['app-header'] && modeJson.usingComponents['state-panel'], 'mode 页组件声明齐全')

// ---- direct 页静态契约 ----

const directJs = read('pages/device-mfa1/direct/index.js')
const directWxml = read('pages/device-mfa1/direct/index.wxml')
// 患者搜索：照抄体脂秤直测页的 listDoctorPatients keyword 搜索
assert.ok(directJs.includes('listDoctorPatients'), '直测页必须走 listDoctorPatients 搜索本院患者')
assert.ok(directJs.includes('keyword'), '患者搜索必须带 keyword')
assert.ok(directJs.includes('loadMorePatients'), '必须支持加载更多（loadMorePatients）')
assert.ok(directWxml.includes('bindtap="searchPatients"'), 'wxml 必须有搜索入口')
assert.ok(directWxml.includes('picker'), 'wxml 必须用 picker 选患者')
assert.ok(directWxml.includes('bindtap="loadMorePatients"'), 'wxml 必须有加载更多入口')
// 禁止手填患者身份
assert.ok(!directWxml.includes('bindinput="updatePatientId"'), '不得保留 patientId 手填输入框')
assert.ok(!directJs.includes('patientRef'), '不得出现手填 patientRef')
// 无 Number 化患者 id（铁律：ID 一律字符串处理）
assert.ok(!directJs.includes('Number(this.data.selectedPatient.id)'), '禁止 Number 化患者 id')
assert.ok(!directJs.includes('Number(item.id)'), '禁止 Number 化列表患者 id')
// 设备与直测端点
assert.ok(directJs.includes("require('../../../services/mfa1Ble')"), '直测页必须走 Mfa1Ble 通道')
assert.ok(directJs.includes('syncTime') && directJs.includes('getBattery'), '连接后必须 syncTime + getBattery')
assert.ok(directJs.includes("require('../../../utils/mfa1-direct-api')"), '直测页必须走直测 API 模块')
assert.ok(directJs.includes('createSession'), '必须创建直测会话')
assert.ok(directJs.includes('measurementSessionId'), '确认落库必须携带 measurementSessionId')
assert.ok(directWxml.includes('请患者采血'), '连接/开始测量后必须提示采血')
assert.ok(directJs.includes('showModal'), '落库前必须有二次确认弹窗')
// partial 提示沿用
assert.ok(directJs.includes('部分血脂结果'), 'partial 提示文案沿用轮测工作站')
assert.ok(directJs.includes('acceptsFrameForSession'), '迟到/残留结果帧必须被丢弃')

// ---- 页面模块装载与纯函数层 ----

let cfg = null
global.Page = c => { cfg = c }
delete require.cache[directPagePath]
require(directPagePath)
const page = Object.assign({}, cfg)
page.data = JSON.parse(JSON.stringify(cfg.data))
page.setData = function (patch, callback) {
  if (!patch) return
  Object.keys(patch).forEach(k => { if (k.indexOf('.') < 0 && k.indexOf('[') < 0) this.data[k] = patch[k] })
  if (typeof callback === 'function') callback()
}
const M = globalThis.__cdmsMfa1DirectTestables
assert.ok(M, '直测页测试钩子已导出')

assert.strictEqual(M.resolveGlucoseContextFromEcho(1), 'FASTING', '设备 D5=1 → FASTING')
assert.strictEqual(M.resolveGlucoseContextFromEcho(2), 'POSTPRANDIAL', '设备 D5=2 → POSTPRANDIAL')
assert.strictEqual(M.resolveGlucoseContextFromEcho(0), 'UNKNOWN', '无回显 → UNKNOWN（服务端合法语境）')

const directMetrics = M.buildDirectMetrics([
  { name: 'glucose', value: 5.5, unit: 'mmol/L', fastState: 1 },
  { name: 'uricAcid', value: 0.35, unit: 'mmol/L' },
  { name: 'tc', value: 5.2, unit: 'mmol/L', partial: true },
  { name: 'hdl', value: 1.3, unit: 'mmol/L', partial: true },
  { name: 'battery', value: 88, unit: '%' }
])
assert.strictEqual(directMetrics[0].context, 'FASTING', '直测血糖语境取设备回显')
assert.ok(directMetrics.filter(m => M.LIPID_METRIC_NAMES.includes(m.type)).every(m => m.partial === true), '未齐血脂标 partial=true')
assert.ok(directMetrics.every(m => m.type !== 'battery'), '电量不进临床指标数组')
assert.strictEqual(M.hasPartialLipid([{ name: 'tc' }, { name: 'hdl' }]), true, '缺 TG/LDL → 部分血脂')
assert.strictEqual(M.metricLabel('glucose'), '血糖')
assert.strictEqual(M.metricLabel('heartRate'), '心率')

// ---- mfa1-direct-api 契约：路由与载荷 ----

const mfa1DirectApi = require('../miniprogram/utils/mfa1-direct-api')
const api = require('../miniprogram/utils/api')
assert.strictEqual(mfa1DirectApi.MFA1_DIRECT_PATH, '/api/v2/miniapp/mfa1/direct')

const captured = []
const requestQueue = []
global.wx.request = options => {
  captured.push(options)
  const respond = requestQueue.length ? requestQueue.shift() : { statusCode: 200, data: { code: 200, data: {} } }
  options.success(respond)
}

async function flushPromises () { for (let i = 0; i < 8; i++) await Promise.resolve() }

const run = async () => {
  // createSession → POST /api/v2/miniapp/mfa1/direct/sessions，idempotencyKey 必带，patientId 字符串
  requestQueue.push({ statusCode: 200, data: { code: 200, data: { measurementSessionId: 'sess-direct-1', patientId: '9', deviceType: 'MFA1', status: 'ACTIVE' } } })
  const session = await mfa1DirectApi.createSession({ patientId: '9', deviceId: 'mfa1-1', idempotencyKey: 'direct-session-k1' })
  await flushPromises()
  assert.strictEqual(captured[0].url, 'https://cdms.example.com/api/v2/miniapp/mfa1/direct/sessions')
  assert.strictEqual(captured[0].method, 'POST')
  assert.strictEqual(captured[0].data.idempotencyKey, 'direct-session-k1')
  assert.strictEqual(captured[0].data.patientId, '9', 'patientId 以字符串提交')
  assert.strictEqual(session.measurementSessionId, 'sess-direct-1')

  // confirmDirect → POST /api/v2/miniapp/mfa1/direct/confirm，v2 指标契约 + 电量随载荷审计
  requestQueue.push({ statusCode: 200, data: { code: 200, data: { id: '901', measurementSessionId: 'sess-direct-1', sourceType: 'DIRECT', testType: 'GLUCOSE', resultStatus: 'COMPLETE', status: 'CONFIRMED' } } })
  const confirmView = await mfa1DirectApi.confirmDirect({
    measurementSessionId: 'sess-direct-1',
    patientId: '9',
    deviceId: 'mfa1-1',
    measuredAt: '2026-09-08T09:00:00',
    batteryLevel: 88,
    metrics: [{ name: 'glucose', value: 5.5, unit: 'mmol/L', context: 'FASTING' }],
    idempotencyKey: 'direct-confirm-k1'
  })
  const confirmCall = captured[1]
  assert.strictEqual(confirmCall.url, 'https://cdms.example.com/api/v2/miniapp/mfa1/direct/confirm')
  assert.strictEqual(confirmCall.data.measurementSessionId, 'sess-direct-1')
  assert.strictEqual(confirmCall.data.patientId, '9')
  assert.strictEqual(confirmCall.data.idempotencyKey, 'direct-confirm-k1')
  assert.deepStrictEqual(confirmCall.data.metrics.map(m => [m.type, m.value, m.unit]), [['glucose', 5.5, 'mmol/L'], ['battery', 88, '%']], '电量作为设备状态随载荷发送')
  assert.strictEqual(confirmCall.data.metrics[0].context, 'FASTING', '血糖 context 序列化（v2 契约）')
  assert.strictEqual(confirmView.id, '901', '落库 id 字符串化')
  assert.strictEqual(confirmView.sourceType, 'DIRECT')

  // ---- 页面级端到端：选患者 → 连接 → 建会话 → 设备结果 → 二次确认 → 直测落库 ----

  // 患者搜索 stub（走 api.listDoctorPatients，带 keyword）
  api.listDoctorPatients = async ({ keyword }) => ({
    data: { list: keyword ? [{ id: '9', name: '赵一' }, { id: '9', name: '赵一' }] : [{ id: '9', name: '赵一' }, { id: '12', name: '钱二' }], total: 2 }
  })
  api.getDoctorPatient = async () => ({ data: {} })

  // 建会话与确认 stub（捕获服务端交互）
  const sessionCalls = []
  const confirmCalls = []
  mfa1DirectApi.createSession = async payload => {
    sessionCalls.push(payload)
    return { measurementSessionId: 'sess-page-1', patientId: String(payload.patientId), deviceType: 'MFA1', status: 'ACTIVE' }
  }
  mfa1DirectApi.confirmDirect = async payload => {
    confirmCalls.push(payload)
    return { id: '902', measurementSessionId: payload.measurementSessionId, sourceType: 'DIRECT', testType: 'GLUCOSE', resultStatus: 'COMPLETE', status: 'CONFIRMED' }
  }

  page.loadPatients(true)
  await flushPromises()
  assert.strictEqual(page.data.patients.length, 2, '患者列表装载')
  page.setData({ keyword: '赵' })
  page.searchPatients()
  await flushPromises()
  assert.ok(page.data.patients.every(item => item.id === '9'), 'keyword 搜索生效')
  assert.strictEqual(page.data.patients.length, 1, '按 id 字符串去重')
  assert.strictEqual(page.data.patients[0].id, '9', '患者 id 保持字符串')

  page.setData({ connected: true, selectedPatient: page.data.patients[0], statusText: '已连接' })
  await page.startMeasure()
  await flushPromises()
  assert.strictEqual(sessionCalls.length, 1, '开始测量必须创建直测会话')
  assert.strictEqual(String(sessionCalls[0].patientId), '9')
  assert.ok(sessionCalls[0].idempotencyKey, '建会话必须携带幂等 key')
  assert.strictEqual(page.measurementSessionId, 'sess-page-1', '页面保存服务端会话 ID')
  assert.strictEqual(page.data.statusText, '请患者采血', '建会话后提示采血')
  assert.ok(page.measurementIdempotencyKey, '确认动作 key 已生成（重试复用）')

  // 会话建立前的迟到帧丢弃
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'uricAcid', value: 0.9, unit: 'mmol/L' }, receivedAt: Date.now() - 120000 })
  await flushPromises()
  assert.strictEqual(page.data.metrics.length, 0, '早于会话启动的结果帧被丢弃')

  // 设备推结果：GLU（空腹回显）→ 展示 metrics，canConfirm 打开
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'glucose', value: 5.5, unit: 'mmol/L', state: '空腹', fastState: 1 }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(page.data.metrics.length, 1)
  assert.strictEqual(page.data.metrics[0].label, '血糖')
  assert.strictEqual(page.data.metrics[0].value, 5.5)
  assert.strictEqual(page.data.metrics[0].unit, 'mmol/L')
  assert.strictEqual(page.data.canConfirm, true, '结果到达后可确认落库')

  // 二次确认弹窗 → 确认落库走直测端点
  let modal = null
  global.wx.showModal = options => { modal = options }
  page.confirmSave()
  assert.ok(modal, '落库前必须弹二次确认')
  assert.ok(/赵一/.test(modal.content), '弹窗摘要包含患者')
  assert.ok(/血糖/.test(modal.content), '弹窗摘要包含指标')
  modal.success({ confirm: true })
  await flushPromises()
  assert.strictEqual(confirmCalls.length, 1, '确认后提交直测落库')
  assert.strictEqual(confirmCalls[0].measurementSessionId, 'sess-page-1', '落库携带直测会话 ID')
  assert.strictEqual(String(confirmCalls[0].patientId), '9')
  assert.deepStrictEqual(confirmCalls[0].metrics.map(m => m.type), ['glucose'], '电量与临床指标分离提交')
  assert.ok(confirmCalls[0].idempotencyKey, '落库必须携带幂等 key')
  assert.strictEqual(page.data.metrics.length, 0, '落库成功后清测量态')
  assert.strictEqual(page.measurementSessionId, '', '落库成功后清会话（可继续下一位）')
  assert.strictEqual(page.measurementIdempotencyKey, '', '成功后确认 key 已消费')

  // 取消弹窗不提交
  page.setData({ metrics: [{ name: 'glucose', value: 6.6, unit: 'mmol/L', label: '血糖' }], canConfirm: true })
  page.measurementSessionId = 'sess-page-2'
  page.measurementIdempotencyKey = 'k2'
  page.confirmSave()
  modal.success({ confirm: false })
  await flushPromises()
  assert.strictEqual(confirmCalls.length, 1, '取消确认不提交')
  assert.strictEqual(page.measurementIdempotencyKey, 'k2', '取消后 key 保留（同一动作可重试）')

  // 部分血脂提示沿用
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'tc', value: 5.2, unit: 'mmol/L', partial: true }, metrics: [{ name: 'tc', value: 5.2, unit: 'mmol/L', partial: true }, { name: 'hdl', value: 1.3, unit: 'mmol/L', partial: true }], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(page.data.partialLipidText, M.PARTIAL_RESULT_TEXT, '部分血脂提示沿用')
  assert.ok(/部分血脂结果/.test(page.data.statusText))

  console.log('mfa1 direct mode tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
