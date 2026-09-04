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
// 签到只提交场次令牌，不提交患者 ID
assert.ok(checkinJs.includes('createCheckin(payload.stationId, payload.checkinToken)'))
assert.ok(!checkinJs.includes('patientId'))

// 工作站二维码走 canvas 渲染
const stationWxml = read('pages/device-scale/station/index.wxml')
assert.ok(stationWxml.includes('canvas-id="stationQr"'))

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

// 医生业务工作台在 H5 web-view（无 tabBar），容器页必须提供设备中心原生入口
const h5Js = read('pages/h5/index.js')
const h5Wxml = read('pages/h5/index.wxml')
assert.ok(h5Js.includes("goDeviceCenter"))
assert.ok(h5Js.includes("activeRole === 'DOCTOR'"))
assert.ok(h5Wxml.includes('goDeviceCenter'))
assert.ok(h5Wxml.includes('isDoctor'))

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

console.log('device center tests passed')