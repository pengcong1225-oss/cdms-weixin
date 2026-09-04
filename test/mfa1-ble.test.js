const assert = require('assert')
const {
  buildFrame, buildSetTimeFrame, parseMfa1Frame, FrameAssembler, readFloat32BE, isMfa1Device,
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

// ---- 二期：0x78 血压 T1=4：D2(byte2)=心率、D3(byte3)=舒张压、D4(byte4)=收缩压 ----

const bpFrame = frameOf([0x78, 0x04, 72, 78, 126, 0, 0, 0, 0, 0, 0, 0, 0, 0])
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

// ---- 二期：血脂多帧聚合（起始帧 D1..D13 + 续帧拼出 D1..D17）----

function f32 (value) {
  const view = new DataView(new ArrayBuffer(4)); view.setFloat32(0, value, false)
  return Array.from(new Uint8Array(view.buffer))
}
// 拼接流约定（与实现一致，见 mfa1Ble 类注释）：TC@0、D5@4、HDL@5、TG@9、LDL@13。
// 起始帧承载 TC+D5+HDL（data 前 9 字节）；第 k 笔续帧的 data 段写入流偏移 5+8(k-1)，
// 零字节视为空洞不覆盖。cont1 在段偏移 4 起带 TG，cont2 在段偏移 0 起带 LDL。
const lipidStart = frameOfFull([0x78, 0x03, ...f32(5.2), 0x01, ...f32(1.3)])
const lipidCont = frameOfFull([0x78, 0x03, 0x00, 0x00, 0x00, 0x00, ...f32(1.8)]) // 段偏移4→流@9=TG
const lipidCont2 = frameOfFull([0x78, 0x03, ...f32(3.1)]) // 第二笔槽@13 → LDL

const lipAsm = new FrameAssembler()
const first = lipAsm.push(lipidStart)
assert.strictEqual(first.length, 1)
assert.strictEqual(first[0].type, 'lipidPending', '起始帧只广播等待续帧，不立即出结果')
const mid = lipAsm.push(lipidCont)
assert.strictEqual(mid[0].type, 'lipidPending', '一笔续帧仍缺 LDL，继续挂起')
const done = lipAsm.push(lipidCont2)
assert.strictEqual(done.length, 1)
assert.strictEqual(done[0].type, 'result')
assert.strictEqual(done[0].complete, true)
assert.ok(!done[0].metrics.some(item => item.partial), '凑满后不得带 partial')
assert.deepStrictEqual(done[0].metrics.map(item => [item.name, item.value]), [
  ['tc', 5.2], ['hdl', 1.3], ['tg', 1.8], ['ldl', 3.1]
])
// D5=0x01（流第 5 字节 = 起始帧字节 6）→ 空腹标记透传到每个血脂 metric
assert.strictEqual(done[0].metrics[0].state, '空腹')
assert.strictEqual(done[0].metrics[0].fastState, 1)

// 不足帧降级：只有起始帧（TC/D5/HDL 前缀）→ 报 tc/hdl 两项，partial:true
const partAsm = new FrameAssembler()
partAsm.push(lipidStart)
const drained = partAsm.flush()
assert.strictEqual(drained.length, 1)
assert.strictEqual(drained[0].type, 'result')
assert.strictEqual(drained[0].complete, false)
const dm = drained[0].metrics
assert.strictEqual(dm.length, 2, '起始帧前缀 → tc/hdl 完整、tg/ldl 待补')
assert.deepStrictEqual(dm.map(item => item.name), ['tc', 'hdl'])
assert.strictEqual(dm[0].value, 5.2)
assert.strictEqual(dm[1].value, 1.3)
assert.ok(dm.every(item => item.partial === true), '降级 metric 必须带 partial:true')
assert.strictEqual(dm[0].state, '空腹')
assert.deepStrictEqual(partAsm.flush(), [], 'flush 后挂起已清空')

// 挂起中收到错误应答：错误帧透传（onResult 走错误提示），血脂仍可继续凑帧或最终降级
const errAsm = new FrameAssembler()
errAsm.push(lipidStart)
const withErr = errAsm.push(errorFrame)
assert.strictEqual(withErr.length, 1)
assert.strictEqual(withErr[0].type, 'error')
errAsm.push(lipidCont)
const resumed = errAsm.push(lipidCont2)
assert.strictEqual(resumed[0].type, 'result')
assert.strictEqual(resumed[0].complete, true)

// CRC 错误的血脂续帧被丢弃、不污染拼接流；随后正确续帧仍完整出四指标
const crcAsm = new FrameAssembler()
crcAsm.push(lipidStart)
const badCont = Uint8Array.from([...lipidCont.slice(0, 15), (lipidCont[15] + 1) & 0xff])
assert.deepStrictEqual(crcAsm.push(badCont), [], '坏 CRC 帧丢弃且不结束挂起')
crcAsm.push(lipidCont)
const afterBad = crcAsm.push(lipidCont2)
assert.strictEqual(afterBad[0].type, 'result')
assert.strictEqual(afterBad[0].metrics.length, 4)

// 挂起中插入一帧 GLU：先以已收前缀降级收尾血脂（partial），再放行 GLU 结果帧
const mixAsm = new FrameAssembler()
mixAsm.push(lipidStart)
const mixed = mixAsm.push(gluFrame)
assert.strictEqual(mixed.length, 2)
assert.strictEqual(mixed[0].type, 'result')
assert.strictEqual(mixed[0].complete, false)
assert.ok(mixed[0].metrics.every(item => item.partial === true))
assert.strictEqual(mixed[1].metric.name, 'glucose')
assert.strictEqual(mixed[1].metric.value, 5.5)
// 混入后挂起已释放：下一帧血脂按新起始处理
const fresh = mixAsm.push(lipidStart)
assert.strictEqual(fresh[0].type, 'lipidPending')

// parseLipid 纯函数：空流无指标
assert.deepStrictEqual(parseLipid(new Uint8Array(0), 1).metrics, [])

// GLU 回归经 assembler 不破：非挂起态单帧直出
const gluAsm = new FrameAssembler()
const gluOut = gluAsm.push(gluFrame)
assert.strictEqual(gluOut.length, 1)
assert.strictEqual(gluOut[0].type, 'result')
assert.deepStrictEqual(gluOut[0].metric, { name: 'glucose', value: 5.5, unit: 'mmol/L', state: '空腹', fastState: 1 })

console.log('mfa1 ble tests passed')
