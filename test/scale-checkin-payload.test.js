const assert = require('assert')
const { buildQrMatrix, createCheckinPayload, createGenericCheckinPayload, drawQr, parseCheckinPayload } = require('../miniprogram/utils/scale-qr')

// 构造：二维码只包含场次 ID 与不透明签到令牌（医生端仍输出老协议前缀）
const payload = createCheckinPayload('1972545374712086529', 'chk-token-abc')
assert.strictEqual(payload, 'cdms://scale-checkin?stationId=1972545374712086529&token=chk-token-abc')

// 缺失令牌或场次时返回空串，不生成半成品二维码
assert.strictEqual(createCheckinPayload('', 'tok'), '')
assert.strictEqual(createCheckinPayload('197', ''), '')
assert.strictEqual(createCheckinPayload(null, null), '')

// 通用签到码：cdms://checkin?orgId=xxx
const genericPayload = createGenericCheckinPayload('org-123')
assert.strictEqual(genericPayload, 'cdms://checkin?orgId=org-123')
assert.strictEqual(createGenericCheckinPayload(''), '')

// 解析：合法场次载荷回读并标记 STATION
const parsed = parseCheckinPayload(payload)
assert.deepStrictEqual(parsed, { stationId: '1972545374712086529', checkinToken: 'chk-token-abc', kind: 'STATION' })

// 解析：通用签到载荷（仅 orgId）识别为 GENERIC，不暴露站场身份
const generic = parseCheckinPayload(genericPayload)
assert.strictEqual(generic.kind, 'GENERIC')
assert.deepStrictEqual(generic.params, { orgId: 'org-123' })

// 解析：空参数但协议头匹配 → 仍走通用签到（GENERIC）
const emptyParams = parseCheckinPayload('cdms://checkin?')
assert.strictEqual(emptyParams.kind, 'GENERIC')

// 兼容：老场景载荷即使携带 orgId/patientId，只要 stationId+token 齐全仍按场次签到处理
// （患者端不信任这些附加参数，只使用 stationId 与 checkinToken）
const stationWithOrg = parseCheckinPayload('cdms://scale-checkin?stationId=197&token=t&orgId=1')
assert.deepStrictEqual(stationWithOrg, { stationId: '197', checkinToken: 't', kind: 'STATION' })

// 非本业务协议、损坏协议均拒绝
assert.strictEqual(parseCheckinPayload('https://jq.mockr.com.cn/cdms/'), null)
assert.strictEqual(parseCheckinPayload('cdms://other?stationId=1&token=t'), null)
assert.strictEqual(parseCheckinPayload(''), null)
assert.strictEqual(parseCheckinPayload(null), null)

// 特殊字符在构造与解析之间保持无损
const weird = createCheckinPayload('st a+b/c', 'tk&=x')
const weirdParsed = parseCheckinPayload(weird)
assert.strictEqual(weirdParsed.stationId, 'st a+b/c')
assert.strictEqual(weirdParsed.checkinToken, 'tk&=x')
assert.strictEqual(weirdParsed.kind, 'STATION')

// 矩阵：有载荷产出正方形布尔矩阵（空串由库自动选择最小版本号）
const matrix = buildQrMatrix(payload)
assert.ok(matrix.length >= 21)
matrix.forEach(row => {
  assert.strictEqual(row.length, matrix.length)
  row.forEach(cell => assert.strictEqual(typeof cell, 'boolean'))
})

// drawQr 在缺少上下文时静默返回，不抛错
assert.doesNotThrow(() => drawQr(null, matrix, { size: 240 }))
assert.doesNotThrow(() => drawQr({ fillRect () {}, setFillStyle () {}, draw () {} }, [], { size: 240 }))

console.log('scale checkin payload tests passed')
