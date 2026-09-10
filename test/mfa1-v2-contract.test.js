/**
 * 阶段二 MFA1 v2 指标契约测试（设计 §10.1 / §18.1）：
 * 全指标 payload —— 完整血脂 / 部分血脂(partial=true) / 血压 / 心率 / 三种血糖 context、
 * UNKNOWN 默认值路径与医生显式确认门禁；以及 USE_V2=false 回退形态的配置常量。
 * 风格对齐现有 *.test.js：require + assert，直接 node test/mfa1-v2-contract.test.js 运行。
 */
const assert = require('assert')
const path = require('path')

const stationApi = require('../miniprogram/utils/station-api')
const api = require('../miniprogram/utils/api')
const mfa1PagePath = path.resolve(__dirname, '../miniprogram/pages/device-mfa1/index.js')
const mfa1BleModule = require('../miniprogram/services/mfa1/mfa1Ble.js')

global.getApp = () => ({ globalData: { accessToken: 't', refreshToken: 'r', activeRole: 'DOCTOR', cdmsBaseUrl: 'https://cdms.example.com' } })
global.wx = {
  showToast: () => undefined, showModal: () => undefined, setClipboardData: () => undefined,
  navigateBack: () => undefined, switchTab: () => undefined, reLaunch: () => undefined
}

let cfg = null
global.Page = c => { cfg = c }
delete require.cache[mfa1PagePath]
require(mfa1PagePath)
const page = Object.assign({}, cfg)
page.data = JSON.parse(JSON.stringify(cfg.data))
page.setData = function (patch, callback) {
  if (!patch) return
  Object.keys(patch).forEach(k => { if (k.indexOf('.') < 0 && k.indexOf('[') < 0) this.data[k] = patch[k] })
  if (typeof callback === 'function') callback()
}
const M = globalThis.__cdmsMfa1StationTestables
assert.ok(M, 'MFA1 页面测试钩子已导出')
assert.strictEqual(M.USE_V2, true, '阶段二常态：USE_V2 打开')

async function flushPromises () { for (let i = 0; i < 8; i++) await Promise.resolve() }

// ---- 纯函数层：context 解析与 partial 判定 ----
assert.strictEqual(M.resolveGlucoseContext('POSTPRANDIAL', 1), 'POSTPRANDIAL', '医生显式选择优先于设备回显')
assert.strictEqual(M.resolveGlucoseContext('', 1), 'FASTING', '设备 D5=1 → FASTING')
assert.strictEqual(M.resolveGlucoseContext(undefined, 2), 'POSTPRANDIAL', '设备 D5=2 → POSTPRANDIAL')
assert.strictEqual(M.resolveGlucoseContext(null, 0), 'UNKNOWN', '无回显无选择 → UNKNOWN 默认')
assert.strictEqual(M.resolveGlucoseContext('RANDOM', 1), 'RANDOM', '随机只能由医生显式选择（协议 D5 无随机编码）')
assert.strictEqual(M.resolveGlucoseContext('gibberish', 2), 'POSTPRANDIAL', '非法选择退回设备回显')
assert.deepStrictEqual(M.GLUCOSE_CONTEXT_OPTIONS.map(o => o.code), ['UNKNOWN', 'FASTING', 'POSTPRANDIAL', 'RANDOM'], '四态齐备且默认项为 UNKNOWN')

assert.strictEqual(M.hasPartialLipid([{ name: 'tc' }, { name: 'hdl' }, { name: 'tg' }, { name: 'ldl' }]), false, '四项齐全不算部分')
assert.strictEqual(M.hasPartialLipid([{ name: 'tc' }, { name: 'hdl' }]), true, '缺 TG/LDL → 部分血脂')
assert.strictEqual(M.hasPartialLipid([{ name: 'tc' }, { name: 'hdl' }, { name: 'tg' }, { name: 'ldl', partial: true }]), true, '带 partial 标记即算部分')
assert.strictEqual(M.hasPartialLipid([{ name: 'glucose' }]), false, '无血脂项不触发')

