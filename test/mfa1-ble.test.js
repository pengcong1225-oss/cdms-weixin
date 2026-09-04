const assert = require('assert')
const {
  buildFrame, buildSetTimeFrame, parseMfa1Frame, FrameAssembler, readFloat32BE, isMfa1Device,
  CMD_SET_TIME, CMD_TEST_RESULT
} = require('../miniprogram/services/mfa1/mfa1Ble')

function bytes (frame) { return Array.from(frame) }
function crcOf (first15) { return first15.reduce((sum, value) => (sum + value) & 0xff, 0) }
// 载荷区字节 1..14 不足自动补 00，凑满 15 字节后追加 CRC（字节 15）
function frameOf (head) {
  const padded = head.slice(0, 15)
  while (padded.length < 15) padded.push(0)
  return Uint8Array.from([...padded, crcOf(padded)])
}

// ---- 帧构造：16 字节定长，字节15 = 前 15 字节求和 & 0xFF ----

const batteryFrame = buildFrame(0x13)
assert.strictEqual(batteryFrame.length, 16)
assert.strictEqual(batteryFrame[0], 0x13)
assert.strictEqual(batteryFrame[15], crcOf(bytes(batteryFrame).slice(0, 15)))

// 0x01 设置时间：年 BCD、月日时分秒二进制
const setTime = buildSetTimeFrame(new Date(2026, 7, 29, 9, 30, 15))
assert.deepStrictEqual(bytes(setTime).slice(0, 7), [0x01, 0x26, 0x08, 0x1d, 0x09, 0x1e, 0x0f])
assert.deepStrictEqual(bytes(setTime).slice(7, 15), [0, 0, 0, 0, 0, 0, 0, 0])
assert.strictEqual(setTime[15], crcOf(bytes(setTime).slice(0, 15)))

// ---- 0x78 GLU：大端 IEEE754 float（5.5 = 0x40B00000），D5=1 空腹 ----

const gluFrame = frameOf([0x78, 0x01, 0x40, 0xb0, 0x00, 0x00, 0x01, 0, 0, 0, 0, 0, 0, 0])
const glu = parseMfa1Frame(gluFrame)
assert.strictEqual(glu.command, CMD_TEST_RESULT)
assert.strictEqual(glu.type, 'result')
assert.deepStrictEqual(glu.metric, { name: 'glucose', value: 5.5, unit: 'mmol/L', state: '空腹', fastState: 1 })

// 餐后标记 + 血糖 6.1
const postMeal = frameOf([0x78, 0x01, ...bytes(new Uint8Array((() => {
  const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, 6.1, false)
  return new Uint8Array(view.buffer)
})())), 0x02, 0, 0, 0, 0, 0, 0])
const parsedPost = parseMfa1Frame(postMeal)
assert.strictEqual(parsedPost.metric.name, 'glucose')
assert.strictEqual(parsedPost.metric.value, 6.1)
assert.strictEqual(parsedPost.metric.state, '餐后')

// ---- 0x78 UA 解析 ----

const uaView = new DataView(new ArrayBuffer(4))
uaView.setFloat32(0, 0.32, false)
const uaBytes = new Uint8Array(uaView.buffer)
const uaFrame = frameOf([0x78, 0x02, uaBytes[0], uaBytes[1], uaBytes[2], uaBytes[3], 0x02, 0, 0, 0, 0, 0, 0, 0])
const ua = parseMfa1Frame(uaFrame)
assert.strictEqual(ua.metric.name, 'uricAcid')
assert.strictEqual(ua.metric.value, 0.32)
assert.strictEqual(ua.metric.unit, 'mmol/L')

// 大端序独立验证：小端会被解成完全不同的值
assert.strictEqual(readFloat32BE(Uint8Array.from([0x40, 0xb0, 0x00, 0x00]), 0), 5.5)

// ---- 错误应答位：命令 | 0x80 ----

const errorFrame = frameOf([0xf8, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const errorResult = parseMfa1Frame(errorFrame)
assert.strictEqual(errorResult.error, true)
assert.strictEqual(errorResult.command, CMD_TEST_RESULT)
assert.strictEqual(errorResult.type, 'error')

// ---- 电量应答 0x13 / 时间同步回显 0x01 ----

assert.deepStrictEqual(parseMfa1Frame(frameOf([0x13, 55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), { command: 0x13, type: 'battery', level: 55 })
assert.deepStrictEqual(parseMfa1Frame(frameOf([0x01, 0x26, 0x08, 0x1d, 0x09, 0x1e, 0x0f, 0, 0, 0, 0, 0, 0, 0])), { command: CMD_SET_TIME, type: 'timeSyncAck' })

// ---- CRC 坏帧丢弃 ----

assert.throws(() => parseMfa1Frame(Uint8Array.from([0x78, 0x01, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0x00])), /MFA1_FRAME_CHECKSUM/)
assert.throws(() => parseMfa1Frame(Uint8Array.from([0x78])), /MFA1_FRAME_LENGTH/)

// ---- FrameAssembler：粘包（两帧合一通知）与分包（一帧拆两次通知）----

const assembler = new FrameAssembler()
assert.deepStrictEqual(assembler.push(gluFrame.slice(0, 6)), [], '不足 16 字节不出帧')
assert.strictEqual(assembler.push(gluFrame.slice(6)).length, 1, '补齐后出一帧')
const glued = new Uint8Array([...uaFrame, ...gluFrame])
const second = new FrameAssembler()
const frames = second.push(glued)
assert.strictEqual(frames.length, 2)
assert.strictEqual(frames[0].metric.name, 'uricAcid')
assert.strictEqual(frames[1].metric.name, 'glucose')
assert.deepStrictEqual(second.push(new Uint8Array(0)), [])

// ---- 扫描匹配：广播名 "MFA-1 M XXXX" 或服务 UUID FFF0 ----

assert.strictEqual(isMfa1Device({ name: 'MFA-1 M 3A7F' }), true)
assert.strictEqual(isMfa1Device({ localName: 'mfa-1 m 3a7f' }), true)
assert.strictEqual(isMfa1Device({ serviceData: { '0000fff0-0000-1000-8000-00805f9b34fb': new ArrayBuffer(0) } }), true)
assert.strictEqual(isMfa1Device({ name: 'AiLink Scale' }), false)

console.log('mfa1 ble tests passed')
