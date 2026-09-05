const assert = require('assert')
const fs = require('fs')
const path = require('path')

const read = rel => fs.readFileSync(path.join(__dirname, '..', 'miniprogram', rel), 'utf8')

const deviceJs = read('pages/device/device.js')
const deviceWxml = read('pages/device/device.wxml')
const appJson = JSON.parse(read('app.json'))

// ---- 医生端设备目录 ----

// 目录只包含医生端可连接/可操作设备，不含患者家用设备管理入口
assert.ok(deviceJs.includes('doctorEntries'))
assert.ok(deviceJs.includes('key: "scale"'))
assert.ok(deviceJs.includes('key: "mfa1"'))
assert.ok(deviceJs.includes('key: "sunvou"'))
assert.ok(!deviceJs.includes('解绑患者家用设备'))

// 体脂秤进入模式选择页（扫码轮测为主入口）
assert.ok(deviceJs.includes('/pages/device-scale/mode/index'))

// 患者操作在医生身份下被拦截
assert.ok(deviceJs.includes('isPatientDeviceScope'))
assert.ok(deviceJs.includes('syncRoleState'))

// ---- 页面结构 ----

// 标题按角色区分
assert.ok(deviceWxml.includes("activeRole === 'DOCTOR' ? '测量设备' : '我的设备'"))
assert.ok(deviceWxml.includes("activeRole === 'DOCTOR'"))
assert.ok(deviceWxml.includes('onDoctorEntrySelect'))

// 医生视图不允许出现患者设备绑定/解绑入口
const doctorBlock = deviceWxml.split("activeRole === 'DOCTOR'")[1] || ''
assert.ok(!doctorBlock.includes('unbind'))

// ---- 路由注册 ----

for (const route of [
  'pages/device-scale/mode/index',
  'pages/device-scale/index',
  'pages/device-scale/station/index',
  'pages/scale-checkin/index',
  'pages/device-mfa1/index',
  'pages/device-sunvou/index'
]) {
  assert.ok(appJson.pages.includes(route), `missing route: ${route}`)
}

// 目录项必须导航到真实工作站页面，不允许占位提示
assert.ok(deviceJs.includes('/pages/device-mfa1/index'))
assert.ok(deviceJs.includes('/pages/device-sunvou/index'))
assert.ok(!deviceJs.includes('即将开放'))


// ---- 组件声明（防止引用未注册组件） ----

const usingComponents = rel => JSON.parse(read(rel)).usingComponents || {}
assert.ok(usingComponents('pages/device-scale/mode/index.json')['app-header'])
assert.ok(usingComponents('pages/device-scale/mode/index.json')['state-panel'])
assert.ok(usingComponents('pages/device-scale/station/index.json')['form-section'])
assert.ok(usingComponents('pages/device-scale/station/index.json')['status-tag'])
assert.ok(usingComponents('pages/scale-checkin/index.json')['app-header'])
assert.ok(usingComponents('pages/device-mfa1/index.json')['form-section'])
assert.ok(usingComponents('pages/device-mfa1/index.json')['status-tag'])
assert.ok(usingComponents('pages/device-sunvou/index.json')['form-section'])
assert.ok(usingComponents('pages/device-sunvou/index.json')['status-tag'])

// ---- 患者扫码签到 ----

const checkinJs = read('pages/scale-checkin/index.js')
assert.ok(checkinJs.includes("ensureSession({ role: 'PATIENT' })"))
// 场次签到只提交场次令牌；通用签到从 /me 解析 patientId（患者身份由服务端授权，禁止从二维码载荷读取）
assert.ok(checkinJs.includes('createCheckin(payload.stationId, payload.checkinToken)'))
assert.ok(!checkinJs.includes('payload.patientId'), '不得从二维码载荷读取 patientId')
assert.ok(checkinJs.includes('/api/v1/miniapp/auth/me'), '通用签到应从 /me 获取 patientId')
assert.ok(checkinJs.includes('/api/v1/checkins?patientId='), '通用签到应调用 checkins?patientId= 端点')

// 工作站二维码走 canvas 渲染
const stationWxml = read('pages/device-scale/station/index.wxml')
assert.ok(stationWxml.includes('canvas-id="stationQr"'))

// ---- 医生端患者签到展码（通用签到码） ----

