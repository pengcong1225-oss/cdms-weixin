const assert = require('assert')
const {
  buildFrame, buildSetTimeFrame, buildReadBatteryFrame, parseMfa1Frame, FrameAssembler, readFloat32BE, isMfa1Device,
  parseLipid, LIPID_DATA_BYTES,
  CMD_SET_TIME, CMD_TEST_RESULT
} = require('../miniprogram/services/mfa1/mfa1Ble')

// 二期不注入 setTimeout 桩：超时降级由 flush() 显式驱动（见下方用例），避免挂起定时器拖住测试进程。

function bytes (frame) { return Array.from(frame) }
function crcOf (first15) { return first15.reduce((sum, value) => (sum + value) & 0xff, 0) }
// 载荷区字节 1..14 不足自动补 00，凑满 15 字节后追加 CRC（字节 15）
function frameOf (head) {
  const padded = head.slice(0, 15)
  while (padded.length < 15) padded.push(0)
  return Uint8Array.from([...padded, crcOf(padded)])
}
// 与 frameOf 相同语义（截到 15 字节 + CRC），显式命名以表达「整帧载荷」用例意图
function frameOfFull (head) {
  const padded = head.slice(0, 15)
  while (padded.length < 15) padded.push(0)
  return Uint8Array.from([...padded, crcOf(padded)])
}

// ---- 帧构造：16 字节定长，字节15 = 前 15 字节求和 & 0xFF ----

const batteryFrame = buildFrame(0x13)
assert.strictEqual(batteryFrame.length, 16)
assert.strictEqual(batteryFrame[0], 0x13)
assert.strictEqual(batteryFrame[15], crcOf(bytes(batteryFrame).slice(0, 15)))

