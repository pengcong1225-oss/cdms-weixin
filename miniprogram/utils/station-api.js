const api = require('./api')

function unwrap (response) {
  if (response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')) {
    return response.data
  }
  return response
}

function currentAccessToken () {
  try {
    return getApp()?.globalData?.accessToken || ''
  } catch (_) {
    return ''
  }
}

function toText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function toId (value) {
  return value === null || value === undefined || value === '' ? '' : String(value)
}

function createIdempotencyKey (prefix = 'scale') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function writePayload (payload, prefix) {
  const body = Object.assign({}, payload || {})
  body.idempotencyKey = toText(body.idempotencyKey, createIdempotencyKey(prefix))
  return body
}

/** 血糖上下文（设计 §10.1）：只能是 FASTING / POSTPRANDIAL / RANDOM / UNKNOWN，其余（含缺省）归一为 UNKNOWN。 */
const GLUCOSE_CONTEXTS = ['FASTING', 'POSTPRANDIAL', 'RANDOM', 'UNKNOWN']
function normalizeGlucoseContext (value) {
  const text = String(value === null || value === undefined ? '' : value).trim().toUpperCase()
  return GLUCOSE_CONTEXTS.includes(text) ? text : 'UNKNOWN'
}

/**
 * v2 指标 DTO（设计 §10.1）：可选 context（仅血糖携带，其余类型不下发）与 partial
 * （血脂分段未齐标记）。normalizeMetric 同时服务 v1/v2 通道：v1 服务端会忽略未知字段，
 * 但为避免老后端把 context 当非法键拒绝，v1 草稿仍走 stripContext 路径（见 saveMeasurementDraftV1）。
 */
function normalizeMetricV2 (metric) {
  const base = normalizeMetric(metric)
  if (!base) return null
  const out = Object.assign({}, base)
  const name = out.type
  if (name === 'glucose') out.context = normalizeGlucoseContext(metric.context || metric.glucoseContext)
  if (metric.partial === true || metric.partial === 'true') out.partial = true
  return out
}

function normalizeMetric (metric) {
  if (!metric || typeof metric !== 'object') return null
  return {
    type: toText(metric.type || metric.name),
    value: metric.value === null || metric.value === undefined || metric.value === '' ? '' : metric.value,
    unit: toText(metric.unit)
  }
}

function normalizePatientSummary (summary) {
  if (!summary || typeof summary !== 'object') return null
  return {
    maskedName: toText(summary.maskedName || summary.patientName || summary.displayName || summary.name, '未知患者'),
    gender: summary.gender === null || summary.gender === undefined || summary.gender === '' ? '' : Number(summary.gender),
    genderText: toText(summary.genderText || summary.genderLabel),
    age: summary.age === null || summary.age === undefined || summary.age === '' ? '' : Number(summary.age),
    height: summary.height === null || summary.height === undefined || summary.height === '' ? '' : Number(summary.height),
    heightText: toText(summary.heightText),
    bmi: summary.bmi === null || summary.bmi === undefined || summary.bmi === '' ? '' : Number(summary.bmi)
  }
}

function normalizeQueueItem (item) {
  if (!item || typeof item !== 'object') return null
  return {
    id: toId(item.id || item.queueItemId),
    stationId: toId(item.stationId),
    queueNo: item.queueNo === null || item.queueNo === undefined || item.queueNo === '' ? '' : Number(item.queueNo),
    status: toText(item.status || 'WAITING'),
    draftId: toId(item.draftId),
    draftStatus: toText(item.draftStatus),
    draftConfirmedAt: toText(item.draftConfirmedAt),
    draftCreatedAt: toText(item.draftCreatedAt),
    draftUpdatedAt: toText(item.draftUpdatedAt),
    // v2：活动队列项自身可携带服务端检测会话 ID（医生视图）
    measurementSessionId: toText(item.measurementSessionId),
    selectedAt: toText(item.selectedAt),
    skippedAt: toText(item.skippedAt),
    completedAt: toText(item.completedAt),
    createdAt: toText(item.createdAt),
    updatedAt: toText(item.updatedAt),
    patientSummary: normalizePatientSummary(item.patientSummary),
    metrics: Array.isArray(item.metrics) ? item.metrics.map(normalizeMetric).filter(Boolean) : [],
    patientId: undefined
  }
}

