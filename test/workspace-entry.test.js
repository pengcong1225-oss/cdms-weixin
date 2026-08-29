const assert = require('assert')
const { getWorkspaceEntries } = require('../miniprogram/utils/workspace-entry')

assert.deepStrictEqual(getWorkspaceEntries('PATIENT'), [
  { key: 'patient-workspace', title: '患者工作台', subtitle: '随访、报告和健康服务入口', type: 'NATIVE', url: '/pages/patient/workspace/index' },
  { key: 'device', title: '指环设备', subtitle: '在小程序中连接与同步设备', type: 'NATIVE', url: '/pages/device/device' },
  { key: 'public-questionnaire', title: '建档问卷', subtitle: '复制公开问卷地址', type: 'COPY', copyText: 'https://jq.mockr.com.cn/mzf-sq/#/screen' }
])

assert.deepStrictEqual(getWorkspaceEntries('DOCTOR'), [
  { key: 'doctor-workspace', title: '医生工作台', subtitle: '患者管理、随访和设备工作站入口', type: 'NATIVE', url: '/pages/doctor/workspace/index' }
])

assert.deepStrictEqual(getWorkspaceEntries(''), [])

const appConfig = require('../miniprogram/app.json')
assert.ok(!appConfig.pages.includes('pages/device-scale/index'), '体脂秤页面暂不注册入口')
assert.ok(appConfig.pages.includes('pages/device-scale/station/index'), '体脂秤工作站页必须注册')
assert.ok(appConfig.pages.includes('pages/device/device'), '患者手环设备页必须保留')
assert.ok(!appConfig.pages.includes('pages/h5/index'), '业务 H5 WebView 页面不得注册')
console.log('workspace-entry tests passed')
