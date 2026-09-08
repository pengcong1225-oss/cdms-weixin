/**
 * 阶段二契约测试：小程序侧检测会话（设计 §8）与 v2 API 通道（§15）、410/409 错误语义（§17）。
 * 覆盖交付项 a/b/d/e；MFA1 全指标 payload 见 test/mfa1-v2-contract.test.js。
 * 风格对齐现有 *.test.js：require + assert，直接 node test/device-station-phase2.test.js 运行。
 */
const assert = require('assert')
const path = require('path')

const api = require('../miniprogram/utils/api')
const stationApi = require('../miniprogram/utils/station-api')
const scalePagePath = path.resolve(__dirname, '../miniprogram/pages/device-scale/station/index.js')
const mfa1PagePath = path.resolve(__dirname, '../miniprogram/pages/device-mfa1/index.js')
const scaleBleModule = require('../miniprogram/services/scale/scaleBle.js')
const mfa1BleModule = require('../miniprogram/services/mfa1/mfa1Ble.js')

// ---- Page/wx/app 模拟（沿用阶段一 mock Page 驱动模式）----
global.getApp = () => ({ globalData: { accessToken: 't', refreshToken: 'r', activeRole: 'DOCTOR', cdmsBaseUrl: 'https://cdms.example.com' } })
let toastCount = 0
global.wx = {
  showToast: () => { toastCount++ },
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
      if (key.indexOf('.') >= 0 || key.indexOf('[') >= 0) return
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
assert.ok(T && M, '两页测试钩子已导出')
assert.strictEqual(stationApi.getStationApiVersion(), 'v2', '默认通道必须是 v2（页面切到 v2，设计 §15）')
assert.strictEqual(stationApi.stationPathPrefix(), '/api/v2/miniapp/device-stations')

async function flushPromises () { for (let i = 0; i < 8; i++) await Promise.resolve() }

function stationWithSession (sessionId, overrides) {
  return Object.assign({
    id: 'st-p2', status: 'OPEN', deviceType: 'SCALE', checkinToken: 'tok',
    measurementSessionId: sessionId,
    currentQueueItem: { id: 'q-1', status: 'CALLED', queueNo: 1, patientSummary: { maskedName: '李*兰', gender: 1, age: 66, height: 165 } }
  }, overrides || {})
}

function httpError (status, responseData) {
  const error = new Error('HTTP ' + status)
  error.statusCode = status
  error.response = responseData
  return error
}

const run = async () => {
  // ================= 1) v2 请求路径与载荷（桩传输层直测 station-api）=================
  const calls = []
  const originalCdmsRequest = api.cdmsRequest
  api.cdmsRequest = async (reqPath, method, body) => {
    calls.push({ path: reqPath, method, body })
    return { data: { id: '197', status: 'OPEN', deviceType: 'SCALE', measurementSessionId: 'srv-session-uuid-1' } }
  }
  try {
    const next = await stationApi.callNext('197')
    assert.strictEqual(calls[0].path, '/api/v2/miniapp/device-stations/197/call-next', 'call-next 走 v2 前缀')
    assert.strictEqual(next.measurementSessionId, 'srv-session-uuid-1', 'normalizeStation 透出服务端会话 ID')

    await stationApi.saveMeasurementDraft('197', '551', {
      measurementSessionId: 'srv-session-uuid-1', deviceId: 'd1', measuredAt: '2026-09-08T10:00:00',
      metrics: [{ name: 'glucose', value: 5.5, unit: 'mmol/L', context: 'FASTING' }, { name: 'tc', value: 5.2, unit: 'mmol/L', partial: true }]
    })
    assert.strictEqual(calls[1].path, '/api/v2/miniapp/device-stations/197/queue/551/draft')
    assert.strictEqual(calls[1].body.measurementSessionId, 'srv-session-uuid-1', 'v2 草稿必带服务端会话 ID')
    assert.deepStrictEqual(calls[1].body.metrics[0], { type: 'glucose', value: 5.5, unit: 'mmol/L', context: 'FASTING' }, '血糖 context 序列化')
    assert.deepStrictEqual(calls[1].body.metrics[1], { type: 'tc', value: 5.2, unit: 'mmol/L', partial: true }, '血脂 partial 序列化')

    await stationApi.confirmMeasurement('197', '551', '900', { measurementSessionId: 'srv-session-uuid-1' })
    assert.strictEqual(calls[2].path, '/api/v2/miniapp/device-stations/197/queue/551/drafts/900/confirm')
    assert.strictEqual(calls[2].body.measurementSessionId, 'srv-session-uuid-1', 'v2 确认必带服务端会话 ID')

    // 缺会话 ID 的确认在客户端即拒绝发起（不产生网络副作用）
    await assert.rejects(() => stationApi.confirmMeasurement('197', '551', '900', {}), /缺少检测会话标识/, 'v2 确认缺会话 ID → 本地拒绝')
    assert.strictEqual(calls.length, 3, '被拒绝的确认不得发出请求')

    // 非 glucose 类型不下发 context；未知 context 归一 UNKNOWN
    await stationApi.saveMeasurementDraft('197', '551', {
      measurementSessionId: 's2', metrics: [{ name: 'weight', value: 66, unit: 'kg', context: 'POSTPRANDIAL' }, { name: 'glucose', value: 6, unit: 'mmol/L', context: 'morning' }]
    })
    assert.strictEqual(calls[3].body.metrics[0].context, undefined, '非血糖指标不带 context')
    assert.strictEqual(calls[3].body.metrics[1].context, 'UNKNOWN', '非法血糖 context 归一为 UNKNOWN')

    // 灰度回退：切到 v1 后路径回到 scale/stations，且草稿剥离会话字段与 context/partial
    stationApi.setStationApiVersion('v1')
    await stationApi.callNext('197')
    assert.strictEqual(calls[4].path, '/api/v1/miniapp/scale/stations/197/call-next', 'v1 回退保留原路径')
    await stationApi.saveMeasurementDraft('197', '551', { measurementSessionId: 'x', metrics: [{ name: 'glucose', value: 5, unit: 'mmol/L', context: 'FASTING' }] })
    assert.ok(!('measurementSessionId' in calls[5].body), 'v1 草稿载荷不含会话 ID')
    assert.strictEqual(calls[5].body.metrics[0].context, undefined, 'v1 指标 DTO 不携带 context（后端不接受新契约）')
    await stationApi.confirmMeasurement('197', '551', '900', {})
    assert.strictEqual(calls[6].method, 'POST', 'v1 确认不因缺会话 ID 被拒（回退兼容）')
  } finally {
    api.cdmsRequest = originalCdmsRequest
    stationApi.setStationApiVersion('v2')
  }

  // ================= 2) 410/409 错误规范化（§17）=================
  const err410 = stationApi.normalizeStationError(httpError(410, { code: 410, message: 'session expired', status: 'OPEN', stationId: '197', currentQueueItemId: '', queue: [] }))
  assert.strictEqual(err410.expiredSession, true, '410 标记 expiredSession')
  assert.strictEqual(err410.stateConflict, undefined)
  assert.ok(err410.stationState && err410.stationState.id === '197', '410 携带服务端回传状态（刷新恢复用）')
  const err409 = stationApi.normalizeStationError(httpError(409, { data: { status: 'OPEN', currentQueueItem: { id: '551', status: 'RESULT_PENDING' } } }))
  assert.strictEqual(err409.stateConflict, true, '409 标记 stateConflict')
  assert.ok(err409.stationState.currentQueueItem.id === '551', '409 平铺/data 两形态都能取到回传状态')
  const err400 = stationApi.normalizeStationError(httpError(400, { message: 'bad metric' }))
  assert.strictEqual(err400.expiredSession, undefined, '非 409/410 不加标记')

  // ================= 3) 体脂秤页：callNext 保存服务端 sessionId → 草稿/确认携带它 =================
  const pageCalls = []
  let callNextScript = null
  let draftError = null
  const savedDrafts = []
  const savedConfirms = []
  stationApi.callNext = async (stationId, payload) => {
    pageCalls.push({ fn: 'callNext', stationId, payload })
    if (callNextScript instanceof Error) throw stationApi.normalizeStationError(callNextScript)
    return stationApi.normalizeStation(callNextScript || stationWithSession('srv-sess-A'))
  }
  stationApi.saveMeasurementDraft = async (stationId, queueItemId, payload) => {
    pageCalls.push({ fn: 'saveMeasurementDraft' })
    savedDrafts.push(payload)
    if (draftError) throw stationApi.normalizeStationError(draftError)
    return stationApi.normalizeStation({ id: stationId, status: 'OPEN', deviceType: 'SCALE', currentQueueItem: { id: queueItemId, status: 'RESULT_PENDING', draftStatus: 'RESULT_PENDING' }, currentDraft: { id: 'draft-A', status: 'RESULT_PENDING' } })
  }
  stationApi.confirmMeasurement = async (stationId, queueItemId, draftId, payload) => {
    pageCalls.push({ fn: 'confirmMeasurement' })
    savedConfirms.push(payload)
    return stationApi.normalizeStation({ id: stationId, status: 'OPEN', deviceType: 'SCALE', currentQueueItem: { id: queueItemId, status: 'COMPLETED' } })
  }
  stationApi.skipQueueItem = async () => { pageCalls.push({ fn: 'skipQueueItem' }); return stationApi.normalizeStation({ id: 'st-p2', status: 'OPEN', deviceType: 'SCALE', queue: [], currentQueueItem: null }) }

  scalePage.scale = new scaleBleModule.ScaleBle({ onState: () => {}, onResult: r => scalePage.onScaleResult(r) })
  // 模拟真机已连接：桩掉参数下发（无 wx BLE 环境时它会抛「体脂秤未连接」，与本页会话逻辑无关）
  scalePage.scale.configurePatient = async () => { scalePage.configurePatientCalls = (scalePage.configurePatientCalls || 0) + 1 }
  scalePage.setData({ deviceTypeMismatch: false, stationId: 'st-p2', connected: true, metrics: [], canConfirm: false, measuring: false, errorText: '', saving: false, currentQueueItem: null, currentDraft: null })
  scalePage.abortMeasurementSession()
  await scalePage.callNext()
  assert.strictEqual(scalePage.measurementSessionId, 'srv-sess-A', 'callNext 成功后保存服务端下发的会话 ID（替换占位）')
  assert.strictEqual(scalePage.measurementSessionQueueItemId, 'q-1', '会话绑定活动队列项')
  assert.strictEqual(scalePage.data.measuring, true, '有效会话建立后进入测量态')

  // 完成一次合法多帧 → 草稿载荷必须携带服务端 sessionId
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: 66, unit: 'kg' }], receivedAt: Date.now() })
  await scalePage.onScaleResult({ type: 0x30, complete: true, metrics: [], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(savedDrafts.length, 1, '完成后提交一次草稿')
  assert.strictEqual(savedDrafts[0].measurementSessionId, 'srv-sess-A', 'v2 草稿请求体携带服务端会话 ID')
  await scalePage.confirmMeasurement()
  assert.strictEqual(savedConfirms.length, 1)
  assert.strictEqual(savedConfirms[0].measurementSessionId, 'srv-sess-A', 'v2 确认请求体携带服务端会话 ID')
  assert.strictEqual(scalePage.measurementSessionId, '', '确认后本会话闭环清空')

  // ================= 4) 旧 sessionId 的迟到结果被丢弃（会话键层防护）=================
  callNextScript = stationWithSession('srv-sess-B', { currentQueueItem: { id: 'q-2', status: 'CALLED', patientSummary: { maskedName: '王*福', gender: 0, age: 70, height: 160 } } })
  await scalePage.callNext()
  assert.strictEqual(scalePage.measurementSessionId, 'srv-sess-B', '第二次叫号装载新服务端会话')
  savedDrafts.length = 0
  // 迟到的旧患者完整结果：receivedAt 落在新窗口内，但带旧 sessionId → 仍必须丢弃
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', complete: true, measurementSessionId: 'srv-sess-A', metrics: [{ name: 'weight', value: 55, unit: 'kg' }], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(savedDrafts.length, 0, '旧 sessionId 迟到结果绝不提交到新患者草稿')
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '旧会话标记帧不进累积器')
  // 同帧去掉 session 标记但 receivedAt 早于会话启动 → 时间窗层丢弃
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: 55, unit: 'kg' }], receivedAt: Date.now() - 60000 })
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '早于会话启动时间的数据被丢弃')
  // 当前会话标记的正常帧照常入袋
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', measurementSessionId: 'srv-sess-B', metrics: [{ name: 'weight', value: 60, unit: 'kg' }], receivedAt: Date.now() })
  assert.strictEqual(scalePage.metricAccumulator.weight.value, 60, '属于当前会话的数据正常接收')

  // ================= 5) 410 处理：提示 + 清态 + 不自动重放 =================
  draftError = httpError(410, { code: 410, message: 'measurement session expired', status: 'OPEN', stationId: 'st-p2' })
  const callsBefore410 = pageCalls.length
  // 走完整链路：稳定体重 + 完成帧 → 自动提交草稿 → 服务端回 410
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', measurementSessionId: 'srv-sess-B', metrics: [{ name: 'weight', value: 60, unit: 'kg' }], receivedAt: Date.now() })
  await scalePage.onScaleResult({ type: 0x30, complete: true, measurementSessionId: 'srv-sess-B', metrics: [], receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(scalePage.data.errorText, T.SESSION_EXPIRED_TEXT, '410 → 固定文案：本次检测会话已过期，请重新叫号')
  assert.strictEqual(scalePage.data.statusText, T.SESSION_EXPIRED_TEXT, '状态行同步提示')
  assert.strictEqual(scalePage.measurementSessionId, '', '410 后本地会话态清空')
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '410 后累积器清空')
  assert.strictEqual(scalePage.measurementIdempotencyKey, '', '410 后幂等 key 清空（旧动作终结）')
  assert.strictEqual(scalePage.data.measuring, false)
  assert.strictEqual(scalePage.data.canConfirm, false)
  assert.ok(toastCount > 0, '410 有明确 toast 提示，不静默')
  // 不自动重放：410 处置过程本身不得再自发任何场次动作
  const replayed = pageCalls.slice(callsBefore410).filter(c => c.fn !== 'saveMeasurementDraft')
  assert.deepStrictEqual(replayed, [], '410 后不得自动重叫/自动重试提交（无静默重放旧会话）')
  const draftsNow = pageCalls.filter(c => c.fn === 'saveMeasurementDraft').length
  await scalePage.saveMeasurementDraft([{ name: 'weight', value: 60, unit: 'kg' }])
  assert.strictEqual(pageCalls.filter(c => c.fn === 'saveMeasurementDraft').length, draftsNow, '无会话时再次提交不再发出草稿请求（必须先重新叫号）')
  assert.strictEqual(scalePage.data.errorText, T.SESSION_EXPIRED_TEXT)
  draftError = null

  // 确认动作同样被过期门禁挡住（不发 confirmMeasurement）
  callNextScript = stationWithSession('srv-sess-C')
  await scalePage.callNext()
  scalePage.setData({ currentDraft: { id: 'draft-x', status: 'RESULT_PENDING' }, canConfirm: true })
  scalePage.measurementSessionId = '' // 模拟会话已被判过期清掉
  const confirmsBefore = pageCalls.filter(c => c.fn === 'confirmMeasurement').length
  await scalePage.confirmMeasurement()
  assert.strictEqual(pageCalls.filter(c => c.fn === 'confirmMeasurement').length, confirmsBefore, '会话失效时确认不得发出')
  assert.strictEqual(scalePage.data.errorText, T.SESSION_EXPIRED_TEXT)

  // ================= 6) 409：按服务端回传状态刷新恢复 =================
  callNextScript = httpError(409, { code: 409, message: 'state conflict', status: 'OPEN', stationId: 'st-p2', deviceType: 'SCALE', currentQueueItem: { id: 'q-9', status: 'CALLED', measurementSessionId: 'srv-sess-D' } })
  await scalePage.callNext()
  assert.ok(/操作冲突/.test(scalePage.data.errorText), '409 → 冲突提示')
  assert.ok(/已按服务端最新状态刷新/.test(scalePage.data.errorText), '提示包含刷新恢复说明')
  assert.strictEqual(scalePage.data.currentQueueItem && scalePage.data.currentQueueItem.id, 'q-9', '409 响应回传的当前活动项被应用')
  callNextScript = null

  // ================= 7) v2 契约异常：callNext 成功但未下发会话 ID =================
  callNextScript = stationWithSession('', { currentQueueItem: { id: 'q-5', status: 'CALLED', patientSummary: { maskedName: '孙*芝' } } })
  await scalePage.callNext()
  assert.strictEqual(scalePage.measurementSessionId, '', 'v2 未下发会话 ID → 不建本地假会话')
  assert.strictEqual(scalePage.data.measuring, false, '未就绪会话不进入采集态')
  assert.ok(/请重新叫号/.test(scalePage.data.statusText), '给出明确的重新叫号指引')
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', metrics: [{ name: 'weight', value: 66, unit: 'kg' }], receivedAt: Date.now() })
  assert.deepStrictEqual(scalePage.metricAccumulator, {}, '无会话时不收任何 BLE 数据')
  callNextScript = null

  // ================= 8) 切换患者六步顺序断言（§8，mock Page 驱动）=================
  const order = []
  const trace = (name, fn) => function (...args) { order.push(name); return fn.apply(this, args) }
  const realAbort = scalePage.abortMeasurementSession.bind(scalePage)
  const realAdopt = scalePage.adoptMeasurementSession.bind(scalePage)
  const realApply = scalePage.applyStation.bind(scalePage)
  scalePage.abortMeasurementSession = trace('abort', realAbort)
  scalePage.adoptMeasurementSession = trace('adopt', realAdopt)
  scalePage.applyStation = trace('apply', realApply)
  scalePage.scale.configurePatient = async () => { order.push('configurePatient'); scalePage.configurePatientCalls = (scalePage.configurePatientCalls || 0) + 1 }
  scalePage.stopMeasurementTimeout()
  scalePage.setData({ deviceTypeMismatch: false, stationId: 'st-p2', connected: true, measuring: false, currentQueueItem: { id: 'q-old', status: 'CALLED' }, errorText: '' })
  scalePage.metricAccumulator = { weight: { name: 'weight', value: 1, unit: 'kg' } }
  scalePage.scale.assembler.buffer = new Uint8Array([1, 2, 3]) // 半帧残留
  scalePage.measurementSessionId = 'srv-sess-STALE'
  order.length = 0
  callNextScript = stationWithSession('srv-sess-E', { currentQueueItem: { id: 'q-new', status: 'CALLED', patientSummary: { maskedName: '钱*多', gender: 1, age: 60, height: 170 } } })
  await scalePage.callNext()
  callNextScript = null
  assert.strictEqual(order[0], 'abort', '第 1~3 步最先执行（停采集/清缓冲/旧会话失效），先于任何网络调用')
  assert.ok(order.indexOf('adopt') >= 1, '第 5 步 adopt 发生在叫号响应处理阶段')
  assert.ok(order.indexOf('adopt') < order.indexOf('configurePatient'), '第 4 步设备配置发生在服务端叫号成功并保存新会话之后')
  assert.strictEqual(scalePage.measurementSessionId, 'srv-sess-E', '最终持有的正是服务端新会话 ID')
  assert.strictEqual(scalePage.measurementCompleteReceived, false, '第 2 步：完成标记复位')
  assert.strictEqual(scalePage.scale.assembler.buffer.length, 0, '第 2 步：BLE 帧缓冲清空')
  // 第 6 步：只收晚于新会话且属于新会话的数据
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', measurementSessionId: 'srv-sess-STALE', metrics: [{ name: 'weight', value: 99, unit: 'kg' }], receivedAt: Date.now() })
  assert.strictEqual(scalePage.metricAccumulator.weight, undefined, '第 6 步：旧会话标记的迟到数据被丢弃')
  await scalePage.onScaleResult({ type: 0x10, status: 'stable', measurementSessionId: 'srv-sess-E', metrics: [{ name: 'weight', value: 62, unit: 'kg' }], receivedAt: Date.now() })
  assert.strictEqual(scalePage.metricAccumulator.weight.value, 62, '第 6 步：新会话数据正常接收')
  scalePage.abortMeasurementSession = realAbort
  scalePage.adoptMeasurementSession = realAdopt
  scalePage.applyStation = realApply

  // ================= 9) MFA1 页 v2 会话装载链与 410 =================
  stationApi.callNext = async () => stationApi.normalizeStation({ id: 'st-m', status: 'OPEN', deviceType: 'MFA1', measurementSessionId: 'mfa-sess-1', currentQueueItem: { id: 'qm-1', status: 'CALLED', patientSummary: { maskedName: '周*星' } } })
  const mfaDrafts = []
  stationApi.saveMeasurementDraft = async (stationId, queueItemId, payload) => { mfaDrafts.push(payload); return stationApi.normalizeStation({ id: stationId, status: 'OPEN', deviceType: 'MFA1', currentQueueItem: { id: queueItemId, status: 'RESULT_PENDING', draftStatus: 'RESULT_PENDING' }, currentDraft: { id: 'md-1', status: 'RESULT_PENDING' } }) }
  mfa1Page.mfa1 = new mfa1BleModule.Mfa1Ble({ onState: () => {}, onResult: r => mfa1Page.onMfa1Result(r) })
  mfa1Page.setData({ deviceTypeMismatch: false, stationId: 'st-m', connected: true, metrics: [], canConfirm: false, measuring: false, errorText: '', currentQueueItem: null, currentDraft: null, saving: false })
  mfa1Page.resetMeasurementState()
  await mfa1Page.callNext()
  assert.strictEqual(mfa1Page.measurementSessionId, 'mfa-sess-1', 'MFA1 页同样装载服务端会话 ID')
  // 尿酸结果（无语境要求）→ 自动草稿携带会话 ID
  await mfa1Page.onMfa1Result({ command: 0x78, type: 'result', metric: { name: 'uricAcid', value: 0.32, unit: 'mmol/L' }, receivedAt: Date.now() })
  await flushPromises()
  assert.strictEqual(mfaDrafts.length, 1, '尿酸结果自动提交草稿')
  assert.strictEqual(mfaDrafts[0].measurementSessionId, 'mfa-sess-1', 'MFA1 v2 草稿携带服务端会话 ID')
  // 410 在 MFA1 页行为一致：提示 + 清态 + 不重放
  stationApi.saveMeasurementDraft = async () => { throw httpError(410, { status: 'OPEN', stationId: 'st-m' }) }
  mfa1Page.setData({ currentQueueItem: { id: 'qm-1', status: 'CALLED' }, metrics: [{ name: 'uricAcid', value: 0.3, unit: 'mmol/L' }] })
  mfa1Page.measurementIdempotencyKey = 'keep-me'
  await mfa1Page.saveMeasurementDraft([{ name: 'uricAcid', value: 0.3, unit: 'mmol/L' }])
  assert.strictEqual(mfa1Page.data.errorText, M.SESSION_EXPIRED_TEXT, 'MFA1 410 同一措辞')
  assert.strictEqual(mfa1Page.measurementSessionId, '', 'MFA1 410 清会话')
  assert.strictEqual(mfa1Page.measurementIdempotencyKey, '', 'MFA1 410 清幂等 key，不自动重放')

  // ================= 10) 患者端九字段白名单不受 v2 影响（阶段一回归 e）=================
  const PATIENT_KEYS = ['stationId', 'stationName', 'deviceType', 'status', 'queueItemId', 'queueNo', 'queueStatus', 'waitingAhead', 'message']
  const dirty = {
    data: { stationId: '197', stationName: '台', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 7, queueStatus: 'WAITING', waitingAhead: 3, message: 'ok',
      checkinToken: 'tok-secret', queue: [{ id: 'x' }], currentQueueItem: { id: 'y' }, currentDraft: { id: 'z' }, patientSummary: { maskedName: '张*' }, metrics: [{ type: 'weight', value: 1 }],
      measurementSessionId: 'srv-session-must-not-leak-to-patient' } }
  const pv = stationApi.normalizePatientQueue(dirty)
  assert.deepStrictEqual(Object.keys(pv).sort(), PATIENT_KEYS.slice().sort(), 'v2 下患者 DTO 字段集仍恰好为九字段')
  assert.ok(!('measurementSessionId' in pv), '检测会话 ID 不得进入患者 DTO')
  assert.ok(!('checkinToken' in pv), '令牌不外泄')

  console.log('device station phase2 tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
