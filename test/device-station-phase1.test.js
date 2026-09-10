/**
 * 阶段一止血测试（阶段二起按 v2 契约校准）：体脂秤多帧累积、切换患者清态、设备类型隔离、
 * MFA1 项目入口随 USE_V2 开关的形态。检测会话 ID 自阶段二由服务端 callNext 下发（v2），
 * 本文件用【灰度回退 v1 通道】验证客户端会话窗口与结构不变量；v2 会话契约见
 * test/device-station-phase2.test.js。
 * 风格对齐现有 *.test.js：require + assert + console.log，直接 node test/device-station-phase1.test.js 运行。
 */
const assert = require('assert')
const path = require('path')

const scalePagePath = path.resolve(__dirname, '../miniprogram/pages/device-scale/station/index.js')
const mfa1PagePath = path.resolve(__dirname, '../miniprogram/pages/device-mfa1/index.js')
const stationApiPath = path.resolve(__dirname, '../miniprogram/utils/station-api.js')
const scaleBlePath = path.resolve(__dirname, '../miniprogram/services/scale/scaleBle.js')
const mfa1BlePath = path.resolve(__dirname, '../miniprogram/services/mfa1/mfa1Ble.js')

const scaleBleModule = require(scaleBlePath)
const mfa1BleModule = require(mfa1BlePath)
const stationApiModule = require(stationApiPath)

// ---- 帧构造工具（纯字节拼装，独立于被测解析器）----

function scaleFrame (type, payload) {
  const body = [type & 0xff].concat(payload.map(value => Number(value) & 0xff))
  const result = new Uint8Array(body.length + 6)
  result[0] = 0xa9; result[1] = 0x00; result[2] = 0x26; result[3] = body.length
  result.set(body, 4)
  let sum = 0
  for (let i = 1; i < result.length - 2; i++) sum = (sum + result[i]) & 0xff
  result[result.length - 2] = sum
  result[result.length - 1] = 0x9a
  return result
}

// 0x10 稳定体重帧：payload=[0x02, wH, wM, wL, flags]（flags 高 4 位小数位、低 4 位单位 0=kg），
// 解析器要求整帧 ≥13 字节，故按协议补齐保留字节到 7 字节 payload。
function weightFrame (grams, decimals = 1) {
  return scaleFrame(0x10, [0x02, (grams >> 16) & 0xff, (grams >> 8) & 0xff, grams & 0xff, (decimals << 4) | 0x00, 0x00, 0x00])
}
// 0x15 分段帧（与 test/scale-ble.test.js 的 segment1 向量一致）
const SEGMENT1_BODY = [1, 0x00, 0xdc, 0x00, 0xb9, 0x00, 0x08, 0x01, 0x5e, 0x05, 0xaa, 0x2d, 0x00, 0x22]
// 0x15 segment2（解析器：u16@abs6 boneMass、@abs8 water、@abs10 protein、@abs12 bmi；abs14 heartRate、abs15 obesityLevel）
// boneMass 3.2kg / water 55.0% / protein 16.0% / bmi 24.0 / 心率未测(0xff) / obesity 9 → 本帧 5 个新类型
const SEGMENT2_BODY = [2,
  0x00, 0x20, // boneMass 32 -> 3.2kg   (abs 6..7)
  0x02, 0x26, // water 550 -> 55.0%     (abs 8..9)
  0x00, 0xa0, // protein 160 -> 16.0%   (abs 10..11)
  0x00, 0xf0, // bmi 240 -> 24.0        (abs 12..13)
  0xff,       // heartRate 未测          (abs 14)
  0x09,       // obesityLevel 9         (abs 15)
  0, 0]       // 保留字节：parseScaleFrame 要求整帧 ≥20 字节（payload 至少 12 项）
function completionFrame () { return scaleFrame(0x30, [0x00]) }

function f32be (value) {
  const view = new DataView(new ArrayBuffer(4))
  view.setFloat32(0, value, false)
  return Array.from(new Uint8Array(view.buffer))
}
function mfa1Frame (head) {
  const padded = head.slice(0, 15)
  while (padded.length < 15) padded.push(0)
  const crc = padded.reduce((sum, value) => (sum + value) & 0xff, 0)
  return Uint8Array.from(padded.concat([crc]))
}
// 变长结果帧（真机实证：0x78 结果帧为 20/31 字节，CRC=前面所有字节求和 & 0xFF）
function mfa1ResultFrame (head, total) {
  const padded = head.slice(0, total - 1)
  while (padded.length < total - 1) padded.push(0)
  const crc = padded.reduce((sum, value) => (sum + value) & 0xff, 0)
  return Uint8Array.from(padded.concat([crc]))
}

