// 患者登录页「建档」入口 —— 原生实现：复用 cdmsManager 既有 COPD-SQ 问卷契约，
// 提交走 /screening/h5/submit（服务端 matchOrCreate 建档），不引入 web-view。
const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.join(__dirname, '..', 'miniprogram')
const read = rel => fs.readFileSync(path.join(root, rel), 'utf8')

// ---- 1. 登录页入口 ----
const loginWxml = read('pages/auth/login.wxml')
const loginJs = read('pages/auth/login.js')
const appJson = JSON.parse(read('app.json'))

assert.ok(loginWxml.includes('bindtap="openArchive"'), '登录页缺少建档入口')
assert.ok(loginWxml.includes('填写建档问卷'), '入口文案需明确指向建档问卷')
const doctorBlock = loginWxml.split("mode === 'doctor'")[1].split('wx:else')[0] || ''
assert.ok(!doctorBlock.includes('openArchive'), '医生登录分支不得出现患者建档入口')
assert.ok(/openArchive\s*\(\)\s*\{/.test(loginJs), 'login.js 缺少 openArchive')
assert.ok(loginJs.includes("'/pages/archive/index'"), 'openArchive 必须跳转建档页')

assert.ok(appJson.pages.includes('pages/archive/index'), 'app.json 未注册建档页')
for (const ext of ['js', 'json', 'wxml', 'wxss']) {
  assert.ok(fs.existsSync(path.join(root, 'pages/archive/index.' + ext)), 'missing pages/archive/index.' + ext)
}

// ---- 2. 必须是原生表单，不是 web-view ----
const archiveWxml = read('pages/archive/index.wxml')
assert.ok(!archiveWxml.includes('<web-view'), '建档页不得再用 web-view 承载 H5')
assert.ok(archiveWxml.includes('提交问卷并建档'), '缺少提交按钮')
assert.ok(archiveWxml.includes('身份证号'), '缺少身份证字段')
assert.ok(archiveWxml.includes('wx:for="{{questions}}"'), '题目需按后端返回动态渲染')
assert.ok(archiveWxml.includes('{{result.totalScore}}'), '缺少提交结果展示')
// runtime 不再需要 H5 地址
assert.ok(!read('config/runtime.js').includes('archiveQuestionnaireUrl'), '原生实现不应再配置 H5 问卷地址')

// ---- 3. 提交契约：匿名 h5 端点 + 一次性 token ----
const api = read('utils/screening-api.js')
assert.ok(api.includes("'/screening/h5/organizations'"), '缺少机构列表调用')
assert.ok(api.includes("'/screening/h5/questions'"), '缺少题目调用')
assert.ok(api.includes("'/screening/h5/token?orgId='"), '缺少 token 签发调用')
assert.ok(api.includes("'/screening/h5/submit'"), '缺少提交调用')
assert.ok(!api.includes('Authorization'), '匿名问卷不得携带登录 token')

// ---- 4. 身份证解析（与 H5 算法一致） ----
const { parseIdentityCard, normalizeIdCard } = require('../miniprogram/utils/identity')
assert.strictEqual(normalizeIdCard(' 42012419640614751x '), '42012419640614751X')
const male = parseIdentityCard('420124196406147515')
assert.ok(male, '合法 18 位身份证应能解析')
assert.strictEqual(male.birthday, '1964-06-14')
assert.strictEqual(male.gender, 1, '第 17 位为奇数应判男')
const female = parseIdentityCard('420124196406147524')
if (female) assert.strictEqual(female.gender, 2)
assert.strictEqual(parseIdentityCard('420124196406147516'), null, '校验位错误必须拒绝')
assert.strictEqual(parseIdentityCard('12345'), null, '位数不足必须拒绝')

// ---- 5. 页面逻辑：加载 → 选机构 → 校验 → 提交 ----
const requests = []
let pageConfig = null
global.getApp = () => ({ globalData: { managerBaseUrl: 'https://mgr.example.com/cdmsmanagerapi/api/v1' } })
global.wx = {
  request (options) {
    requests.push(options)
    const url = options.url
    if (url.includes('/organizations')) {
      options.success({ statusCode: 200, data: { code: 200, data: [{ id: '1930474026568847360', name: '沌阳街社区卫生服务中心' }] } })
      return
    }
    if (url.includes('/questions')) {
      options.success({ statusCode: 200, data: { code: 200, data: [
        { code: 'q_age', title: '年龄', note: '', options: [{ code: '60_69', label: '60~69岁', score: 8 }] },
        { code: 'q_bmi', title: '体重指数（BMI）', note: '由身高体重自动计算', options: [] }
      ] } })
      return
    }
    if (url.includes('/token?')) {
      options.success({ statusCode: 200, data: { code: 200, data: { token: 'tok-1', orgId: '1930474026568847360', orgName: '沌阳街社区卫生服务中心' } } })
      return
    }
    if (url.includes('/preview')) {
      if (global.__previewBusinessError) {
        options.success({ statusCode: 200, data: { code: 400, message: '问卷答案不完整或选项不合法', data: null } })
        return
      }
      options.success({ statusCode: 200, data: { code: 200, data: { totalScore: 21, isHighRisk: 1 } } })
      return
    }
    if (url.includes('/submit')) {
      if (global.__submitBusinessError) {
        // cdmsManager 业务错误是 HTTP 200 + body.code（锁真实口径）
        options.success({ statusCode: 200, data: { code: 400, message: '该身份证号已建档，请直接登录', data: null } })
        return
      }
      options.success({ statusCode: 200, data: { code: 200, data: { totalScore: 21, isHighRisk: 1 } } })
      return
    }
    options.success({ statusCode: 200, data: { code: 200, data: null } })
  },
  navigateBack () {},
  reLaunch () {},
  // 确认弹窗：默认确认；global.__modalConfirm=false 模拟「再改改」
  showModal (options) {
    global.__modalCalls = (global.__modalCalls || 0) + 1
    global.__lastModal = options
    const confirm = global.__modalConfirm !== false
    if (options.success) options.success({ confirm, cancel: !confirm })
  }
}
global.Page = config => { pageConfig = config }
require('../miniprogram/pages/archive/index.js')

function makePage () {
  const page = Object.assign({}, pageConfig)
  page.data = JSON.parse(JSON.stringify(pageConfig.data))
  page.setData = function (patch) {
    Object.keys(patch).forEach(key => {
      if (key.includes('.')) {
        const [head, tail] = key.split('.')
        this.data[head][tail] = patch[key]
      } else {
        this.data[key] = patch[key]
      }
    })
  }
  return page
}

async function run () {
  const page = makePage()
  page.onLoad()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))

  assert.strictEqual(page.data.loading, false, '加载应完成')
  assert.strictEqual(page.data.questions.length, 2, '题目应来自后端')
  assert.strictEqual(page.data.organizations.length, 1)
  // 机构 id 是 19 位雪花号：后端必须给字符串，否则 JSON 解析丢精度会让签发 token 失败
  assert.strictEqual(page.data.organizations[0].id, '1930474026568847360')
  const tokenCall = requests.filter(r => r.url.includes('/token?')).pop()
  assert.ok(tokenCall.url.includes('orgId=1930474026568847360'),
    '签发 token 必须带精确机构 id: ' + tokenCall.url)
  // 单机构自动选中并签发 token
  assert.strictEqual(page.screeningToken, 'tok-1', '机构确定后应签发一次性 token')

  // 未填必填项：本地拦截，不发提交请求
  const before = requests.length
  await page.submit()
  assert.strictEqual(requests.length, before, '校验未通过不得发提交请求')
  assert.ok(page.data.errors.name, '缺姓名应提示')
  assert.ok(page.data.errors.idCard, '缺身份证应提示')
  assert.ok(page.data.errors['question:q_age'], '未答题目应提示')
  assert.ok(!page.data.errors['question:q_bmi'], 'BMI 无选项不应要求作答')

  // 填齐后提交：payload 与 H5 契约一致
  page.setData({
    form: {
      name: '张三',
      gender: 1,
      birthday: '1964-06-14',
      heightCm: '170',
      weightKg: '65',
      idCard: '420124196406147515',
      phone: '13900000000',
      address: ''
    },
    answers: { q_age: '60_69' }
  })
  global.__modalCalls = 0
  await page.submit()
  // 提交前必须先预览并弹窗确认，确认后才入库
  const previewCall = requests.filter(r => r.url.includes('/preview')).pop()
  assert.ok(previewCall, '提交前必须先调用结果预览接口')
  assert.strictEqual(previewCall.method, 'POST')
  assert.strictEqual(previewCall.data.screeningToken, 'tok-1', '预览也必须带一次性 token')
  assert.strictEqual(global.__modalCalls, 1, '预览后必须弹一次确认弹窗')
  assert.ok(global.__lastModal.content.includes('21'), '弹窗需展示实时计分结果: ' + global.__lastModal.content)
  assert.ok(global.__lastModal.content.includes('高危'), '弹窗需给出高危提示')
  const submitCall = requests.filter(r => r.url.includes('/submit')).pop()
  assert.ok(submitCall, '应发出提交请求')
  assert.ok(submitCall.url.endsWith('/screening/h5/submit'), '提交地址应为 h5 匿名端点: ' + submitCall.url)
  assert.strictEqual(submitCall.method, 'POST')
  assert.ok(!submitCall.header || !submitCall.header.Authorization, '匿名提交不得带 Authorization')
  const body = submitCall.data
  assert.strictEqual(body.screeningToken, 'tok-1', '必须带服务端签发的一次性 token，不得裸传 orgId')
  assert.strictEqual(body.name, '张三')
  assert.strictEqual(body.gender, 1)
  assert.strictEqual(body.birthday, '1964-06-14')
  assert.strictEqual(body.idCard, '420124196406147515')
  assert.strictEqual(body.phone, '13900000000')
  assert.strictEqual(body.heightCm, 170)
  assert.strictEqual(body.weightKg, 65)
  assert.deepStrictEqual(body.answers, { q_age: '60_69' })
  assert.ok(!('orgId' in body), 'submit 不得携带 orgId')

  // 结果展示
  assert.strictEqual(page.data.result.totalScore, 21)
  assert.strictEqual(page.data.result.isHighRisk, 1)

  // 弹窗点「再改改」：不得入库
  const cancelPage = makePage()
  cancelPage.onLoad()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  cancelPage.setData({
    form: {
      name: '李四', gender: 1, birthday: '1964-06-14', heightCm: '170', weightKg: '65',
      idCard: '420124196406147515', phone: '13900000000', address: ''
    },
    answers: { q_age: '60_69' }
  })
  const beforeCancelSubmit = requests.filter(r => r.url.includes('/submit')).length
  global.__modalConfirm = false
  await cancelPage.submit()
  global.__modalConfirm = true
  assert.strictEqual(requests.filter(r => r.url.includes('/submit')).length, beforeCancelSubmit,
    '取消确认后不得提交入库')
  assert.strictEqual(cancelPage.data.result, null, '取消后不得进入结果页')
  assert.strictEqual(cancelPage.data.submitting, false, '取消后按钮要恢复可点')

  // 预览业务错误：直接提示，不入库、不进结果页
  global.__previewBusinessError = true
  const previewFail = makePage()
  previewFail.onLoad()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  previewFail.setData({
    form: {
      name: '王五', gender: 1, birthday: '1964-06-14', heightCm: '170', weightKg: '65',
      idCard: '420124196406147515', phone: '13900000000', address: ''
    },
    answers: { q_age: '60_69' }
  })
  const beforePreviewFail = requests.filter(r => r.url.includes('/submit')).length
  await previewFail.submit()
  global.__previewBusinessError = false
  assert.strictEqual(requests.filter(r => r.url.includes('/submit')).length, beforePreviewFail,
    '预览失败不得继续提交')
  assert.strictEqual(previewFail.data.result, null)
  assert.ok(String(previewFail.data.errorSummary).includes('问卷答案'), '应透出预览错误')

  // 业务错误（HTTP 200 + body.code）：必须按失败处理，不能进结果页
  global.__submitBusinessError = true
  const failing = makePage()
  failing.onLoad()
  await new Promise(resolve => setImmediate(resolve))
  await new Promise(resolve => setImmediate(resolve))
  failing.setData({
    form: {
      name: '张三', gender: 1, birthday: '1964-06-14', heightCm: '170', weightKg: '65',
      idCard: '420124196406147515', phone: '13900000000', address: ''
    },
    answers: { q_age: '60_69' }
  })
  await failing.submit()
  assert.strictEqual(failing.data.result, null, '业务失败不得展示结果页')
  assert.ok(String(failing.data.errorSummary).includes('已建档'), '应透出后端业务错误文案: ' + failing.data.errorSummary)
  assert.strictEqual(failing.data.submitting, false)

  console.log('Archive questionnaire (native) tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})