function normalizeStation (response) {
  const data = unwrap(response) || {}
  return {
    id: toId(data.id || data.stationId),
    orgId: toId(data.orgId),
    status: toText(data.status || 'OPEN'),
    stationName: toText(data.stationName),
    deviceType: toText(data.deviceType, 'SCALE'),
    checkinToken: toText(data.checkinToken),
    tokenExpiresAt: toText(data.tokenExpiresAt),
    currentQueueItemId: toId(data.currentQueueItemId),
    currentQueueStatus: toText(data.currentQueueStatus),
    currentDraftId: toId(data.currentDraftId),
    currentDraftStatus: toText(data.currentDraftStatus),
    // v2（设计 §8）：活动队列项携带服务端签发的检测会话 UUID；v1 响应无此字段 → ''
    measurementSessionId: toText(data.measurementSessionId),
    error: toText(data.error),
    queue: Array.isArray(data.queue) ? data.queue.map(normalizeQueueItem).filter(Boolean) : [],
    currentQueueItem: normalizeQueueItem(data.currentQueueItem),
    currentDraft: normalizeQueueItem(data.currentDraft)
  }
}

function normalizeQueueList (response) {
  const data = unwrap(response) || {}
  const list = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.queue)
        ? data.queue
        : []
  return {
    items: list.map(normalizeQueueItem).filter(Boolean),
    total: data.total === null || data.total === undefined || data.total === '' ? list.length : Number(data.total),
    stationId: toId(data.stationId),
    status: toText(data.status || 'OPEN')
  }
}

/**
 * 版本化端点前缀（设计 §15 API 演进）：v1 = scale/stations（灰度回退保留），
 * v2 = device-stations（检测会话 + 严格状态机 + context/partial）。
 */
const STATION_API_VERSIONS = {
  v1: '/api/v1/miniapp/scale/stations',
  v2: '/api/v2/miniapp/device-stations'
}

/** 机构到场签到 v2（设计 §12.1 / §15）：token 绑定 org/checkpoint，按 token 兑换。 */
const ORG_CHECKIN_V2_PATH = '/api/v2/miniapp/checkins'

/** 当前生效通道：页面通过 api.STATION_API_VERSION 读取；灰度回退时 setStationApiVersion('v1')。 */
let stationApiVersion = 'v2'

function stationPathPrefix () {
  return STATION_API_VERSIONS[stationApiVersion] || STATION_API_VERSIONS.v2
}

function setStationApiVersion (version) {
  const text = String(version || '').toLowerCase()
  if (!STATION_API_VERSIONS[text]) throw new Error('未知的场次接口版本：' + text)
  stationApiVersion = text
}

/**
 * 错误规范化（设计 §17）：409=状态冲突/幂等 key 内容冲突，410=二维码或检测会话已过期。
 * v2 的 409/410 响应体携带【当前服务端状态】供小程序刷新恢复；后端可能把状态平铺在响应顶层、
 * data 里、或尚未解包，三种形态都要取到并归一化为 error.stationState。
 * error.expiredSession / error.stateConflict 是显式布尔标记：页面据此区分「清态且不得自动重放」与「刷新后重试」。
 */
function extractStationState (response) {
  if (!response || typeof response !== 'object') return null
  const candidates = [response, response.data, response.result]
  for (const candidate of candidates) {
    if (!candidate || typeof candidate !== 'object') continue
    if (candidate.status || candidate.stationId || candidate.id || candidate.currentQueueItem || Array.isArray(candidate.queue)) return candidate
  }
  return null
}

function normalizeStationError (error) {
  if (!error || !Number.isFinite(Number(error.statusCode))) return error
  const code = Number(error.statusCode)
  if (code !== 409 && code !== 410) return error
  error.expiredSession = code === 410
  if (code === 409) error.stateConflict = true
  const state = extractStationState(error.response)
  if (state) {
    error.serverState = state
    error.stationState = normalizeStation(state)
  }
  return error
}

async function requestStation (path, method, body) {
  try {
    return await api.cdmsRequest(path, method, body, currentAccessToken())
  } catch (error) {
    throw normalizeStationError(error)
  }
}

function stationPath (stationId, suffix) {
  return stationPathPrefix() + '/' + encodeURIComponent(String(stationId || '')) + (suffix || '')
}

