/**
 * 安全签到二维码解析（阶段三交付项 1）：新旧格式分流、严格字段白名单、
 * 未知 version/scene 与篡改结构一律失败关闭。纯函数直测 utils/checkin-qrcode。
 * 风格对齐现有 *.test.js：require + assert，直接 node test/checkin-qrcode.test.js 运行。
 */
const assert = require('assert')
const checkinQr = require('../miniprogram/utils/checkin-qrcode')

// ---- NEW 安全码：ORG_CHECKIN / DEVICE_STATION ----

const orgCode = '{"version":1,"scene":"ORG_CHECKIN","token":"opaque-org-token"}'
const deviceCode = '{"version":1,"scene":"DEVICE_STATION","token":"opaque-device-token"}'

let parsed = checkinQr.parse(orgCode)
assert.deepStrictEqual(parsed, { kind: 'NEW', version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-token' })

parsed = checkinQr.parse(deviceCode)
assert.deepStrictEqual(parsed, { kind: 'NEW', version: 1, scene: 'DEVICE_STATION', token: 'opaque-device-token' })

// 前后空白容忍（微信扫码偶尔带回换行/空格）
parsed = checkinQr.parse('  ' + orgCode + '\n')
assert.strictEqual(parsed && parsed.kind, 'NEW', '首尾空白不应破坏 JSON 解析')
assert.strictEqual(parsed.scene, 'ORG_CHECKIN')

// ---- NEW 严格性：未知版本 / 未知 scene / 字段篡改 → null（失败关闭）----

const rejected = [
  // 未知版本
  '{"version":2,"scene":"ORG_CHECKIN","token":"t"}',
  '{"version":0,"scene":"ORG_CHECKIN","token":"t"}',
  '{"version":"1","scene":"ORG_CHECKIN","token":"t"}',
  // 未知 / 大小写不符 scene
  '{"version":1,"scene":"CHECKIN","token":"t"}',
  '{"version":1,"scene":"org_checkin","token":"t"}',
  '{"version":1,"scene":"OTHER_SCENE","token":"t"}',
  // 字段白名单之外（篡改结构 / 附加字段）
  '{"version":1,"scene":"ORG_CHECKIN","token":"t","orgId":"9"}',
  '{"version":1,"scene":"DEVICE_STATION","token":"t","stationId":"123"}',
  // 缺失字段
  '{"version":1,"scene":"ORG_CHECKIN"}',
  '{"version":1,"token":"t"}',
  '{"scene":"ORG_CHECKIN","token":"t"}',
  '{}',
  '{"version":1,"scene":"ORG_CHECKIN","token":123}',
  '{"version":1,"scene":"ORG_CHECKIN","token":null}',
  '{"version":1,"scene":"ORG_CHECKIN","token":""}',
  '{"version":1,"scene":"ORG_CHECKIN","token":"a\nb"}',
  '{"version":1,"scene":123,"token":"t"}',
  // 顶层不是对象
  '[1,2,3]',
  '"string"'
]
for (const raw of rejected) {
  assert.strictEqual(checkinQr.parse(raw), null, '必须拒绝（失败关闭）：' + raw)
}
// 超长 token 拒绝
const longToken = 't'.repeat(checkinQr.MAX_TOKEN_LENGTH + 1)
assert.strictEqual(checkinQr.parse('{"version":1,"scene":"ORG_CHECKIN","token":"' + longToken + '"}'), null, '超长 token 拒绝')
// 恰好上限可通过
const edgeToken = 't'.repeat(checkinQr.MAX_TOKEN_LENGTH)
parsed = checkinQr.parse('{"version":1,"scene":"ORG_CHECKIN","token":"' + edgeToken + '"}')
assert.ok(parsed && parsed.token.length === checkinQr.MAX_TOKEN_LENGTH, '上限内 token 通过')
// 损坏 JSON（以 { 开头但不可解析）拒绝
assert.strictEqual(checkinQr.parse('{version:1,scene:"ORG_CHECKIN",token:"t"}'), null, '非严格 JSON 拒绝')
assert.strictEqual(checkinQr.parse('{\"version\":1,\"scene\":\"ORG_CHECKIN\",'), null, '截断 JSON 拒绝')

// ---- LEGACY 老码（v1 过渡，原通道零改动）----

// 设备场次老码（医生工作站当前输出协议）
const legacyStation = 'cdms://scale-checkin?stationId=1972545374712086529&token=chk-token-abc'
parsed = checkinQr.parse(legacyStation)
assert.deepStrictEqual(parsed, { kind: 'LEGACY_STATION', stationId: '1972545374712086529', checkinToken: 'chk-token-abc' })

// 老码残缺（缺 stationId / 缺 token）→ null
assert.strictEqual(checkinQr.parse('cdms://scale-checkin?stationId=197&token='), null)
assert.strictEqual(checkinQr.parse('cdms://scale-checkin?stationId=&token=t'), null)
assert.strictEqual(checkinQr.parse('cdms://scale-checkin?'), null)
assert.strictEqual(checkinQr.parse('cdms://scale-checkin?stationId=197'), null)

// 通用机构老码 → LEGACY_GENERIC（携带原参数）
parsed = checkinQr.parse('cdms://checkin?orgId=org-123')
assert.strictEqual(parsed.kind, 'LEGACY_GENERIC')
assert.deepStrictEqual(parsed.params, { orgId: 'org-123' })
// 空参数但协议头匹配 → 仍按通用签到（与老 scale-qr 语义一致）
parsed = checkinQr.parse('cdms://checkin?')
assert.strictEqual(parsed.kind, 'LEGACY_GENERIC')

// ---- 完全无关 / 损坏 / 空输入 → null ----

for (const raw of ['', null, undefined, 123, {}, [], 'https://jq.mockr.com.cn/cdms/', 'cdms://other?stationId=1&token=t', 'random-text', '\uFEFF']) {
  assert.strictEqual(checkinQr.parse(raw), null, '拒绝无关输入：' + String(raw))
}

// 老场次码与 JSON 安全码严格区分：JSON 码带 stationId 仍被白名单拒绝（不能冒充老码）
assert.strictEqual(checkinQr.parse('{"version":1,"scene":"DEVICE_STATION","token":"t","stationId":"197"}'), null)

console.log('checkin qrcode tests passed')
