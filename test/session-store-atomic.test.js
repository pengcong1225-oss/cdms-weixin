// §6.3 / §16.1：会话以单个原子对象存储；登录/切换/退出整体替换或整体清空；
// 旧分散键读取时迁移并删除。纯 node assert，mock wx storage（Map）。
const assert = require('assert')

const SESSION_KEY = 'cdms.miniapp.session.v1'
const LEGACY_AUTH_KEY = 'cdms.miniapp.auth'
const LEGACY_WEARABLE_KEY = 'cdms.miniapp.wearable'

let store
global.wx = {
  getStorageSync: key => (store.has(key) ? store.get(key) : ''),
  setStorageSync: (key, value) => store.set(key, value),
  removeStorageSync: key => store.delete(key)
}

function fresh () {
  store = new Map()
  delete require.cache[require.resolve('../miniprogram/utils/session-store')]
  return require('../miniprogram/utils/session-store')
}

// —— 1. 写入即落成一个完整原子对象，且不再残留旧分散键 ——
;(function writesSingleAtomicObject () {
  const s = fresh()
  const session = s.writeSession({
    token: undefined,
    accessToken: 'access-1',
    refreshToken: 'refresh-1',
    activeRole: 'PATIENT',
    orgId: 42,
    identityId: 'identity-1',
    roles: [{ roleType: 'PATIENT', patientId: 7 }]
  }, null)

  assert.ok(session, 'writeSession should return a normalized session')
  // §6.3 规定的字段齐全
  ;['principalId', 'activeRole', 'orgId', 'patientId', 'accessToken', 'refreshToken',
    'tokenVersion', 'handoffSession', 'wearableSession', 'issuedAt'].forEach(key => {
    assert.ok(Object.prototype.hasOwnProperty.call(session, key), `session missing field ${key}`)
  })
  assert.strictEqual(session.patientId, '7', 'patientId derived from active PATIENT role')
  assert.strictEqual(session.principalId, 'identity-1')
  assert.strictEqual(session.orgId, '42')
  assert.deepStrictEqual(session.handoffSession, { code: '', url: '', targetPath: '', issuedAt: null })
  assert.deepStrictEqual(session.wearableSession,
    { iotBaseUrl: '', wearableToken: '', wearableSessionId: '', deviceRef: '', patientId: '' })

  // 只有一个会话键被写入，旧分散键不存在
  assert.deepStrictEqual(Array.from(store.keys()), [SESSION_KEY], 'only the atomic session key is persisted')
  assert.strictEqual(store.get(SESSION_KEY).refreshToken, 'refresh-1')
})()

// —— 2. 读取时迁移旧分散键并删除它们 ——
;(function migratesLegacyKeys () {
  const s = fresh()
  store.set(LEGACY_AUTH_KEY, {
    accessToken: 'legacy-access', refreshToken: 'legacy-refresh',
    activeRole: 'PATIENT', identityId: 'id-9', orgId: '3', patientRef: 'patient-9',
    roles: [{ roleType: 'PATIENT', patientId: 'patient-9' }], cdmsBaseUrl: 'https://cdms'
  })
  store.set(LEGACY_WEARABLE_KEY, {
    iotBaseUrl: 'https://iot', wearableToken: 'old-wear', wearableSessionId: 'old-sess',
    wearableDeviceRef: 'dev-1', patientRef: 'patient-9'
  })

  const migrated = s.readSession()
  assert.ok(migrated, 'legacy keys must be readable as a session')
  assert.strictEqual(migrated.refreshToken, 'legacy-refresh')
  assert.strictEqual(migrated.accessToken, 'legacy-access')
  assert.strictEqual(migrated.patientId, 'patient-9')
  assert.strictEqual(migrated.wearableSession.wearableToken, 'old-wear',
    'legacy wearable key folds into the atomic wearableSession sub-object')

  // 迁移后旧键必须被删除，新键必须落盘
  assert.strictEqual(store.has(LEGACY_AUTH_KEY), false, 'legacy auth key removed after migration')
  assert.strictEqual(store.has(LEGACY_WEARABLE_KEY), false, 'legacy wearable key removed after migration')
  assert.ok(store.has(SESSION_KEY), 'migrated session persisted under the atomic key')
})()

// —— 3. clearSession 整体清空（含旧键），而非只删一个 token ——
;(function clearsEntirely () {
  const s = fresh()
  s.writeSession({ accessToken: 'a', refreshToken: 'r', activeRole: 'DOCTOR' }, null)
  store.set(LEGACY_AUTH_KEY, { leftover: true })
  store.set(LEGACY_WEARABLE_KEY, { leftover: true })

  s.clearSession()
  assert.strictEqual(store.has(SESSION_KEY), false)
  assert.strictEqual(store.has(LEGACY_AUTH_KEY), false)
  assert.strictEqual(store.has(LEGACY_WEARABLE_KEY), false)
  assert.strictEqual(s.readSession(), null, 'no session after clear')
})()

// —— 4. normalizeSession：缺 refreshToken 视为无会话 ——
;(function requiresRefreshToken () {
  const s = fresh()
  assert.strictEqual(s.normalizeSession({ accessToken: 'only-access' }, null), null)
})()

// —— 5. 兼容别名仍可用（readAuth/writeAuth/clearAuth/normalizeAuth）——
;(function legacyAliases () {
  const s = fresh()
  const session = s.writeAuth({ accessToken: 'a', refreshToken: 'r', activeRole: 'PATIENT',
    identityId: 'id-1', roles: [{ roleType: 'PATIENT', patientId: 'p-1' }] })
  assert.ok(session && session.refreshToken === 'r')
  const auth = s.readAuth()
  assert.strictEqual(auth.activeRole, 'PATIENT')
  assert.strictEqual(auth.identityId, 'id-1')
  s.clearAuth()
  assert.strictEqual(s.readSession(), null)
})()

console.log('session-store atomic tests passed')