async function createStation (payload = {}) {
  const body = writePayload(payload, 'station-create')
  // 设备类型（SCALE / MFA1）原样透传给服务端枚举校验，缺省由服务端按 SCALE 处理
  if (body.deviceType !== undefined && body.deviceType !== null) body.deviceType = toText(body.deviceType)
  return normalizeStation(await requestStation(stationPathPrefix(), 'POST', body))
}

async function getStation (stationId) {
  return normalizeStation(await requestStation(stationPath(stationId), 'GET', null))
}

// 后端已将设备排队签到的患者响应从完整场次视图收紧为 MiniappScaleStationPatientQueueDTO：
// 仅含 stationId、stationName、deviceType、status（场次状态）、本人 queueItemId、本人 queueNo、
// 本人 queueStatus、waitingAhead（前方等待人数）、message。不再返回 checkinToken / 完整 queue /
// currentQueueItem / currentDraft / patientSummary / metrics，患者端必须走本归一化器；
// normalizeStation 保留给医生工作站动作（callNext/skip/draft/confirm/getStation）使用。
function normalizePatientQueue (response) {
  const data = unwrap(response) || {}
  return {
    stationId: toId(data.stationId),
    stationName: toText(data.stationName),
    deviceType: toText(data.deviceType, 'SCALE'),
    status: toText(data.status || 'OPEN'),
    queueItemId: toId(data.queueItemId),
    queueNo: data.queueNo === null || data.queueNo === undefined || data.queueNo === '' ? '' : Number(data.queueNo),
    queueStatus: toText(data.queueStatus),
    waitingAhead: data.waitingAhead === null || data.waitingAhead === undefined || data.waitingAhead === '' ? '' : Number(data.waitingAhead),
    message: toText(data.message)
  }
}

function stationPathFor (channel, stationId, suffix) {
  const prefix = STATION_API_VERSIONS[String(channel || '').toLowerCase()] || STATION_API_VERSIONS.v2
  return prefix + '/' + encodeURIComponent(String(stationId || '')) + (suffix || '')
}

/**
 * 设备场次签到（阶段三 §12.2 / §15）：
 * - channel v1（老码 LEGACY_STATION，灰度过渡）：body 保留明文 checkinToken，走老场次端点；
 * - channel v2（安全码 NEW DEVICE_STATION）：body 用不透明 token 取代 checkinToken；
 * 显式指定 channel 时不受全局 stationApiVersion 影响，保证「老码老通道、新码新通道」分流。
 */
async function createCheckin (stationId, token, payload = {}, options = {}) {
  const channel = String(options.channel || stationApiVersion).toLowerCase()
  if (!STATION_API_VERSIONS[channel]) throw new Error('未知的场次接口版本：' + channel)
  const isV2 = STATION_API_VERSIONS[channel] === STATION_API_VERSIONS.v2
  const fields = Object.assign({}, payload || {})
  fields[isV2 ? 'token' : 'checkinToken'] = toText(token)
  return normalizePatientQueue(await requestStation(stationPathFor(channel, stationId, '/checkins'), 'POST', writePayload(fields, 'station-checkin')))
}

/**
 * 设备场次签到 token-only（设计 §12.2 / 阶段三收口）：POST .../device-stations/checkins/token。
 * 场次由服务端按 token 绑定解析，患者扫码无需知道 stationId；响应仍为患者九字段 DTO（含 stationId）。
 * 仅 v2 通道（token 码本身即 v2 语义），不受全局 stationApiVersion 影响。
 */
async function createCheckinByToken (token, payload = {}) {
  const body = writePayload(Object.assign({}, payload || {}, { token: toText(token) }), 'station-checkin')
  return normalizePatientQueue(await requestStation(STATION_API_VERSIONS.v2 + '/checkins/token', 'POST', body))
}

/**
 * 机构到场签到 v2（设计 §12.1 / §5.1 ORG_CHECKIN）：POST /api/v2/miniapp/checkins，
 * body { token, idempotencyKey }。响应为最小 VO：{checkinId,status,checkpointName}，
 * 不回传 token 原文（§12.1：原始 token 不落库、不写日志、不在响应回传）。
 */
function normalizeOrgCheckin (response) {
  const data = unwrap(response) || {}
  return {
    checkinId: toId(data.checkinId || data.id),
    status: toText(data.status),
    checkpointName: toText(data.checkpointName)
  }
}