// buildDraftMetrics 直测
const fullLipid = M.buildDraftMetrics([{ name: 'tc', value: 5.2, unit: 'mmol/L' }, { name: 'hdl', value: 1.3, unit: 'mmol/L' }, { name: 'tg', value: 1.8, unit: 'mmol/L' }, { name: 'ldl', value: 3.1, unit: 'mmol/L' }], {})
assert.ok(fullLipid.every(m => !m.partial), '完整血脂批次不标 partial')
assert.deepStrictEqual(fullLipid.map(m => m.type), ['tc', 'hdl', 'tg', 'ldl'])
const partLipid = M.buildDraftMetrics([{ name: 'tc', value: 5.2, unit: 'mmol/L' }, { name: 'hdl', value: 1.3, unit: 'mmol/L' }], {})
assert.ok(partLipid.every(m => m.partial === true), '未凑齐四项 → 全部标 partial=true')
const bp = M.buildDraftMetrics([{ name: 'systolic', value: 128, unit: 'mmHg' }, { name: 'diastolic', value: 82, unit: 'mmHg' }, { name: 'heartRate', value: 76, unit: 'bpm' }], {})
assert.deepStrictEqual(bp.map(m => [m.type, m.value, m.unit]), [['systolic', 128, 'mmHg'], ['diastolic', 82, 'mmHg'], ['heartRate', 76, 'bpm']], '血压三件套序列化')
assert.ok(bp.every(m => !('context' in m)), '非血糖不带 context')
const gluUnknown = M.buildDraftMetrics([{ name: 'glucose', value: 6.1, unit: 'mmol/L' }], {})
assert.strictEqual(gluUnknown[0].context, 'UNKNOWN', '无医生选择无设备回显 → UNKNOWN')
const gluFasting = M.buildDraftMetrics([{ name: 'glucose', value: 6.1, unit: 'mmol/L', fastState: 1 }], {})
assert.strictEqual(gluFasting[0].context, 'FASTING', '设备回显映射')
const gluRandom = M.buildDraftMetrics([{ name: 'glucose', value: 9.9, unit: 'mmol/L' }], { glucoseContext: 'RANDOM' })
assert.strictEqual(gluRandom[0].context, 'RANDOM', '医生选择的随机语境被保留')
assert.strictEqual(M.buildDraftMetrics([{ name: 'battery', value: 88, unit: '%' }], {}).length, 0, '电量不进临床指标数组')

// ---- 页面级端到端：v2 callNext → 各指标批次 → 草稿 payload ----
let serverSessionId = 'mfa-v2-sess-0001'
const draftCalls = []
stationApi.callNext = async () => stationApi.normalizeStation({
  id: 'st-m', status: 'OPEN', deviceType: 'MFA1', measurementSessionId: serverSessionId,
  currentQueueItem: { id: 'q-m', status: 'CALLED', patientSummary: { maskedName: '周*星' } }
})
stationApi.saveMeasurementDraft = async (stationId, queueItemId, payload) => {
  draftCalls.push({ stationId, queueItemId, payload })
  return stationApi.normalizeStation({
    id: stationId, status: 'OPEN', deviceType: 'MFA1',
    currentQueueItem: { id: queueItemId, status: 'RESULT_PENDING', draftStatus: 'RESULT_PENDING' },
    currentDraft: { id: 'draft-m', status: 'RESULT_PENDING' }
  })
}
stationApi.confirmMeasurement = async (stationId, queueItemId, draftId, payload) => {
  draftCalls.push({ fn: 'confirm', payload })
  return stationApi.normalizeStation({
    id: stationId, status: 'OPEN', deviceType: 'MFA1', currentQueueItem: { id: queueItemId, status: 'COMPLETED' }
  })
}

page.mfa1 = new mfa1BleModule.Mfa1Ble({ onState: () => {}, onResult: r => page.onMfa1Result(r) })
page.setData({ deviceTypeMismatch: false, stationId: 'st-m', connected: true, metrics: [], canConfirm: false, measuring: false, saving: false, errorText: '', currentQueueItem: null, currentDraft: null })
page.resetMeasurementState()