// ---- Page/wx/app 模拟：真实注册页面模块，拿到带完整方法的页实例 ----

global.getApp = () => ({ globalData: { accessToken: 't', refreshToken: 'r', activeRole: 'DOCTOR', cdmsBaseUrl: 'https://cdms.example.com' } })
global.wx = {
  showToast: () => undefined,
  showModal: () => undefined,
  setClipboardData: () => undefined,
  navigateBack: () => undefined,
  switchTab: () => undefined,
  reLaunch: () => undefined
}

function instantiatePage (pagePath) {
  let config = null
  global.Page = cfg => { config = cfg }
  delete require.cache[pagePath]
  require(pagePath)
  const page = Object.assign({}, config)
  page.data = JSON.parse(JSON.stringify(config.data))
  page.setData = function (patch, callback) {
    if (!patch) return
    Object.keys(patch).forEach(key => {
      if (key.indexOf('.') >= 0 || key.indexOf('[') >= 0) return // 本页未用路径式 setData
      this.data[key] = patch[key]
    })
    if (typeof callback === 'function') callback()
  }
  return page
}

const scalePage = instantiatePage(scalePagePath)
const T = globalThis.__cdmsScaleStationTestables
const mfa1Page = instantiatePage(mfa1PagePath)
const M = globalThis.__cdmsMfa1StationTestables
assert.ok(T && M, '页面测试钩子已导出')

// 桩掉场次 API：记录调用、按脚本返回归一化场次响应
const apiCalls = []
let nextCallResponse = null
// 本文件全程走 v1 回退通道（beginMeasurementSession 生成本地窗口标记，不进草稿载荷），
// 保留阶段一结构不变量断言；v2 服务端会话契约见 test/device-station-phase2.test.js。
stationApiModule.setStationApiVersion('v1')
stationApiModule.callNext = async (stationId, payload) => {
  apiCalls.push({ fn: 'callNext', stationId, payload })
  if (nextCallResponse instanceof Error) throw nextCallResponse
  return nextCallResponse
}
const originalSaveDraft = stationApiModule.saveMeasurementDraft
stationApiModule.saveMeasurementDraft = async (stationId, queueItemId, payload) => {
  apiCalls.push({ fn: 'saveMeasurementDraft', stationId, queueItemId, payload })
  return { id: String(stationId), status: 'OPEN', deviceType: 'SCALE', currentQueueItem: { id: String(queueItemId), status: 'RESULT_PENDING', draftStatus: 'RESULT_PENDING', patientSummary: { maskedName: '张*生' } }, currentDraft: { id: 'draft-1', status: 'RESULT_PENDING' } }
}
const originalConfirm = stationApiModule.confirmMeasurement
stationApiModule.confirmMeasurement = async (stationId, queueItemId, draftId, payload) => {
  apiCalls.push({ fn: 'confirmMeasurement', stationId, queueItemId, draftId, payload })
  return { id: String(stationId), status: 'OPEN', deviceType: 'SCALE', currentQueueItem: { id: String(queueItemId), status: 'COMPLETED', patientSummary: { maskedName: '张*生' } } }
}

function calledPatientStation (overrides) {
  return Object.assign({
    id: 'st-1',
    status: 'OPEN',
    deviceType: 'SCALE',
    checkinToken: 'tok',
    currentQueueItem: { id: 'q-1', status: 'CALLED', queueNo: 1, patientSummary: { maskedName: '李*兰', gender: 1, age: 66, height: 165 } }
  }, overrides || {})
}

async function flushPromises () {
  for (let i = 0; i < 8; i++) await Promise.resolve()
}

function pushFrames (page, frames) {
  const assembler = page.scale.assembler
  frames.forEach(frame => { assembler.push(frame).forEach(result => page.onScaleResult(result)) })
}