async function orgCheckinV2 (token, payload = {}) {
  const body = writePayload(Object.assign({}, payload || {}, { token: toText(token) }), 'org-checkin')
  return normalizeOrgCheckin(await requestStation(ORG_CHECKIN_V2_PATH, 'POST', body))
}

// 患者专用排队查询：签到后轮询本人 queueNo / queueStatus / waitingAhead / message
async function getMyQueue (stationId) {
  return normalizePatientQueue(await requestStation(stationPath(stationId, '/my-queue'), 'GET', null))
}

async function getTodayQueue (stationId) {
  return normalizeQueueList(await requestStation(stationPath(stationId, '/queue'), 'GET', null))
}

async function callNext (stationId, payload = {}) {
  return normalizeStation(await requestStation(stationPath(stationId, '/call-next'), 'POST', writePayload(payload, 'station-next')))
}

async function skipQueueItem (stationId, queueItemId, payload = {}) {
  return normalizeStation(await requestStation(stationPath(stationId, '/queue/' + encodeURIComponent(String(queueItemId || '')) + '/skip'), 'POST', writePayload(payload, 'station-skip')))
}

async function requeueQueueItem (stationId, queueItemId, payload = {}) {
  return normalizeStation(await requestStation(stationPath(stationId, '/queue/' + encodeURIComponent(String(queueItemId || '')) + '/requeue'), 'POST', writePayload(payload, 'station-requeue')))
}

/**
 * 保存草稿。v2（设计 §8/§10.1）：必带服务端下发的 measurementSessionId，指标走 context/partial DTO；
 * v1（灰度回退）：不发 sessionId、指标去掉 context/partial——后端同事明确 v1 不接受新 MFA1 指标契约。
 */
async function saveMeasurementDraft (stationId, queueItemId, payload = {}) {
  const isV2 = stationPathPrefix() === STATION_API_VERSIONS.v2
  const sourceMetrics = Array.isArray(payload.metrics)
    ? (isV2 ? payload.metrics.map(normalizeMetricV2) : payload.metrics.map(normalizeMetric)).filter(Boolean)
    : []
  const fields = {
    idempotencyKey: payload.idempotencyKey,
    deviceId: payload.deviceId,
    measuredAt: payload.measuredAt,
    gender: payload.gender,
    age: payload.age,
    height: payload.height,
    metrics: sourceMetrics
  }
  if (isV2) fields.measurementSessionId = toText(payload.measurementSessionId)
  const body = writePayload(fields, 'station-draft')
  return normalizeStation(await requestStation(stationPath(stationId, '/queue/' + encodeURIComponent(String(queueItemId || '')) + '/draft'), 'POST', body))
}

/** 确认草稿。v2 请求体必填 measurementSessionId（payload 或 this 侧传入均可）。 */
async function confirmMeasurement (stationId, queueItemId, draftId, payload = {}) {
  const body = writePayload(payload, 'station-confirm')
  if (stationPathPrefix() === STATION_API_VERSIONS.v2 && !body.measurementSessionId) {
    // 缺失即拒绝发起：会话不匹配的确认绝不允许静默发出（设计 §8）
    throw new Error('缺少检测会话标识，请重新叫号')
  }
  return normalizeStation(await requestStation(stationPath(stationId, '/queue/' + encodeURIComponent(String(queueItemId || '')) + '/drafts/' + encodeURIComponent(String(draftId || '')) + '/confirm'), 'POST', body))
}

async function closeStation (stationId, payload = {}) {
  const body = writePayload({
    idempotencyKey: payload.idempotencyKey,
    discardDraftIds: Array.isArray(payload.discardDraftIds) ? payload.discardDraftIds.map(id => toId(id)).filter(Boolean) : []
  }, 'station-close')
  return normalizeStation(await requestStation(stationPath(stationId, '/close'), 'POST', body))
}

/** 当前生效通道（只读快照，供页面/测试断言）。 */
function getStationApiVersion () { return stationApiVersion }

