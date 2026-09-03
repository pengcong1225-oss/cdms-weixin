const assert = require('assert')
const { buildQrMatrix, createCheckinPayload, drawQr, parseCheckinPayload } = require('../miniprogram/utils/scale-qr')

// 构造：二维码只包含场次 ID 与不透明签到令牌
const payload = createCheckinPayload('1972545374712086529', 'chk-token-abc')
assert.strictEqual(payload, 'cdms://scale-checkin?stationId=1972545374712086529&token=chk-token-abc')

// 缺失令牌或场次时返回空串，不生成半成品二维码
assert.strictEqual(createCheckinPayload('', 'tok'), '')
assert.strictEqual(createCheckinPayload('197', ''), '')
assert.strictEqual(createCheckinPayload(null, null), '')

// 解析：合法载荷回读，且只暴露 stationId 与 checkinToken
const parsed = parseCheckinPayload(payload)
assert.deepStrictEqual(parsed, { stationId: '1972545374712086529', checkinToken: 'chk-token-abc' })

// 安全不变量：携带患者 ID 或机构 ID 的载荷必须拒绝，防止客户端伪造身份
assert.strictEqual(parseCheckinPayload('cdms://scale-checkin?stationId=197&token=t&patientId=768495013408443'), null)
assert.strictEqual(parseCheckinPayload('cdms://scale-checkin?stationId=197&token=t&orgId=1'), null)

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