async function run () {
  // ================= a) 完整多帧流程 → 草稿包含全部累计指标 =================
  scalePage.scale = new scaleBleModule.ScaleBle({ onState: () => {}, onResult: r => scalePage.onScaleResult(r) })
  scalePage.metricAccumulator = {}
  scalePage.measurementCompleteReceived = false
  scalePage.measurementSessionId = ''
  scalePage.measurementSessionStartedAt = 0
  scalePage.draftSnapshot = null
  scalePage.stopMeasurementTimeout()
  scalePage.setData({ deviceTypeMismatch: false, stationId: 'st-1', connected: true, metrics: [], canConfirm: false, measuring: false, errorText: '', saving: false })
  scalePage.applyStation(calledPatientStation({}))
  scalePage.beginMeasurementSession('q-1')
  scalePage.setData({ measuring: true })
  const sessionId = scalePage.measurementSessionId
  const sessionKey = scalePage.measurementIdempotencyKey
  assert.ok(sessionId.startsWith('scale-session-local-q-1-'), 'v1 回退通道生成本地会话窗口标记（v2 必须用服务端 UUID，见 phase2 测试）')
  assert.ok(sessionKey.startsWith('station-draft-'), '本次测量动作生成幂等 key')

  // 实时帧（无 status）不得入袋体重
  pushFrames(scalePage, [scaleFrame(0x10, [0x01, 0x01, 0x00, 0x00, 0x00])])
  // 稳定体重帧 → 只更新累积器
  pushFrames(scalePage, [weightFrame(660)])
  // 两段身体指标帧 + 心率帧 → 只更新累积器
  pushFrames(scalePage, [scaleFrame(0x15, SEGMENT1_BODY), scaleFrame(0x15, SEGMENT2_BODY), scaleFrame(0x12, [72, 0, 0, 0])])
  await flushPromises()
  assert.strictEqual(Object.keys(scalePage.metricAccumulator).length, 13, '体重 + 12 项身体指标累计（segment1 六项 + segment2 五项新类型 + 独立心率帧，实时帧与完成帧均不贡献）')
  assert.strictEqual(scalePage.metricAccumulator.weight.value, 66, '稳定体重 66.0kg 入袋')
  assert.strictEqual(scalePage.metricAccumulator.bodyFat.value, 22)
  assert.strictEqual(scalePage.metricAccumulator.obesityLevel.value, 9)
  assert.strictEqual(scalePage.metricAccumulator.heartRate.value, 72, '0x12 独立心率帧入袋（segment2 心率槽位未测则不覆盖）')
  assert.strictEqual(scalePage.data.canConfirm, false, '未完成前不得可确认')
  assert.strictEqual(apiCalls.filter(call => call.fn === 'saveMeasurementDraft').length, 0, '完成帧之前绝不提交草稿')

  // 0x30 完成帧：只触发完成判断，不清空/覆盖任何已积累指标
  const accumulatedBefore = Object.assign({}, scalePage.metricAccumulator)
  let snapshotAtSave = null
  stationApiModule.saveMeasurementDraft = async (stationId, queueItemId, payload) => {
    snapshotAtSave = scalePage.draftSnapshot
    apiCalls.push({ fn: 'saveMeasurementDraft', stationId, queueItemId, payload })
    return { id: String(stationId), status: 'OPEN', deviceType: 'SCALE', currentQueueItem: { id: String(queueItemId), status: 'RESULT_PENDING', draftStatus: 'RESULT_PENDING', patientSummary: { maskedName: '张*生' } }, currentDraft: { id: 'draft-1', status: 'RESULT_PENDING' } }
  }
  pushFrames(scalePage, [completionFrame()])
  await flushPromises()
  assert.deepStrictEqual(Object.keys(scalePage.metricAccumulator).sort(), Object.keys(accumulatedBefore).sort(), '完成帧不清空任何已积累指标')
  assert.strictEqual(scalePage.metricAccumulator.weight.value, 66, '完成帧不覆盖体重')

  const drafts = apiCalls.filter(call => call.fn === 'saveMeasurementDraft')
  assert.strictEqual(drafts.length, 1, '完成后恰好提交一次草稿')
  const draftPayload = drafts[0].payload
  assert.ok(Array.isArray(draftPayload.metrics) && draftPayload.metrics.length === 13, '草稿恰含 13 项累计指标且非空（体重 + segment1 六项 + segment2 五项新类型 + 心率）')
  const typeNames = draftPayload.metrics.map(item => item.type)
  ;['weight', 'bodyFat', 'bmi', 'boneMass', 'water', 'protein', 'heartRate', 'muscleRate', 'visceralFat', 'subcutaneousFat', 'basalMetabolism', 'bodyAge', 'obesityLevel'].slice(0, 13).forEach(name => {
    assert.ok(typeNames.includes(name), '草稿必须含 ' + name)
  })
  assert.strictEqual(draftPayload.idempotencyKey, sessionKey, '草稿沿用本次测量动作开始时生成的 idempotencyKey')
  // v1 回退：本地窗口标记绝不冒充会话 ID 上送；api 层再把空值剥离，请求体不含该键。
  assert.ok(!draftPayload.measurementSessionId, 'v1 草稿载荷不得携带任何检测会话标识')
  assert.ok(snapshotAtSave && snapshotAtSave === scalePage.data.metrics, '页面展示即提交时刻的冻结草稿快照')
  assert.ok(Object.isFrozen(snapshotAtSave) && Object.isFrozen(snapshotAtSave[0]), '草稿快照不可变（冻结）')
  assert.strictEqual(scalePage.data.canConfirm, true, '草稿保存成功后医生可确认')
  assert.strictEqual(scalePage.measurementIdempotencyKey, '', '明确成功后幂等 key 被消费')

  // 确认动作走 v1 通道并携带幂等 key
  apiCalls.length = 0
  await scalePage.confirmMeasurement()
  const confirms = apiCalls.filter(call => call.fn === 'confirmMeasurement')
  assert.strictEqual(confirms.length, 1)
  assert.ok(String(confirms[0].payload.idempotencyKey).startsWith('station-confirm-'), '确认请求携带幂等 key（v1 writePayload 通道）')

  // 最低完整性反例 1：只有零散指标帧、没收到 0x30 → 禁止提交草稿
  apiCalls.length = 0
  scalePage.applyStation(calledPatientStation({ currentQueueItem: { id: 'q-2', status: 'CALLED', patientSummary: { maskedName: '王*福', gender: 0, age: 70, height: 160 } } }))
  scalePage.beginMeasurementSession('q-2')
  scalePage.setData({ measuring: true })
  pushFrames(scalePage, [scaleFrame(0x12, [70, 0, 0, 0]), scaleFrame(0x15, SEGMENT1_BODY)])
  await flushPromises()
  assert.strictEqual(apiCalls.filter(call => call.fn === 'saveMeasurementDraft').length, 0, '未完成不得提交草稿')
  assert.strictEqual(scalePage.data.canConfirm, false)
  assert.ok(/等待体脂秤稳定完成信号/.test(scalePage.data.statusText), '未完成数据仅作本地提示')

  // 最低完整性反例 2：收到 0x30 但从未有有效体重 → 禁止提交草稿
  scalePage.applyStation(calledPatientStation({ currentQueueItem: { id: 'q-3', status: 'CALLED', patientSummary: { maskedName: '赵* ', gender: 1, age: 55, height: 175 } } }))
  scalePage.beginMeasurementSession('q-3')
  scalePage.setData({ measuring: true })
  pushFrames(scalePage, [scaleFrame(0x15, SEGMENT1_BODY), completionFrame()])
  await flushPromises()
  assert.strictEqual(apiCalls.filter(call => call.fn === 'saveMeasurementDraft').length, 0, '缺有效体重不得提交草稿')
  assert.ok(/缺少有效体重|未完成/.test(scalePage.data.statusText), '缺体重时仅本地提示')

  // ================= b) 切换患者清空累积器与解析缓冲 =================
  // q-3 会话里塞入半帧残留 + 脏指标
  const dirtyAssembler = scalePage.scale.assembler
  dirtyAssembler.push(scaleFrame(0x15, SEGMENT2_BODY).slice(0, 9))
  assert.ok(dirtyAssembler.buffer.length > 0, '解析缓冲存在半帧残留')
  assert.ok(Object.keys(scalePage.metricAccumulator).length > 0, '累积器非空')
  const oldSessionId = scalePage.measurementSessionId
  const oldKey = scalePage.measurementIdempotencyKey
  scalePage.setData({ measuring: true }) // 上一位仍处于测量中 → 触发 callNext 在途保护闸门

  // 被“测量中先拒”闸门挡住时不得产生任何请求、也不得破坏现有会话数据
  const beforeGateKeys = Object.keys(scalePage.metricAccumulator).length
  apiCalls.length = 0
  await scalePage.callNext()
  assert.strictEqual(apiCalls.length, 0, '活动患者未结束时拒绝再次叫号（无网络副作用）')
  assert.strictEqual(Object.keys(scalePage.metricAccumulator).length, beforeGateKeys, '闸门拒绝不破坏现有累积器')
  // 跳过当前患者 → 再叫下一位：完整清态链
  stationApiModule.skipQueueItem = async (stationId, queueItemId, payload) => {
    apiCalls.push({ fn: 'skipQueueItem', stationId, queueItemId, payload })
    return { id: String(stationId), status: 'OPEN', deviceType: 'SCALE', currentQueueItem: null, queue: [] }
  }
  await scalePage.skipCurrent()
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '跳过即清空累积器')
  assert.strictEqual(scalePage.measurementSessionId, '', '跳过后旧会话失效')
  nextCallResponse = calledPatientStation({ currentQueueItem: { id: 'q-4', status: 'CALLED', patientSummary: { maskedName: '孙*芝', gender: 0, age: 61, height: 158 } } })
  await scalePage.callNext()
  nextCallResponse = null
  assert.ok(apiCalls.some(call => call.fn === 'callNext'), '换人叫号成功发起')
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '切换患者后 metricAccumulator 清空')
  assert.strictEqual(scalePage.measurementCompleteReceived, false, '完成标记复位')
  assert.notStrictEqual(scalePage.measurementSessionId, oldSessionId, '旧会话失效、新会话启用')
  assert.notStrictEqual(scalePage.measurementIdempotencyKey, oldKey, '新测量动作用新幂等 key')
  assert.notStrictEqual(scalePage.scale.assembler, dirtyAssembler, 'FrameAssembler 已重建')
  assert.strictEqual(scalePage.scale.assembler.buffer.length, 0, 'BLE 帧缓冲清空')
  // 上一位患者的延迟帧不得污染新草稿——三层防护逐一验证：
  apiCalls.length = 0
  // (1) 解析缓冲已重建：旧 buffer 残留半帧随 reset 丢弃，不再吐帧给 onScaleResult
  assert.strictEqual(scalePage.scale.assembler.buffer.length, 0, '切换后新 assembler 无残留半帧')
  // (2) receivedAt 早于新会话启动时间的延迟帧（旧患者上一连接周期的数据）被丢弃
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: 50, unit: 'kg' }], receivedAt: Date.now() - 60000 })
  assert.strictEqual(scalePage.metricAccumulator.weight, undefined, '启动时间早于本次检测的数据被丢弃')
  // (3) 会话彻底失效（skip/abort 之后）时的任何迟到帧都被忽略
  scalePage.skipMeasurementSessionForProbe && null
  const activeSession = scalePage.measurementSessionId
  scalePage.abortMeasurementSession()
  await scalePage.onScaleResult({ type: 0x15, segment: 2, metrics: [{ name: 'boneMass', value: 99.9, unit: 'kg' }] })
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '会话失效后的迟到分段帧不进累积器')
  scalePage.beginMeasurementSession('q-4')
  assert.notStrictEqual(scalePage.measurementSessionId, activeSession, '重新建立会话得到新 ID')
  await flushPromises()
  assert.strictEqual(apiCalls.filter(call => call.fn === 'saveMeasurementDraft').length, 0, '迟到帧不触发草稿')

  // ================= c) SCALE 页面拒绝 MFA1 场次 =================
  assert.strictEqual(T.isStationDeviceTypeAllowed('SCALE', 'SCALE'), true)
  assert.strictEqual(T.isStationDeviceTypeAllowed('SCALE', 'MFA1'), false)
  assert.strictEqual(T.isStationDeviceTypeAllowed('SCALE', 'mfa1'), false, '大小写归一仍拒绝')
  assert.strictEqual(T.isStationDeviceTypeAllowed('MFA1', 'SCALE'), false)
  assert.strictEqual(T.isStationDeviceTypeAllowed('MFA1', 'MFA1'), true)
  // 空值兜底：normalizeStation 总会回填 deviceType（缺省 SCALE），空值仅作宽容处理，两页同一约定
  assert.strictEqual(T.isStationDeviceTypeAllowed('SCALE', ''), true, '空 deviceType 视为页面自身类型')
  assert.strictEqual(M.isStationDeviceTypeAllowed('MFA1', ''), true, '空 deviceType 视为页面自身类型')
  assert.strictEqual(M.isStationDeviceTypeAllowed('MFA1', undefined), true)

  scalePage.stopMeasurementTimeout()
  scalePage.applyStation(calledPatientStation({ deviceType: 'MFA1' }))
  assert.strictEqual(scalePage.data.deviceTypeMismatch, true, 'SCALE 页对 MFA1 场次置不匹配标记')
  assert.ok(/请扫描正确的设备二维码/.test(scalePage.data.errorText), '提示“请扫描正确的设备二维码”')
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '不匹配时立即清空累积器')
  assert.strictEqual(scalePage.measurementSessionId, '', '不匹配时会话失效')
  apiCalls.length = 0
  await scalePage.scanDevice()
  await scalePage.connectDevice()
  await scalePage.callNext()
  await scalePage.closeStation()
  await scalePage.retry()
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: 66, unit: 'kg' }] })
  await flushPromises()
  assert.deepStrictEqual(apiCalls, [], '不匹配期间不得发起任何场次/BLE/提交操作')
  // 恢复正确场次
  scalePage.applyStation(calledPatientStation({ deviceType: 'SCALE' }))
  assert.strictEqual(scalePage.data.deviceTypeMismatch, false, '回到 SCALE 场次后恢复正常')

  // ================= d) MFA1 项目形态随 USE_V2 开关（阶段二恢复全量入口） =================
  const lipidItem = M.MEASUREMENT_ITEMS.filter(item => item.key === 'lipid')[0]
  const bpItem = M.MEASUREMENT_ITEMS.filter(item => item.key === 'bloodPressure')[0]
  const glucoseItem = M.MEASUREMENT_ITEMS.filter(item => item.key === 'glucose')[0]
  const uaItem = M.MEASUREMENT_ITEMS.filter(item => item.key === 'uricAcid')[0]
  assert.ok(lipidItem && bpItem && glucoseItem && uaItem, '四个项目均在配置中')
  if (M.USE_V2) {
    // v2 常态：血脂/血压/心率入口全部恢复，无「即将开放」置灰
    assert.strictEqual(lipidItem.enabled, true, 'v2 血脂入口开放')
    assert.strictEqual(bpItem.enabled, true, 'v2 血压入口开放')
    assert.ok(!/即将开放/.test(lipidItem.note + bpItem.note), 'v2 不再有“即将开放”文案')
    ;['tc', 'hdl', 'tg', 'ldl', 'systolic', 'diastolic', 'heartRate'].forEach(name => assert.strictEqual(M.measurementItemAllowedUnderFreeze(name), true, name + ' v2 允许入草稿'))
  } else {
    assert.strictEqual(lipidItem.enabled, false, '回退态血脂入口收口')
    assert.strictEqual(bpItem.enabled, false, '回退态血压入口收口')
    assert.strictEqual(lipidItem.note, '即将开放')
    assert.strictEqual(bpItem.note, '即将开放')
    ;['tc', 'hdl', 'tg', 'ldl', 'systolic', 'diastolic'].forEach(name => assert.strictEqual(M.measurementItemAllowedUnderFreeze(name), false, name + ' 禁止进入草稿'))
  }
  assert.strictEqual(glucoseItem.enabled, true, '血糖保留')
  assert.strictEqual(uaItem.enabled, true, '尿酸保留')
  assert.deepStrictEqual(mfa1Page.data.measurementItems, M.MEASUREMENT_ITEMS, '页面 data 暴露当前开关下的项目配置')
  assert.strictEqual(mfa1Page.data.deviceTypeMismatch, false)
  ;['glucose', 'uricAcid', 'battery'].forEach(name => assert.strictEqual(M.measurementItemAllowedUnderFreeze(name), true, name + ' 允许'))

  // 端到端：血糖结果照常到达页面；血脂批次按开关消费（v2 自动草稿门禁见 phase2/v2-contract 测试）
  mfa1Page.mfa1 = new mfa1BleModule.Mfa1Ble({ onState: () => {}, onResult: r => mfa1Page.onMfa1Result(r) })
  mfa1Page.setData({ deviceTypeMismatch: false, stationId: 'st-2', currentQueueItem: { id: 'q-9', status: 'CALLED', patientSummary: { maskedName: '周*' } }, currentDraft: null, metrics: [], canConfirm: false, measuring: true, saving: false, errorText: '' })
  mfa1Page.beginMeasurementSession('q-9')
  apiCalls.length = 0
  const gluSaved = []
  stationApiModule.saveMeasurementDraft = async (stationId, queueItemId, payload) => {
    gluSaved.push(payload)
    return stationApiModule.normalizeStation({ data: { id: String(stationId), status: 'OPEN', deviceType: 'MFA1', currentDraft: { id: 'd-9', status: 'RESULT_PENDING' }, currentQueueItem: { id: String(queueItemId), status: 'RESULT_PENDING', draftStatus: 'RESULT_PENDING', patientSummary: { maskedName: '周*' } } } })
  }
  await mfa1Page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'glucose', value: 5.5, unit: 'mmol/L', state: '空腹', fastState: 1 } })
  await flushPromises()
  if (M.USE_V2) {
    // v2：设备回显 D5=1 → context FASTING，自动提交草稿且载荷带 context
    assert.strictEqual(gluSaved.length, 1, 'v2 设备语境明确的血糖结果自动保存草稿')
    assert.deepStrictEqual(gluSaved[0].metrics.map(item => item.type), ['glucose'])
    assert.strictEqual(gluSaved[0].metrics[0].context, 'FASTING', '设备回显映射 FASTING')
    gluSaved.length = 0
    const lipidResult = { command: 0x78, type: 'result', complete: true, metric: { name: 'tc', value: 5.2, unit: 'mmol/L' }, metrics: [
      { name: 'tc', value: 5.2, unit: 'mmol/L' }, { name: 'hdl', value: 1.3, unit: 'mmol/L' }, { name: 'tg', value: 1.8, unit: 'mmol/L' }, { name: 'ldl', value: 3.1, unit: 'mmol/L' }
    ] }
    await mfa1Page.onMfa1Result(lipidResult)
    await flushPromises()
    assert.strictEqual(gluSaved.length, 1, 'v2 完整血脂批次正常入草稿')
    assert.deepStrictEqual(gluSaved[0].metrics.map(item => item.type).sort(), ['tc', 'hdl', 'tg', 'ldl'].slice().sort())
    assert.ok(gluSaved[0].metrics.every(item => !item.partial), '完整血脂不标 partial')
  } else {
    assert.strictEqual(gluSaved.length, 1, '血糖结果正常保存草稿')
    assert.deepStrictEqual(gluSaved[0].metrics.map(item => item.type), ['glucose'])
    gluSaved.length = 0
    const lipidResult = { command: 0x78, type: 'result', complete: true, metric: { name: 'tc', value: 5.2, unit: 'mmol/L' }, metrics: [
      { name: 'tc', value: 5.2, unit: 'mmol/L' }, { name: 'hdl', value: 1.3, unit: 'mmol/L' }, { name: 'tg', value: 1.8, unit: 'mmol/L' }, { name: 'ldl', value: 3.1, unit: 'mmol/L' }
    ] }
    await mfa1Page.onMfa1Result(lipidResult)
    await flushPromises()
    assert.strictEqual(gluSaved.length, 0, '回退态血脂结果被收口丢弃，绝不入草稿')
    assert.strictEqual(mfa1Page.data.canConfirm, false, '血脂丢弃后无可确认草稿')
    assert.ok(/即将开放/.test(mfa1Page.data.errorText), 'UI 明确提示血脂/血压即将开放')
  }
  stationApiModule.saveMeasurementDraft = originalSaveDraft
  stationApiModule.confirmMeasurement = originalConfirm

  // MFA1 页拒绝 SCALE 场次 + 切换患者清空 BLE 解析缓冲
  mfa1Page.setData({ deviceTypeMismatch: false })
  mfa1Page.applyStation({ id: 'st-3', status: 'OPEN', deviceType: 'SCALE', queue: [] })
  assert.strictEqual(mfa1Page.data.deviceTypeMismatch, true, 'MFA1 页拒绝 SCALE 场次')
  assert.ok(/请扫描正确的设备二维码/.test(mfa1Page.data.errorText))
  mfa1Page.applyStation({ id: 'st-2', status: 'OPEN', deviceType: 'MFA1', queue: [] })
  assert.strictEqual(mfa1Page.data.deviceTypeMismatch, false)
  // applyStation 之后重新建会话（其 metrics:null 分支会覆盖结果，顺序敏感）
  const sessionReadyForParse = mfa1Page.beginMeasurementSession('q-10')
  if (!sessionReadyForParse) mfa1Page.adoptMeasurementSession('sess-parse-probe', 'q-10')
  assert.ok(mfa1Page.measurementSessionId, '解析层验证需活动检测会话（v1 本地标记或 v2 服务端 ID 探针）')
  // 制造分包残留 + 完整血脂结果：走 Mfa1Ble.onResult 回调链（与真机监听器分发一致；
  // 直接调 assembler.push 只喂解析器、不触发页面消费，不能验证「到达页面」）
  // 重新绑定实例：上方 connectDevice 失败会走 scheduleReconnect → connectInternal 重建 assembler，
  // 旧句柄已脱离 this.mfa1.assembler；断言前必须取当前活动解析器（真机同理：监听器始终读活实例）。
  const dispatch = bytes => { mfa1Page.mfa1.assembler.push(bytes).forEach(item => mfa1Page.onMfa1Result(Object.assign({}, item, { receivedAt: Date.now() }))) }
  // 血脂 31 字节单帧（D1..D17 全量）：TC=5.2、D5=1、HDL=1.3、TG=1.8、LDL=3.1
  const lipidFrame = mfa1ResultFrame([0x78, 0x03].concat(f32be(5.2)).concat([0x01]).concat(f32be(1.3)).concat(f32be(1.8)).concat(f32be(3.1)), 31)
  // 分包残留：先喂前 10 字节（应滞留 buffer），再补齐后 21 字节成帧
  dispatch(lipidFrame.slice(0, 10))
  await flushPromises()
  assert.ok(mfa1Page.mfa1.assembler.buffer.length > 0, '半帧滞留 buffer 由解析层持有（收口不破坏解析）')
  dispatch(lipidFrame.slice(10))
  await flushPromises()
  // 31 字节凑满 → 单帧直出完整血脂：v2 出草稿指标，v1 回退整笔拒绝并提示
  const lipidMetricsOnPage = mfa1Page.data.metrics || []
  const lipidAccepted = lipidMetricsOnPage.length === 4 || /部分血脂|血脂/.test(mfa1Page.data.statusText + (mfa1Page.data.errorText || ''))
  assert.ok(lipidAccepted, '完整血脂结果已到达页面（草稿 4 项或给出血脂提示）')
  mfa1Page.resetMeasurementState()
  assert.strictEqual(mfa1Page.mfa1.assembler.buffer.length, 0, '切换患者后 MFA1 解析缓冲清空')
  assert.strictEqual(mfa1Page.measurementSessionId, '', '会话失效')

  // ---- 纯函数直测：累积器与完整性判定 ----
  const acc = {}
  T.accumulateScaleMetric(acc, { type: 0x10, status: 'realtime', metrics: [{ name: 'weight', value: 12.3, unit: 'kg' }] })
  assert.deepStrictEqual(acc, {}, '实时不稳定体重不入袋')
  T.accumulateScaleMetric(acc, { type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: 71.5, unit: 'kg' }] })
  T.accumulateScaleMetric(acc, { type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: NaN, unit: 'kg' }] })
  assert.strictEqual(acc.weight.value, 71.5, 'NaN 体重被拒绝，保留上一个有效稳定值')
  T.accumulateScaleMetric(acc, { type: 0x30, complete: true, metrics: [] })
  assert.strictEqual(acc.weight.value, 71.5, '完成帧不覆盖任何指标')
  assert.deepStrictEqual(T.evaluateDraftReadiness(acc, false), { ready: false, reason: '未完成测量：等待体脂秤稳定完成信号' })
  assert.strictEqual(T.evaluateDraftReadiness(acc, true).ready, true)
  const snap = T.snapshotScaleMetrics(acc)
  assert.deepStrictEqual(snap.map(item => item.name), ['weight'])
  const frozenSnap = T.snapshotScaleMetrics(Object.assign({}, acc, { bodyFat: { name: 'bodyFat', value: 20, unit: '%' } }))
  assert.ok(Object.isFrozen(frozenSnap[0]), '快照元素冻结')
  assert.throws(() => { 'use strict'; frozenSnap[0].value = 0 }, TypeError, '冻结快照不可被后续帧改写')

  console.log('device station phase1 tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