function reduceStationState (state = {}, action = {}) {
  const current = Object.assign({
    status: 'OPEN',
    activeQueueItemId: '',
    activeQueueStatus: '',
    currentDraftId: '',
    currentDraftStatus: '',
    error: '',
    queue: []
  }, state)
  current.queue = Array.isArray(current.queue) ? current.queue.map(item => Object.assign({}, item)) : []

  const setCurrent = (patch = {}) => Object.assign({}, current, patch, { queue: current.queue })
  const activeStatuses = new Set(['CALLED', 'MEASURING', 'RESULT_PENDING'])

  if (action.type === 'CALL_NEXT') {
    const active = current.queue.find(item => activeStatuses.has(String(item.status || '').toUpperCase()))
    if (active) {
      return setCurrent({ error: '当前已有患者正在测量' })
    }
    const next = current.queue.find(item => String(item.status || '').toUpperCase() === 'WAITING')
    if (!next) return setCurrent({ error: '暂无待测患者' })
    current.queue = current.queue.map(item => String(item.id) === String(next.id) ? Object.assign({}, item, { status: 'CALLED' }) : item)
    return setCurrent({ error: '', activeQueueItemId: toId(next.id), activeQueueStatus: 'CALLED' })
  }

  if (action.type === 'MARK_MEASURING') {
    if (String(current.activeQueueItemId || '') !== String(action.queueItemId || '')) {
      return setCurrent({ error: '当前患者不匹配' })
    }
    current.queue = current.queue.map(item => String(item.id) === String(action.queueItemId) ? Object.assign({}, item, { status: 'MEASURING' }) : item)
    return setCurrent({ error: '', activeQueueStatus: 'MEASURING' })
  }

  if (action.type === 'SAVE_DRAFT') {
    if (String(current.activeQueueItemId || '') !== String(action.queueItemId || '')) {
      return setCurrent({ error: '当前患者不匹配' })
    }
    current.queue = current.queue.map(item => String(item.id) === String(action.queueItemId)
      ? Object.assign({}, item, { status: 'RESULT_PENDING', draftId: action.draftId || item.draftId || '', draftStatus: 'RESULT_PENDING' })
      : item)
    return setCurrent({ error: '', currentDraftId: toId(action.draftId), currentDraftStatus: 'RESULT_PENDING', activeQueueStatus: 'RESULT_PENDING' })
  }

  if (action.type === 'CONFIRM_MEASUREMENT') {
    if (String(current.activeQueueItemId || '') !== String(action.queueItemId || '')) {
      return setCurrent({ error: '当前患者不匹配' })
    }
    current.queue = current.queue.map(item => String(item.id) === String(action.queueItemId)
      ? Object.assign({}, item, { status: 'COMPLETED', draftStatus: 'CONFIRMED', completedAt: action.completedAt || item.completedAt || '' })
      : item)
    return setCurrent({
      error: '',
      activeQueueItemId: '',
      activeQueueStatus: '',
      currentDraftId: toId(action.draftId),
      currentDraftStatus: 'CONFIRMED'
    })
  }

  if (action.type === 'SKIP_QUEUE_ITEM') {
    current.queue = current.queue.map(item => String(item.id) === String(action.queueItemId)
      ? Object.assign({}, item, { status: 'SKIPPED' })
      : item)
    return setCurrent({ error: '', activeQueueItemId: '', activeQueueStatus: '' })
  }

  if (action.type === 'REQUEUE_QUEUE_ITEM') {
    current.queue = current.queue.map(item => String(item.id) === String(action.queueItemId)
      ? Object.assign({}, item, { status: 'WAITING' })
      : item)
    return setCurrent({ error: '', activeQueueItemId: '', activeQueueStatus: '' })
  }

  if (action.type === 'CLOSE') {
    return setCurrent({ error: '', status: action.status || 'CLOSED', activeQueueItemId: '', activeQueueStatus: '', currentDraftId: '', currentDraftStatus: '' })
  }

  return current
}

module.exports = {
  ORG_CHECKIN_V2_PATH,
  STATION_API_VERSIONS,
  GLUCOSE_CONTEXTS,
  callNext,
  closeStation,
  confirmMeasurement,
  createCheckin,
  createCheckinByToken,
  createIdempotencyKey,
  createStation,
  getStationApiVersion,
  getMyQueue,
  getStation,
  getTodayQueue,
  normalizeGlucoseContext,
  normalizeMetricV2,
  normalizeOrgCheckin,
  normalizePatientQueue,
  normalizeQueueItem,
  normalizeStation,
  normalizeStationError,
  orgCheckinV2,
  requeueQueueItem,
  reduceStationState,
  setStationApiVersion,
  stationPathFor,
  stationPathPrefix,
  saveMeasurementDraft,
  skipQueueItem
}
