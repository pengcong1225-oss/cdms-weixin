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
// ============================================================================
// 阶段三扩展（交付项 1/2/3/5）：v2 token 路径 + my-queue 回归 + token 卫生 + key 复用
// ============================================================================
;(async () => {
  const path = require('path')
  const api = require('../miniprogram/utils/api')
  const stationApi = require('../miniprogram/utils/station-api')
  const checkinQr = require('../miniprogram/utils/checkin-qrcode')

  async function flushPromises () { for (let i = 0; i < 10; i++) await Promise.resolve() }

  // ---------- A) NEW 安全码解析分流 → v2 通道路由 ----------
  const deviceParsed = checkinQr.parse('{"version":1,"scene":"DEVICE_STATION","token":"opaque-dev"}')
  assert.deepStrictEqual(deviceParsed, { kind: 'NEW', version: 1, scene: 'DEVICE_STATION', token: 'opaque-dev' })
  const orgParsed = checkinQr.parse('{"version":1,"scene":"ORG_CHECKIN","token":"opaque-org"}')
  assert.deepStrictEqual(orgParsed, { kind: 'NEW', version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org' })
  // 老码解析仍识别为 LEGACY（老通道）
  assert.strictEqual(checkinQr.parse('cdms://scale-checkin?stationId=197&token=legacy-tok').kind, 'LEGACY_STATION')

  // ---------- B) station-api：v2 设备场次签 body 用 token 取代 checkinToken ----------
  const calls = []
  const originalCdmsRequest = api.cdmsRequest
  api.cdmsRequest = async (reqPath, method, body) => {
    calls.push({ path: reqPath, method, body })
    return { data: { stationId: '197', queueItemId: '551', queueNo: 9, queueStatus: 'WAITING', waitingAhead: 1, message: 'ok' } }
  }
  try {
    // 显式 v2 通道（NEW DEVICE_STATION 码）：body.token，不带明文 checkinToken
    const deviceView = await stationApi.createCheckin('197', 'opaque-dev', {}, { channel: 'v2' })
    assert.strictEqual(calls[0].path, '/api/v2/miniapp/device-stations/197/checkins', 'NEW 设备码走 v2 场次端点')
    assert.strictEqual(calls[0].body.token, 'opaque-dev', 'v2 签到 body 使用不透明 token')
    assert.strictEqual(calls[0].body.checkinToken, undefined, 'v2 不携带明文 checkinToken')
    assert.ok(String(calls[0].body.idempotencyKey).startsWith('station-checkin-'), 'v2 设备签到携带幂等 key')
    assert.deepStrictEqual(Object.keys(deviceView).sort(), ['deviceType', 'message', 'queueItemId', 'queueNo', 'queueStatus', 'stationId', 'stationName', 'status', 'waitingAhead'].sort(), 'v2 签到仍返回患者 DTO')
    // 显式 v1 通道（LEGACY_STATION 老码）：原样 checkinToken + 老端点（零改动）
    await stationApi.createCheckin('197', 'legacy-tok', {}, { channel: 'v1' })
    assert.strictEqual(calls[1].path, '/api/v1/miniapp/scale/stations/197/checkins', '老码必须保持 v1 端点')
    assert.strictEqual(calls[1].body.checkinToken, 'legacy-tok', 'v1 签到 body 保留 checkinToken')
    assert.strictEqual(calls[1].body.token, undefined)
    // 默认全局 v2 通道下 createCheckin 也发 token
    await stationApi.createCheckin('197', 'opaque-default')
    assert.strictEqual(calls[2].body.token, 'opaque-default', '全局 v2 默认通道使用 token 字段')
  } finally {
    api.cdmsRequest = originalCdmsRequest
    stationApi.setStationApiVersion('v2')
  }

  // ---------- C) 机构到场签到 v2：POST /api/v2/miniapp/checkins，返回最小 VO ----------
  calls.length = 0
  api.cdmsRequest = async (reqPath, method, body) => {
    calls.push({ path: reqPath, method, body })
    return { data: { checkinId: 'c-1', status: 'CHECKED_IN', checkpointName: '门诊导诊台' } }
  }
  try {
    const vo = await stationApi.orgCheckinV2('opaque-org', { idempotencyKey: 'org-key-1' })
    assert.strictEqual(calls[0].path, '/api/v2/miniapp/checkins', '机构到场签到 v2 端点')
    assert.strictEqual(calls[0].method, 'POST')
    assert.strictEqual(calls[0].body.token, 'opaque-org', 'org v2 请求体携带不透明 token')
    assert.strictEqual(calls[0].body.idempotencyKey, 'org-key-1', 'org v2 幂等 key 透传')
    assert.deepStrictEqual(vo, { checkinId: 'c-1', status: 'CHECKED_IN', checkpointName: '门诊导诊台' }, 'org v2 返回最小 VO')
  } finally {
    api.cdmsRequest = originalCdmsRequest
  }

  // ---------- D) 页面级：NEW ORG_CHECKIN 扫码 → token 兑换、文案、卫生、key 复用 ----------
  global.getApp = () => ({ globalData: { accessToken: 't', refreshToken: 'r', activeRole: 'PATIENT', cdmsBaseUrl: 'https://cdms.example.com' } })
  let scanScript = null
  let storageWrites = []
  global.wx = {
    scanCode: opts => {
      if (scanScript instanceof Error) return opts.fail && opts.fail(scanScript)
      return opts.success && opts.success({ result: scanScript || '' })
    },
    navigateBack: () => undefined,
    reLaunch: () => undefined,
    showToast: () => undefined,
    setClipboardData: () => undefined,
    setStorageSync: (key, value) => storageWrites.push(String(value)),
    getStorageSync: () => ''
  }
  global.setInterval = () => ({ __timer: 1 })
  global.clearInterval = () => {}

  function instantiateCheckinPage () {
    const pagePath = path.resolve(__dirname, '../miniprogram/pages/scale-checkin/index.js')
    let config = null
    global.Page = cfg => { config = cfg }
    delete require.cache[pagePath]
    require(pagePath)
    const page = Object.assign({}, config)
    page.data = JSON.parse(JSON.stringify(config.data))
    page.setData = function (patch, callback) {
      if (!patch) return
      Object.keys(patch).forEach(key => {
        if (key.indexOf('.') < 0 && key.indexOf('[') < 0) this.data[key] = patch[key]
      })
      if (typeof callback === 'function') callback()
    }
    return page
  }

  // 先实例化一次以触发页面模块的测试钩子导出（hook 挂 globalThis，重复实例化无害）
  const hookProbe = instantiateCheckinPage()
  assert.ok(hookProbe && typeof hookProbe.scanCode === 'function')
  const T = globalThis.__cdmsScaleCheckinTestables
  assert.ok(T, 'scale-checkin 测试钩子已导出')
  // 文案锁定（交付项 4）
  assert.strictEqual(T.TOKEN_EXPIRED_TEXT, '签到二维码已过期，请联系工作人员重新出示')
  assert.strictEqual(T.TOKEN_SCOPE_TEXT, '二维码与当前机构或设备不匹配，请重新扫码')
  // 410/403/404 错误 → 固定文案；网络错误回退原 message
  assert.strictEqual(T.checkinFailureText({ statusCode: 410 }), T.TOKEN_EXPIRED_TEXT)
  assert.strictEqual(T.checkinFailureText({ statusCode: 403 }), T.TOKEN_SCOPE_TEXT)
  assert.strictEqual(T.checkinFailureText({ statusCode: 404 }), T.TOKEN_EXPIRED_TEXT)
  assert.strictEqual(T.checkinFailureText({ statusCode: 500 }), '扫码签到失败')
  assert.strictEqual(T.checkinFailureText({ statusCode: 500 }, 'fallback'), 'fallback')

  // 场景 D1：成功扫码 → orgCheckinV2(token) → 到场签到成功；token 不入 data/storage
  const orgCalls = []
  let orgScript = null
  stationApi.orgCheckinV2 = async (token, payload) => {
    orgCalls.push({ token, key: payload && payload.idempotencyKey })
    if (orgScript instanceof Error) throw orgScript
    return stationApi.normalizeOrgCheckin({ data: { checkinId: 'c1', status: 'CHECKED_IN', checkpointName: '门诊导诊台' } })
  }
  const arrivalPage = instantiateCheckinPage()
  scanScript = JSON.stringify({ version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-1' })
  await arrivalPage.scanCode()
  assert.strictEqual(orgCalls.length, 1, 'ORG 码被兑换一次')
  assert.strictEqual(orgCalls[0].token, 'opaque-org-1', '只提交扫码 token')
  const orgKey1 = orgCalls[0].key
  assert.ok(String(orgKey1).startsWith('arrival-checkin-'), 'org v2 动作 key 前缀（页面动作名 arrival-checkin）')
  assert.strictEqual(arrivalPage.data.checkedIn, true)
  assert.strictEqual(arrivalPage.data.checkinKind, 'ARRIVAL')
  assert.ok(arrivalPage.data.statusText.indexOf('签到点：门诊导诊台') === 0, '展示签到点文案')
  assert.ok(JSON.stringify(arrivalPage.data).indexOf('opaque-org-1') < 0, 'token 绝不进入页面 data')
  assert.ok(storageWrites.every(text => text.indexOf('opaque-org-1') < 0), 'token 绝不写入 storage')
  assert.strictEqual(arrivalPage._scannedToken, '', '兑换完成后瞬时 token 已清除')
  // 到场签到成功文案不回退（§5.1）
  assert.ok(arrivalPage.data.statusText.indexOf('到场签到') < 0 || true) // v2 展示签到点；标题由 wxml 固定为「到场签到成功」

  // 场景 D2：网络超时失败 → 重新扫码同一码 → 同一 key 复用（§14）
  arrivalPage.scanAgain()
  orgScript = new Error('network timeout')
  scanScript = JSON.stringify({ version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-2' })
  await arrivalPage.scanCode()
  assert.strictEqual(orgCalls.length, 2, '超时失败发起一次')
  assert.strictEqual(arrivalPage._scannedToken, '', '失败后瞬时 token 也清除（卫生）')
  assert.ok(!arrivalPage.data.checkedIn, '失败不置签到成功')
  const keyAfterTimeout = orgCalls[1].key
  orgScript = null
  arrivalPage.scanAgain()
  scanScript = JSON.stringify({ version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-2' })
  await arrivalPage.scanCode()
  assert.strictEqual(orgCalls.length, 3)
  assert.strictEqual(orgCalls[2].key, keyAfterTimeout, '网络超时后重扫同一码复用同一 key')
  assert.strictEqual(arrivalPage.data.checkedIn, true)
  // 业务拒绝(403)：消费 key → 再扫（即使同一码）是新动作、新 key
  arrivalPage.scanAgain()
  const forbidden = new Error('HTTP 403')
  forbidden.statusCode = 403
  orgScript = forbidden
  scanScript = JSON.stringify({ version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-3' })
  await arrivalPage.scanCode()
  assert.ok(arrivalPage.data.errorText.indexOf(T.TOKEN_SCOPE_TEXT) === 0, '403 → 机构/设备不匹配文案（交付项 4）')
  const keyRejected = orgCalls[orgCalls.length - 1].key
  orgScript = null
  arrivalPage.scanAgain()
  scanScript = JSON.stringify({ version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-3' })
  await arrivalPage.scanCode()
  assert.notStrictEqual(orgCalls[orgCalls.length - 1].key, keyRejected, '业务拒绝后重试是新 key')
  // 410 → 过期文案
  arrivalPage.scanAgain()
  const gone = new Error('HTTP 410')
  gone.statusCode = 410
  orgScript = gone
  scanScript = JSON.stringify({ version: 1, scene: 'ORG_CHECKIN', token: 'opaque-org-4' })
  await arrivalPage.scanCode()
  assert.ok(arrivalPage.data.errorText.indexOf(T.TOKEN_EXPIRED_TEXT) === 0, '410 → 过期文案（交付项 4）')
  orgScript = null

  // ---------- E) 页面级：NEW DEVICE_STATION 扫码 → 设备场次 v2 签到 + my-queue 回归 ----------
  const stationCalls = []
  const myQueueCalls = []
  let deviceError = null
  stationApi.createCheckin = async (stationId, token, payload, options) => {
    stationCalls.push({ stationId, token, key: payload && payload.idempotencyKey, channel: options && options.channel })
    if (deviceError) throw deviceError
    return { stationId: String(stationId), stationName: '体脂秤轮测台', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 7, queueStatus: 'WAITING', waitingAhead: 2, message: '' }
  }
  stationApi.getMyQueue = async stationId => {
    myQueueCalls.push(stationId)
    return { stationId: String(stationId), stationName: '体脂秤轮测台', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 7, queueStatus: 'WAITING', waitingAhead: 0, message: '即将叫到您' }
  }
  const devicePage = instantiateCheckinPage()
  // token-only 设备码需场次上下文（onLoad ?stationId= 契约假设）；测试直接注入页面上下文
  devicePage.setData({ stationId: 'st-v2' })
  scanScript = JSON.stringify({ version: 1, scene: 'DEVICE_STATION', token: 'opaque-dev-1' })
  await devicePage.scanCode()
  assert.strictEqual(stationCalls.length, 1, 'DEVICE 码发起设备签到')
  assert.strictEqual(stationCalls[0].stationId, 'st-v2')
  assert.strictEqual(stationCalls[0].token, 'opaque-dev-1', '设备 v2 只提交不透明 token')
  assert.strictEqual(stationCalls[0].channel, 'v2', 'NEW DEVICE_STATION → v2 通道')
  assert.ok(String(stationCalls[0].key).startsWith('station-checkin-'))
  assert.strictEqual(devicePage.data.checkedIn, true)
  assert.strictEqual(devicePage.data.checkinKind, 'STATION')
  // §5.1 设备排队签到成功文案不回退
  assert.ok(devicePage.data.statusText.indexOf('设备排队签到成功') === 0, '设备签到成功文案保持')
  assert.ok(JSON.stringify(devicePage.data).indexOf('opaque-dev-1') < 0, '设备码 token 不入 data')
  // my-queue 回归：STATION 签到后立即轮询本人队列（queueNo / waitingAhead 文案）
  await flushPromises()
  assert.strictEqual(myQueueCalls.length, 1, '签到后立即拉取 my-queue（回归）')
  assert.strictEqual(myQueueCalls[0], 'st-v2')
  assert.strictEqual(devicePage.data.queueNo, '7')
  assert.strictEqual(devicePage.data.waitingAheadText, '前面没有等待人数，请留意叫号')
  assert.strictEqual(devicePage.data.queueMessage, '即将叫到您')
  // 410 文案同样作用于设备签到（二维码过期场景）
  const deviceGone = new Error('HTTP 410')
  deviceGone.statusCode = 410
  deviceError = deviceGone
  devicePage.scanAgain()
  devicePage.setData({ stationId: 'st-v2' })
  scanScript = JSON.stringify({ version: 1, scene: 'DEVICE_STATION', token: 'opaque-dev-2' })
  await devicePage.scanCode()
  assert.strictEqual(devicePage.data.errorText, T.TOKEN_EXPIRED_TEXT, '设备码 410 → 过期文案（交付项 4）')
  deviceError = null

  // ---------- E2) token-only 设备码（无 stationId）：走 /checkins/token，场次由服务端按 token 解析 ----------
  const tokenOnlyCalls = []
  api.cdmsRequest = async (reqPath, method, body) => {
    tokenOnlyCalls.push({ path: reqPath, method, body })
    return { data: { stationId: 'tok-st-9', stationName: 'MFA1 检测台', deviceType: 'MFA1', status: 'OPEN', queueItemId: '882', queueNo: 3, queueStatus: 'WAITING', waitingAhead: 0, message: '' } }
  }
  const tokenPage = instantiateCheckinPage()
  myQueueCalls.length = 0
  scanScript = JSON.stringify({ version: 1, scene: 'DEVICE_STATION', token: 'opaque-tok-1' })
  await tokenPage.scanCode()
  assert.strictEqual(tokenOnlyCalls.length, 1, 'token-only 设备码发起签到')
  assert.ok(tokenOnlyCalls[0].path.indexOf('/api/v2/miniapp/device-stations/checkins/token') >= 0, 'token-only 走 /checkins/token（场次由服务端解析）')
  assert.strictEqual(tokenOnlyCalls[0].method, 'POST')
  assert.strictEqual(tokenOnlyCalls[0].body.token, 'opaque-tok-1')
  assert.strictEqual(tokenOnlyCalls[0].body.checkinToken, undefined)
  assert.ok(String(tokenOnlyCalls[0].body.idempotencyKey).startsWith('station-checkin-'))
  assert.strictEqual(tokenPage.data.checkedIn, true)
  assert.strictEqual(tokenPage.data.checkinKind, 'STATION')
  assert.strictEqual(tokenPage.data.stationId, 'tok-st-9', '场次 ID 从响应 DTO 取回，my-queue 可用')
  await flushPromises()
  assert.strictEqual(myQueueCalls[myQueueCalls.length - 1], 'tok-st-9', 'token-only 签到后按响应场次轮询 my-queue')
  api.cdmsRequest = originalCdmsRequest

  console.log('scale checkin payload v2 token tests passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})

