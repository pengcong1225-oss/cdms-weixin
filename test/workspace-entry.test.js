const assert = require('assert')
const { getWorkspaceEntries } = require('../miniprogram/utils/workspace-entry')

assert.deepStrictEqual(getWorkspaceEntries('PATIENT'), [
  { key: 'followups', title: '随访记录', subtitle: '查看本人随访与健康报告', type: 'H5', targetPath: '/h5/followups' },
  { key: 'device', title: '设备中心', subtitle: '在小程序中连接与同步设备', type: 'NATIVE', url: '/pages/device/device' }
])

assert.deepStrictEqual(getWorkspaceEntries('DOCTOR'), [
  { key: 'patients', title: '患者工作台', subtitle: '进入医生 H5 患者列表', type: 'H5', targetPath: '/h5/patients' }
])

assert.deepStrictEqual(getWorkspaceEntries(''), [])

const appConfig = require('../miniprogram/app.json')
assert.ok(!appConfig.pages.includes('pages/device-scale/index'), '体脂秤页面暂不注册入口')
assert.ok(appConfig.pages.includes('pages/device/device'), '患者手环设备页必须保留')
console.log('workspace-entry tests passed')