// 设备目录首位为患者签到入口
assert.ok(deviceJs.includes('key: "checkin"'))
assert.ok(deviceJs.includes('生成签到二维码，患者扫码登记到场'))
assert.ok(deviceJs.includes('protocol: "CHECKIN"') || deviceJs.includes("protocol: 'CHECKIN'"))
// 目录项导航到真实展码页面
assert.ok(deviceJs.includes('/pages/doctor-checkin/index'))
assert.ok(appJson.pages.includes('pages/doctor-checkin/index'))
// 页面四件套齐全
for (const ext of ['js', 'json', 'wxml', 'wxss']) {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'miniprogram', 'pages/doctor-checkin/index.' + ext)), 'missing file: pages/doctor-checkin/index.' + ext)
}
const doctorCheckinJs = read('pages/doctor-checkin/index.js')
const doctorCheckinWxml = read('pages/doctor-checkin/index.wxml')
// 只允许医生身份进入
assert.ok(doctorCheckinJs.includes("ensureSession({ role: 'DOCTOR' })"))
// 从 /me 取 orgId 生成通用签到码，未取得机构信息时给出明确提示
assert.ok(doctorCheckinJs.includes('/api/v1/miniapp/auth/me'))
assert.ok(doctorCheckinJs.includes('createGenericCheckinPayload'))
assert.ok(doctorCheckinJs.includes('未取得机构信息'))
// 今日队列按状态文本展示，失败静默为空
assert.ok(doctorCheckinJs.includes('/api/v1/checkins/today'))
assert.ok(doctorCheckinJs.includes('待处理') && doctorCheckinJs.includes('进行中') && doctorCheckinJs.includes('已完成'))
assert.ok(doctorCheckinWxml.includes('暂无签到记录'))
assert.ok(doctorCheckinWxml.includes('请患者扫码签到'))
// 展码走 canvas 渲染
assert.ok(doctorCheckinWxml.includes('canvas-id="checkinQr"'))
// 提供刷新与复制能力
assert.ok(doctorCheckinWxml.includes('bindtap="refresh"'))
assert.ok(doctorCheckinWxml.includes('bindtap="copyPayload"'))
assert.ok(doctorCheckinJs.includes('wx.setClipboardData'))

// ---- 依赖模块存在 ----

for (const rel of [
  'utils/auth-guard.js',
  'utils/station-api.js',
  'utils/scale-qr.js',
  'utils/qrcode-generator.js',
  'utils/session-store.js',
  'services/scaleBle.js',
  'components/app-header/app-header.js',
  'components/state-panel/state-panel.js',
  'components/form-section/form-section.js',
  'components/status-tag/status-tag.js'
]) {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'miniprogram', rel)), `missing file: ${rel}`)
}

// MFA-1 / Sunvou 页面文件本体必须存在（app.json 已注册路由）
for (const rel of [
  'pages/device-mfa1/index.js',
  'pages/device-mfa1/index.wxml',
  'pages/device-mfa1/index.wxss',
  'pages/device-sunvou/index.js',
  'pages/device-sunvou/index.wxml',
  'pages/device-sunvou/index.wxss'
]) {
  assert.ok(fs.existsSync(path.join(__dirname, '..', 'miniprogram', rel)), `missing file: ${rel}`)
}

// services/scaleBle 必须只是转发既有 ScaleBle 实现
const shim = read('services/scaleBle.js')
assert.ok(shim.includes("require('./scale/scaleBle')"))

// ---- MFA-1 场次流工作站契约 ----

// services/mfa1Ble 必须只是转发独立实现（不与 scale/bleManager 共用状态）
const mfa1Shim = read('services/mfa1Ble.js')
assert.ok(mfa1Shim.includes("require('./mfa1/mfa1Ble')"))
assert.ok(fs.existsSync(path.join(__dirname, '..', 'miniprogram', 'services/mfa1/mfa1Ble.js')), 'missing file: services/mfa1/mfa1Ble.js')