// 0x13 读取电量：载荷首字节 AA 必须 0x99（协议 §4「现在进行一次电量检测」）。
// 真机实证：AA=0x00 时设备不回电量包。
const batteryRead = buildReadBatteryFrame()
assert.deepStrictEqual(bytes(batteryRead).slice(0, 2), [0x13, 0x99])
assert.deepStrictEqual(bytes(batteryRead).slice(2, 15), [0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
assert.strictEqual(batteryRead[15], crcOf(bytes(batteryRead).slice(0, 15)))

// 0x01 设置时间：年月日时分秒六个字段全部 BCD（协议 §3.1）。
// 真机实证：时分用二进制（12→0x0C、29→0x1D）是非 BCD 位，设备回 0x81 执行 Fail。
const setTime = buildSetTimeFrame(new Date(2026, 7, 29, 9, 30, 15))
assert.deepStrictEqual(bytes(setTime).slice(0, 7), [0x01, 0x26, 0x08, 0x29, 0x09, 0x30, 0x15])
assert.deepStrictEqual(bytes(setTime).slice(7, 15), [0, 0, 0, 0, 0, 0, 0, 0])
assert.strictEqual(setTime[15], crcOf(bytes(setTime).slice(0, 15)))

// 回归：真机失败那笔时间（12:29:02）修复后必须是 BCD 位，且每个字段都不是二进制原值。
const captured = buildSetTimeFrame(new Date(2026, 8, 10, 12, 29, 2))
assert.deepStrictEqual(bytes(captured).slice(0, 7), [0x01, 0x26, 0x09, 0x10, 0x12, 0x29, 0x02])
for (const value of bytes(captured).slice(1, 7)) {
  assert.ok((value >> 4) <= 9 && (value & 0x0f) <= 9, 'BCD 高/低半字节都必须 ≤ 9：' + value.toString(16))
}
assert.strictEqual(captured[15], crcOf(bytes(captured).slice(0, 15)))

// 结果帧构造器：总长 total 字节（GLU/UA/血压 20、血脂 31）——帧头 + 0 填充到 total-1 + CRC（求和 & 0xFF）
function varFrame (head, total) {
  const padded = head.slice(0, total - 1)
  while (padded.length < total - 1) padded.push(0)
  return Uint8Array.from([...padded, crcOf(padded)])
}
function resultFrame (head19) { return varFrame(head19, 20) }
// 31 字节血脂帧：0x78 03 + D1..D17（TC@2、D5@6、HDL@7、TG@11、LDL@15）+ 尾部（000 TT 时间戳 00）+ CRC
function lipidFrame ({ tc, d5, hdl, tg, ldl }) {
  return varFrame([0x78, 0x03, ...f32b(tc), d5, ...f32b(hdl), ...f32b(tg), ...f32b(ldl)], 31)
}
function f32b (value) {
  const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, false)
  return Array.from(new Uint8Array(view.buffer))
}

// ---- 0x78 GLU：大端 IEEE754 float（5.5 = 0x40B00000），D5=1 空腹 ----
// 布局 = 协议 §6 字面格式：78 T1 D1..D5 00 00 00 TT YY MM DD HH mm SS 00 00 CRC

const gluFrame = resultFrame([0x78, 0x01, 0x40, 0xb0, 0x00, 0x00, 0x01, 0, 0, 0, 0x0b, 26, 9, 10, 12, 48, 18])
const glu = parseMfa1Frame(gluFrame)
assert.strictEqual(glu.command, CMD_TEST_RESULT)
assert.strictEqual(glu.type, 'result')
assert.deepStrictEqual(glu.metric, { name: 'glucose', value: 5.5, unit: 'mmol/L', state: '空腹', fastState: 1 })
assert.strictEqual(gluFrame.length, 20, 'GLU/UA/血压结果帧为 20 字节')

// 餐后标记 + 血糖 6.1
const postMeal = resultFrame([0x78, 0x01, ...f32b(6.1), 0x02])
const parsedPost = parseMfa1Frame(postMeal)
assert.strictEqual(parsedPost.metric.name, 'glucose')
assert.strictEqual(parsedPost.metric.value, 6.1)
assert.strictEqual(parsedPost.metric.state, '餐后')

// ---- 0x78 UA 解析 ----

const uaFrame = resultFrame([0x78, 0x02, ...f32b(0.32), 0x02])
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

assert.deepStrictEqual(parseMfa1Frame(frameOf([0x13, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])), { command: 0x13, type: 'battery', level: 55 })
// 真机抓包回归：0x83 必须按 BCD 解成 83%（直读会变成 131%）；0x94 → 94%（直读 148%）
assert.strictEqual(parseMfa1Frame(frameOf([0x13, 0x83, 0x00, 0x03, 0x92, 0x00, 0x02, 0x78, 0, 0, 0, 0, 0, 0])).level, 83)
assert.strictEqual(parseMfa1Frame(frameOf([0x13, 0x94, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])).level, 94)
assert.deepStrictEqual(parseMfa1Frame(frameOf([0x01, 0x26, 0x08, 0x1d, 0x09, 0x1e, 0x0f, 0, 0, 0, 0, 0, 0, 0])), { command: CMD_SET_TIME, type: 'timeSyncAck' })

// 0x41 取得时间应答：AA BB CC DD EE FF 为年月日时分秒，同为 BCD 解码（协议 §2）
const readTime = parseMfa1Frame(frameOf([0x41, 0x26, 0x09, 0x10, 0x12, 0x29, 0x02, 0, 0, 0, 0, 0, 0, 0]))
assert.deepStrictEqual(readTime, { command: 0x41, type: 'time', year: 2026, month: 9, day: 10, hour: 12, minute: 29, second: 2 })

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

// ---- 二期：0x78 血压 T1=4：D1(byte2)=0、D2(byte3)=心率、D3(byte4)=舒张压、D4(byte5)=收缩压 ----

const bpFrame = resultFrame([0x78, 0x04, 0, 72, 78, 126])
const bp = parseMfa1Frame(bpFrame)
assert.strictEqual(bp.type, 'result')
assert.ok(Array.isArray(bp.metrics) && bp.metrics.length === 3, '血压应产出三个 metric')
assert.deepStrictEqual(bp.metrics, [
  { name: 'systolic', value: 126, unit: 'mmHg' },
  { name: 'diastolic', value: 78, unit: 'mmHg' },
  { name: 'heartRate', value: 72, unit: 'bpm' }
])
// 与 device-mfa1 页面消费方式一致：metric 为简单数值，可直接渲染/入草稿
assert.strictEqual(bp.metric.name, 'systolic')
assert.strictEqual(typeof bp.metric.value, 'number')

// 真机抓包回归（2026-09-10 12:48 实测血压）：整帧 20 字节，CRC=前 19 字节和的低 8 位。
// 旧 16 字节定长切帧把这帧拦腰截断 → CRC 必错 → 「设备连上了但数据不返回」的根因。
const realBp = Uint8Array.from([
  0x78, 0x04, 0x00, 0x4e, 0x3c, 0x6c, 0x01, 0x00, 0x01, 0x00, 0x0b, 0x26, 0x09, 0x10, 0x12, 0x48, 0x18, 0x00, 0x00, 0x30
])
assert.strictEqual(realBp.length, 20)
const realBpParsed = parseMfa1Frame(realBp)
assert.strictEqual(realBpParsed.type, 'result')
assert.deepStrictEqual(realBpParsed.metrics.map(item => [item.name, item.value]), [
  ['systolic', 108], ['diastolic', 60], ['heartRate', 78]
])

// ---- 二期：血脂 31 字节单帧直出（真机协议实证，拼接挂起假设已废弃）----

// 完整血脂：TC=5.2、D5=1 空腹、HDL=1.3、TG=1.8、LDL=3.1
const lipidFull = lipidFrame({ tc: 5.2, d5: 0x01, hdl: 1.3, tg: 1.8, ldl: 3.1 })
assert.strictEqual(lipidFull.length, 31, '血脂结果帧为 31 字节（D1..D17 全量）')
const lipAsm = new FrameAssembler()
const done = lipAsm.push(lipidFull)
assert.strictEqual(done.length, 1)
assert.strictEqual(done[0].type, 'result')
assert.strictEqual(done[0].complete, true)
assert.ok(!done[0].metrics.some(item => item.partial), '单帧拿全四指标不得带 partial')
assert.deepStrictEqual(done[0].metrics.map(item => [item.name, item.value]), [
  ['tc', 5.2], ['hdl', 1.3], ['tg', 1.8], ['ldl', 3.1]
])
// D5=0x01 → 空腹标记透传到每个血脂 metric
assert.strictEqual(done[0].metrics[0].state, '空腹')
assert.strictEqual(done[0].metrics[0].fastState, 1)

// MTU 分包：31 字节帧拆 20+11 两次通知，凑满才出帧（单帧一次，绝不挂起）
const splitAsm = new FrameAssembler()
assert.deepStrictEqual(splitAsm.push(lipidFull.slice(0, 20)), [], '前 20 字节不成帧（不足 31）')
const splitOut = splitAsm.push(lipidFull.slice(20))
assert.strictEqual(splitOut.length, 1)
assert.strictEqual(splitOut[0].complete, true)
assert.strictEqual(splitOut[0].metrics.length, 4)

// 部分血脂：TG 字段 4 字节全 0 视为缺失 → 只报 3 项且整批 partial:true，当场透传（无挂起/无 flush）
const lipidPartial = lipidFrame({ tc: 5.2, d5: 0x01, hdl: 1.3, tg: 0, ldl: 3.1 })
const partAsm = new FrameAssembler()
const partOut = partAsm.push(lipidPartial)
assert.strictEqual(partOut.length, 1)
assert.strictEqual(partOut[0].type, 'result')
assert.strictEqual(partOut[0].complete, false)
const dm = partOut[0].metrics
assert.strictEqual(dm.length, 3, 'TG 缺失 → tc/hdl/ldl 三项')
assert.deepStrictEqual(dm.map(item => item.name), ['tc', 'hdl', 'ldl'])
assert.ok(dm.every(item => item.partial === true), '不完整批次必须带 partial:true')
assert.strictEqual(dm[0].state, '空腹')

// 粘包：16 字节命令应答 + 20 字节结果帧粘连一次到达，各自成帧
const batteryAckFrame = frameOf([0x13, 0x55, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0])
const mixAckAsm = new FrameAssembler()
const mixAck = mixAckAsm.push(new Uint8Array([...batteryAckFrame, ...gluFrame]))
assert.strictEqual(mixAck.length, 2)
assert.strictEqual(mixAck[0].type, 'battery')
assert.strictEqual(mixAck[1].metric.name, 'glucose')

// 帧错位重同步：帧前混入脏字节 → CRC 失败逐字节丢弃，对齐后仍完整出结果
const dirtyAsm = new FrameAssembler()
const dirty = dirtyAsm.push(new Uint8Array([0x00, 0x5a, ...Array.from(gluFrame)]))
assert.strictEqual(dirty.length, 1, '脏字节被重同步跳过，GLU 结果不丢')
assert.strictEqual(dirty[0].metric.value, 5.5)

// parseLipid 纯函数：空流无指标
assert.deepStrictEqual(parseLipid(new Uint8Array(0), 1).metrics, [])

// GLU 回归经 assembler 不破：非挂起态单帧直出
const gluAsm = new FrameAssembler()
const gluOut = gluAsm.push(gluFrame)
assert.strictEqual(gluOut.length, 1)
assert.strictEqual(gluOut[0].type, 'result')
assert.deepStrictEqual(gluOut[0].metric, { name: 'glucose', value: 5.5, unit: 'mmol/L', state: '空腹', fastState: 1 })

console.log('mfa1 ble tests passed')