const resetToNewPatient = async () => {
  await page.callNext()
  assert.strictEqual(page.measurementSessionId, serverSessionId, '叫号后装载服务端会话 ID')
  page.setData({
    glucoseContextIndex: 0, glucoseContextCode: 'UNKNOWN', glucoseContextConfirmed: false, glucoseContextText: M.GLUCOSE_CONTEXT_OPTIONS[0].label, partialLipidText: '',
    metrics: [], currentDraft: null, canConfirm: false, measuring: true, errorText: ''
  })
}

const run = async () => {
  // ---- (c1) 血糖三种 context + UNKNOWN 门禁 ----
  await resetToNewPatient()
  draftCalls.length = 0
  // 设备无回显（fastState=0）→ UNKNOWN：结果到达但草稿被门禁挂起，等医生显式确认
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'glucose', value: 5.5, unit: 'mmol/L', fastState: 0 }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 0, 'UNKNOWN 血糖不自动提交草稿（要求医生显式确认）')
  assert.ok(/选择血糖测量语境|请先选择/.test(page.data.statusText), '提示医生选择语境')
  assert.strictEqual(page.data.glucoseContextCode, 'UNKNOWN', '页面默认语境保持 UNKNOWN')
  // 医生选「空腹」→ 立即补交，context=FASTING
  page.onGlucoseContextChange({ detail: { value: 1 } })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '显式确认后补交草稿')
  assert.strictEqual(draftCalls[0].payload.metrics[0].context, 'FASTING', '医生选择 FASTING 生效')
  assert.strictEqual(draftCalls[0].payload.measurementSessionId, serverSessionId, 'v2 草稿携带服务端会话 ID')
  // 明确成功后本次幂等 key 被消费（下一次测量动作重新生成）
  assert.strictEqual(page.measurementIdempotencyKey, '', '草稿成功后幂等 key 已消费')
  assert.ok(String(draftCalls[0].payload.idempotencyKey).startsWith('station-draft-'), '幂等 key 形态不变')

  // 设备回显 D5=2 → 自动 POSTPRANDIAL，无需再选
  await resetToNewPatient()
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'glucose', value: 8.8, unit: 'mmol/L', state: '餐后', fastState: 2 }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '设备语境明确的血糖自动提交')
  assert.strictEqual(draftCalls[0].payload.metrics[0].context, 'POSTPRANDIAL')

  // RANDOM：叫号后先选随机，再收无回显结果
  await resetToNewPatient()
  page.onGlucoseContextChange({ detail: { value: 3 } })
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'glucose', value: 11.1, unit: 'mmol/L', fastState: 0 }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '已选 RANDOM 后无回显结果可提交')
  assert.strictEqual(draftCalls[0].payload.metrics[0].context, 'RANDOM', 'RANDOM 语义保留（§18.1 context 不丢失）')

  // ---- (c2) 完整血脂 / 部分血脂 ----
  await resetToNewPatient()
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', complete: true, metric: { name: 'tc', value: 5.2, unit: 'mmol/L' }, metrics: [
    { name: 'tc', value: 5.2, unit: 'mmol/L' }, { name: 'hdl', value: 1.3, unit: 'mmol/L' }, { name: 'tg', value: 1.8, unit: 'mmol/L' }, { name: 'ldl', value: 3.1, unit: 'mmol/L' }
  ], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '完整血脂批次正常入草稿（阶段二解除收口）')
  const lipidPayload = draftCalls[0].payload.metrics
  assert.deepStrictEqual(lipidPayload.map(m => m.type), ['tc', 'hdl', 'tg', 'ldl'])
  assert.ok(lipidPayload.every(m => !m.partial), '完整血脂不标 partial')
  assert.strictEqual(page.data.partialLipidText, '', '完整时不显示部分提示')

  await resetToNewPatient()
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', complete: false, metric: { name: 'tc', value: 5.2, unit: 'mmol/L', partial: true }, metrics: [
    { name: 'tc', value: 5.2, unit: 'mmol/L', partial: true }, { name: 'hdl', value: 1.3, unit: 'mmol/L', partial: true }
  ], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '部分血脂也入草稿（带标记，医生可判断）')
  assert.ok(draftCalls[0].payload.metrics.every(m => m.partial === true), '未凑齐四项 → partial=true 序列化')
  assert.ok(/部分血脂结果/.test(page.data.statusText) || page.data.partialLipidText === M.PARTIAL_RESULT_TEXT, '界面显示「部分血脂结果」（§10.1）')

  // ---- (c3) 血压 + 心率 ----
  await resetToNewPatient()
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'systolic', value: 128, unit: 'mmHg' }, metrics: [
    { name: 'systolic', value: 128, unit: 'mmHg' }, { name: 'diastolic', value: 82, unit: 'mmHg' }, { name: 'heartRate', value: 76, unit: 'bpm' }
  ], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '血压批次（含心率）入草稿')
  assert.deepStrictEqual(draftCalls[0].payload.metrics.map(m => [m.type, m.unit]), [['systolic', 'mmHg'], ['diastolic', 'mmHg'], ['heartRate', 'bpm']], '单位与 §10.1 契约一致')

  // ---- (c4) 尿酸 + 电量；确认请求带会话 ID ----
  await resetToNewPatient()
  page.batteryLevel = 88
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'uricAcid', value: 0.32, unit: 'mmol/L' }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1)
  const uaTypes = draftCalls[0].payload.metrics.map(m => m.type)
  assert.ok(uaTypes.includes('uricAcid'), '尿酸正常入草稿')
  assert.ok(uaTypes.includes('battery'), '电量作为设备状态随载荷审计发送（服务端不投影为患者临床指标，§10.3）')
  await page.confirmMeasurement()
  const confirmCall = draftCalls.find(c => c.fn === 'confirm')
  assert.ok(confirmCall, '确认动作已发出')
  assert.strictEqual(confirmCall.payload.measurementSessionId, serverSessionId, 'v2 确认携带服务端会话 ID')

  // ---- (c5) 延迟旧会话结果丢弃 ----
  await resetToNewPatient()
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', measurementSessionId: 'mfa-v2-sess-OLD', metric: { name: 'uricAcid', value: 0.9, unit: 'mmol/L' }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 0, '带旧 sessionId 的迟到结果被丢弃')
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'uricAcid', value: 0.9, unit: 'mmol/L' }, receivedAt: Date.now() - 120000 })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 0, '早于会话启动时间的迟到结果被丢弃')

  // ---- (c6) 解析层协议向量直测（真机实证：0x78 结果帧为变长帧 20/31 字节）----
  function f32be (value) {
    const view = new DataView(new ArrayBuffer(4))
    view.setFloat32(0, value, false)
    return Array.from(new Uint8Array(view.buffer))
  }
  // 变长帧构造：总长 total（血压/GLU=20、血脂=31），帧头 + 0 填充到 total-1 + CRC（求和 & 0xFF）
  function crcFrame (head, total) {
    const padded = head.slice(0, total - 1)
    while (padded.length < total - 1) padded.push(0)
    const sum = padded.reduce((acc, value) => (acc + value) & 0xff, 0)
    return Uint8Array.from(padded.concat([sum]))
  }
  const bpFrame = mfa1BleModule.parseMfa1Frame(crcFrame([0x78, 0x04, 0, 76, 82, 128], 20))
  assert.deepStrictEqual(bpFrame.metrics.map(mm => [mm.name, mm.value, mm.unit]), [['systolic', 128, 'mmHg'], ['diastolic', 82, 'mmHg'], ['heartRate', 76, 'bpm']], '血压帧 D2/D3/D4（字节 3/4/5）→ 契约三指标（协议依据：《MFA-1 BLE 蓝牙通讯协议》T1=4，真机抓包验证）')
  const gluEcho = mfa1BleModule.parseMfa1Frame(crcFrame([0x78, 0x01].concat(f32be(5.5)).concat([0x01]), 20))
  assert.strictEqual(gluEcho.metric.fastState, 1, '血糖 D5=1 空腹回显保留（context 映射的数据源）')
  // 血脂 31 字节单帧：D1..D17 完整落在字节 2..18，四指标一次拿全
  const lipidFull = crcFrame([0x78, 0x03].concat(f32be(5.2)).concat([0x01]).concat(f32be(1.3)).concat(f32be(1.8)).concat(f32be(3.1)), 31)
  assert.strictEqual(lipidFull.length, 31)
  const completeAssembler = new mfa1BleModule.FrameAssembler()
  const completeOut = completeAssembler.push(lipidFull).find(item => item.type === 'result')
  assert.ok(completeOut, '31 字节血脂单帧直出完整四指标')
  assert.deepStrictEqual(completeOut.metrics.map(mm => [mm.name, Math.round(mm.value * 100) / 100]), [['tc', 5.2], ['hdl', 1.3], ['tg', 1.8], ['ldl', 3.1]])
  assert.ok(completeOut.metrics.every(mm => !mm.partial), '完整血脂无 partial 标记')
  // 部分血脂：TG 4 字节全 0 视为缺失 → 当场透传前三项，全量标 partial=true → 页面据此产出「部分血脂结果」草稿
  const lipidPartialFrame = crcFrame([0x78, 0x03].concat(f32be(5.2)).concat([0x01]).concat(f32be(1.3)).concat([0, 0, 0, 0]).concat(f32be(3.1)), 31)
  const partialAssembler = new mfa1BleModule.FrameAssembler()
  const partialOut = partialAssembler.push(lipidPartialFrame).find(item => item.type === 'result')
  assert.ok(partialOut && partialOut.metrics.length === 3, 'TG 缺失时出前三项（单帧内缺失，无需超时降级）')
  assert.ok(partialOut.metrics.every(mm => mm.partial === true), '不完整批次全量标 partial=true → 页面据此产出「部分血脂结果」草稿')
  // 该降级批次经页面消费后必须按 partial 入草稿且给出中文提示
  await resetToNewPatient()
  page.batteryLevel = undefined
  draftCalls.length = 0
  await page.onMfa1Result({ command: 0x78, type: 'result', metric: partialOut.metrics[0], metrics: partialOut.metrics, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(draftCalls.length, 1, '部分血脂批次自动入草稿（阶段二不再整笔丢弃）')
  // 三项前缀缺 LDL → buildDraftMetrics 判定未凑齐四项，血脂项全部标 partial=true
  const lipidDraft = draftCalls[0].payload.metrics.filter(mm => M.LIPID_METRIC_NAMES.includes(mm.type))
  assert.strictEqual(lipidDraft.length, 3, '草稿含前三项血脂')
  assert.ok(lipidDraft.every(mm => mm.partial === true), '草稿序列化保留 partial=true')
  assert.ok(/部分血脂结果/.test(page.data.statusText + page.data.partialLipidText), '界面显示「部分血脂结果」（§10.1）')

  // ---- (c7) USE_V2=false 回退形态常量快照（配置层断言，页面按 USE_V2 选取）----
  assert.strictEqual(M.MEASUREMENT_ITEMS_V1.filter(i => i.key === 'lipid')[0].enabled, false, 'v1 配置：血脂置灰即将开放')
  assert.strictEqual(M.MEASUREMENT_ITEMS_V1.filter(i => i.key === 'bloodPressure')[0].note, '即将开放')
  assert.strictEqual(M.MEASUREMENT_ITEMS_V2.filter(i => i.key === 'lipid')[0].enabled, true, 'v2 配置：血脂开放')
  assert.strictEqual(M.MEASUREMENT_ITEMS_V2.filter(i => i.key === 'bloodPressure')[0].enabled, true, 'v2 配置：血压/心率开放')
  assert.deepStrictEqual(page.data.measurementItems, M.MEASUREMENT_ITEMS, '页面使用开关选中的项目配置')

  // ---- (c8) 患者端不可见指标细节由 DTO 白名单保证（阶段一回归在此复核 v2 未扩权）----
  const patientView = stationApi.normalizePatientQueue({ data: { stationId: '9', status: 'OPEN', queueNo: 2, metrics: [{ type: 'glucose', value: 5 }], measurementSessionId: 'leak-check' } })
  assert.ok(!('metrics' in patientView) && !('measurementSessionId' in patientView), '患者视图不含指标与会话 ID')

  console.log('mfa1 v2 contract tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