// 页面重写为场次流：以 deviceType=MFA1 创建场次，复用签到二维码与叫号/确认端点
const mfa1Js = read('pages/device-mfa1/index.js')
assert.ok(mfa1Js.includes("deviceType: 'MFA1'"), 'device-mfa1 必须以 MFA1 类型创建场次')
assert.ok(mfa1Js.includes("require('../../utils/station-api')"))
assert.ok(mfa1Js.includes('createCheckinPayload'))
assert.ok(mfa1Js.includes('callNext'))
assert.ok(mfa1Js.includes('confirmMeasurement'))
assert.ok(mfa1Js.includes('saveMeasurementDraft'))
assert.ok(mfa1Js.includes('closeStation'))
// 旧错误模式不得残留：医生手填业务会话/机构/患者
assert.ok(!mfa1Js.includes('acquisition-api'), 'device-mfa1 不得再走手动采集会话')
assert.ok(!mfa1Js.includes('patientRef'))

// wxml：无手动患者输入框，二维码走 canvas 渲染
const mfa1Wxml = read('pages/device-mfa1/index.wxml')
assert.ok(!mfa1Wxml.includes('patientRef'), '不得保留患者编号手动输入框')
assert.ok(!mfa1Wxml.includes('businessSessionId'))
assert.ok(mfa1Wxml.includes('canvas-id="mfa1Qr"'))

// 组件声明齐全
for (const name of ['app-header', 'state-panel', 'form-section', 'status-tag']) {
  assert.ok(usingComponents('pages/device-mfa1/index.json')[name], `missing component: ${name}`)
}

// 设备目录副标题与扫码轮测定位一致
assert.ok(deviceJs.includes('扫码签到后现场采血测血糖'))
assert.ok(deviceJs.includes('protocol: "MFA1_BLE"') || deviceJs.includes("protocol: 'MFA1_BLE'"))

// ---- Sunvou 呼气报告：厂商推送、医生只读查看 ----

const sunvouJs = read('pages/device-sunvou/index.js')
const sunvouWxml = read('pages/device-sunvou/index.wxml')
const sunvouJson = read('pages/device-sunvou/index.json')

// 语义纠正：绝不在小程序发起设备测试，也不出现「工作站」暗示
assert.ok(!sunvouWxml.includes('工作站'), 'sunvou wxml 不得再出现工作站')
assert.ok(!sunvouJs.includes('工作站'), 'sunvou js 不得再出现工作站')
assert.ok(!sunvouJson.includes('工作站'), 'sunvou json 标题不得再出现工作站')
// 文案体现厂商推送 + 仅查看 + IoT 数据来源
assert.ok(sunvouWxml.includes('厂商推送') || sunvouWxml.includes('由设备厂商推送同步'), '应说明报告由厂商推送同步')
assert.ok(sunvouWxml.includes('仅供医生查看') || sunvouWxml.includes('仅查看'), '应明确只读查看定位')
assert.ok(sunvouWxml.includes('尚沃呼气分析仪经 IoT 平台同步'), '顶部应有数据来源说明')
assert.ok(sunvouWxml.includes('不发起设备测试'), '应明确医生端不发起设备测试')
// 空态文案
assert.ok(sunvouWxml.includes('该患者暂无已同步的呼气报告'), '空态提示已同步报告缺失场景')
assert.ok(sunvouWxml.includes('报告由现场检查后自动上传'), '空态提示自动上传机制')
// 患者选择：搜索选人（listDoctorPatients keyword），不再手填 patientId input
assert.ok(sunvouJs.includes('listDoctorPatients'), '应通过 listDoctorPatients 搜索患者')
assert.ok(sunvouJs.includes('keyword'), '应支持 keyword 搜索参数')
assert.ok(sunvouJs.includes('searchPatients'), '应有搜索入口处理函数')
assert.ok(sunvouWxml.includes('bindtap="searchPatients"'), 'wxml 应有搜索按钮')
assert.ok(sunvouWxml.includes('picker'), 'wxml 应使用 picker 选患者')
assert.ok(!sunvouWxml.includes('bindinput="updatePatientId"'), '不得保留 patientId 手填输入框')
// canonical 肺功能指标展示（有 metrics 才渲染，不编造数值）
assert.ok(sunvouJs.includes('FVC_L') && sunvouJs.includes('FEV1_L') && sunvouJs.includes('FEV1_FVC_PCT'), '应识别 FVC/FEV1/FEV1% canonical 指标')
assert.ok(sunvouWxml.includes('displayMetrics'), '列表与详情按 metrics 数组渲染')
// 禁止 web-view/H5 与误改依赖
assert.ok(!sunvouWxml.includes('web-view'), '不得引入 web-view')
assert.ok(!sunvouJs.includes('acquisition-api'), '不得引用采集会话 API')

console.log('device center tests passed')