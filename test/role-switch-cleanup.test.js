// §6.3 / §16.1：角色切换与退出后，旧角色的 patientId、穿戴 token、handoff code
// 不得残留；401（旧版本 token 失效）清空完整会话对象。
// 纯 node assert，mock Page/wx/storage/app.js。
const assert = require('assert')
const path = require('path')

const appPath = path.resolve(__dirname, '../miniprogram/app.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')
const runtimeConfigPath = path.resolve(__dirname, '../miniprogram/config/runtime.js')
const sessionStorePath = path.resolve(__dirname, '../miniprogram/utils/session-store.js')

let store
global.wx = {
  getStorageSync: key => (store.has(key) ? store.get(key) : ''),
  setStorageSync: (key, value) => store.set(key, value),
  removeStorageSync: key => store.delete(key)
}
let appConfig
global.App = config => { appConfig = config }
global.getApp = () => ({ globalData: {} })

function loadApp () {
  store = new Map()
  delete require.cache[appPath]
  delete require.cache[sessionStorePath]
  delete require.cache[bleManagerPath]
  // bleManager 只被当作依赖注入进 globalData，桩化以免牵入蓝牙相关模块。
  require.cache[bleManagerPath] = {
    id: bleManagerPath, filename: bleManagerPath, loaded: true,
    exports: { init: async () => {}, refreshBoundDeviceOwnership: async () => {} }
  }
  require.cache[runtimeConfigPath] = {
    id: runtimeConfigPath, filename: runtimeConfigPath, loaded: true,
    exports: { cdmsBaseUrl: 'https://cdms', managerBaseUrl: 'https://manager', iotBaseUrl: 'https://iot' }
  }
  require(appPath)
  appConfig.globalData = {
    accessToken: '', refreshToken: '', identityId: '', activeRole: '', roles: [],
    orgId: '', patientRef: '', patientId: '', handoffCode: '', wearableToken: '',
    wearableSessionId: '', wearableDeviceRef: '', iotBaseUrl: 'https://iot',
    cdmsBaseUrl: 'https://cdms', mode: 'PATIENT'
  }
  return require(sessionStorePath)
}

async function run () {
  // —— 1. PATIENT 登录 → 切 DOCTOR：旧患者 patientId / 穿戴 token / handoff code 全清 ——
  loadApp()
  const s = require(sessionStorePath)
  appConfig.saveAuth({
    identityId: 'identity-1', activeRole: 'PATIENT', token: 'pat-access', refreshToken: 'pat-refresh',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }, { roleType: 'DOCTOR' }]
  })
  // 模拟已建立的穿戴 + handoff 临时会话（同一患者，允许保留的场景）
  const withScoped = s.writeSession({
    wearableSession: { wearableToken: 'wear-token', wearableSessionId: 'wear-sess', deviceRef: 'dev-1', patientId: 'patient-1' },
    handoffSession: { code: 'handoff-code', url: 'https://h5/patients' }
  }, s.readSession())
  assert.strictEqual(withScoped.wearableSession.wearableToken, 'wear-token')

  appConfig.saveAuth({
    identityId: 'identity-1', activeRole: 'DOCTOR', token: 'doc-access', refreshToken: 'doc-refresh',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }, { roleType: 'DOCTOR', principalId: 'doc-1' }]
  })
  const afterSwitch = s.readSession()
  assert.strictEqual(afterSwitch.activeRole, 'DOCTOR')
  assert.strictEqual(afterSwitch.patientId, '', 'role switch must not keep the old patient id')
  assert.strictEqual(afterSwitch.patientRef, '', 'role switch must not keep the old patient ref')
  assert.strictEqual(afterSwitch.wearableSession.wearableToken, '', 'role switch must drop the wearable token')
  assert.strictEqual(afterSwitch.wearableSession.wearableSessionId, '')
  assert.strictEqual(afterSwitch.handoffSession.code, '', 'role switch must drop the handoff code')
  // 内存视图同步清空
  assert.strictEqual(appConfig.globalData.wearableToken, '')
  assert.strictEqual(appConfig.globalData.handoffCode, '')
  assert.strictEqual(appConfig.globalData.patientRef, '')

  // —— 2. DOCTOR 切回 PATIENT（另一身份）：同样不保留旧医生 handoff ——
  loadApp()
  const s2 = require(sessionStorePath)
  appConfig.saveAuth({ identityId: 'identity-1', activeRole: 'DOCTOR', token: 'd-a', refreshToken: 'd-r',
    roles: [{ roleType: 'DOCTOR', principalId: 'doc-1' }] })
  s2.writeSession({ handoffSession: { code: 'doc-handoff' } }, s2.readSession())
  appConfig.saveAuth({ identityId: 'identity-1', activeRole: 'PATIENT', token: 'p-a', refreshToken: 'p-r',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }] })
  const backToPatient = s2.readSession()
  assert.strictEqual(backToPatient.handoffSession.code, '', 'switching back to PATIENT drops the doctor handoff code')
  assert.strictEqual(backToPatient.patientId, 'patient-1', 'adopts the new patient id')

  // —— 3. 退出：整体清空完整会话对象（含旧分散键），非只删单个 token ——
  loadApp()
  const s3 = require(sessionStorePath)
  appConfig.saveAuth({ identityId: 'identity-1', activeRole: 'PATIENT', token: 'a', refreshToken: 'r',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-1' }] })
  store.set('cdms.miniapp.auth', { leftover: true })       // 遗留脏键
  store.set('cdms.miniapp.wearable', { leftover: true })
  appConfig.globalData.identityId = 'identity-1'            // Task B 锚点需保留
  appConfig.clearAuth()
  assert.strictEqual(store.has(s3.SESSION_KEY), false, 'logout removes the atomic session object')
  assert.strictEqual(store.has('cdms.miniapp.auth'), false, 'logout also removes legacy auth key')
  assert.strictEqual(store.has('cdms.miniapp.wearable'), false, 'logout also removes legacy wearable key')
  assert.strictEqual(appConfig.globalData.accessToken, '')
  assert.strictEqual(appConfig.globalData.refreshToken, '')
  assert.strictEqual(appConfig.globalData.wearableToken, '')
  assert.strictEqual(appConfig.globalData.handoffCode, '')
  assert.strictEqual(appConfig.globalData.patientId, '')
  assert.strictEqual(appConfig.globalData.patientRef, '')
  assert.strictEqual(appConfig.globalData.identityId, 'identity-1',
    'identityId marker is intentionally retained for account-switch detection (Task B)')

  console.log('role-switch cleanup tests passed')
}

run().catch(error => { console.error(error); process.exit(1) })