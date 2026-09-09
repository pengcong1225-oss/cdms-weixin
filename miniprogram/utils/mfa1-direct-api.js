/**
 * MFA-1 单人直接测量客户端 API（V58，无场次直测）：
 * - POST /api/v2/miniapp/mfa1/direct/sessions  创建直测会话（绑定本院患者与设备）
 * - POST /api/v2/miniapp/mfa1/direct/confirm   确认落库（幂等以 measurementSessionId 兜底）
 * 错误规范化复用 station-api（409=状态冲突 / 410=会话过期），指标 DTO 复用 v2 契约
 * 归一化（glucose 带 context、血脂未齐标 partial）。
 */
const api = require('./api')
const stationApi = require('./station-api')

const MFA1_DIRECT_PATH = '/api/v2/miniapp/mfa1/direct'

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

/** ID 一律字符串（铁律：雪花/业务 id 禁止 Number 化）。 */
function toId (value) {
  return value === null || value === undefined || value === '' ? '' : String(value)
}

function createIdempotencyKey (prefix = 'mfa1-direct') {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function writePayload (payload, prefix) {
  const body = Object.assign({}, payload || {})
  body.idempotencyKey = toText(body.idempotencyKey, createIdempotencyKey(prefix))
  return body
}

async function requestDirect (path, method, body) {
  try {
    return await api.cdmsRequest(path, method, body, currentAccessToken())
  } catch (error) {
    throw stationApi.normalizeStationError(error)
  }
}

/** 创建直测会话响应归一化：measurementSessionId 是后续确认落库的幂等锚点。 */
function normalizeSessionView (response) {
  const data = unwrap(response) || {}
  return {
    measurementSessionId: toText(data.measurementSessionId),
    patientId: toId(data.patientId),
    orgId: toId(data.orgId),
    deviceType: toText(data.deviceType, 'MFA1'),
    deviceId: toText(data.deviceId),
    status: toText(data.status, 'ACTIVE'),
    startedAt: toText(data.startedAt),
    ttlMinutes: data.ttlMinutes === null || data.ttlMinutes === undefined ? '' : Number(data.ttlMinutes)
  }
}

/** 确认落库响应归一化：id 一律字符串（服务端返回的测量记录 id）。 */
function normalizeConfirmView (response) {
  const data = unwrap(response) || {}
  return {
    id: toId(data.id),
    measurementSessionId: toText(data.measurementSessionId),
    patientId: toId(data.patientId),
    deviceType: toText(data.deviceType, 'MFA1'),
    sourceType: toText(data.sourceType, 'DIRECT'),
    testType: toText(data.testType),
    resultStatus: toText(data.resultStatus),
    status: toText(data.status),
    confirmedAt: toText(data.confirmedAt)
  }
}

/** 创建直测会话：body { patientId, deviceId, idempotencyKey }。 */
async function createSession (payload = {}) {
  const body = writePayload({
    patientId: payload.patientId,
    deviceId: toText(payload.deviceId),
    idempotencyKey: payload.idempotencyKey
  }, 'direct-session')
  if (body.patientId !== undefined && body.patientId !== null) body.patientId = toId(body.patientId)
  return normalizeSessionView(await requestDirect(MFA1_DIRECT_PATH + '/sessions', 'POST', body))
}

/**
 * 确认落库：body { measurementSessionId, patientId, deviceId, measuredAt, metrics, idempotencyKey }。
 * 电量作为设备状态随载荷审计发送（服务端不投影为患者临床指标，§10.3）。
 */
async function confirmDirect (payload = {}) {
  const metrics = Array.isArray(payload.metrics) ? payload.metrics.map(stationApi.normalizeMetricV2).filter(Boolean) : []
  if (Number.isFinite(payload.batteryLevel)) {
    metrics.push({ type: 'battery', value: payload.batteryLevel, unit: '%' })
  }
  const body = writePayload({
    measurementSessionId: toText(payload.measurementSessionId),
    patientId: toId(payload.patientId),
    deviceId: toText(payload.deviceId),
    measuredAt: toText(payload.measuredAt),
    metrics,
    idempotencyKey: payload.idempotencyKey
  }, 'direct-confirm')
  return normalizeConfirmView(await requestDirect(MFA1_DIRECT_PATH + '/confirm', 'POST', body))
}

module.exports = {
  MFA1_DIRECT_PATH,
  createIdempotencyKey,
  createSession,
  confirmDirect,
  normalizeSessionView,
  normalizeConfirmView
}
