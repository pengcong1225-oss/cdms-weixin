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
    checkinToken: toText(data.checkinToken),
    tokenExpiresAt: toText(data.tokenExpiresAt),
    currentQueueItemId: toId(data.currentQueueItemId),
    currentQueueStatus: toText(data.currentQueueStatus),
    currentDraftId: toId(data.currentDraftId),
    currentDraftStatus: toText(data.currentDraftStatus),
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

async function createStation (payload = {}) {
  return normalizeStation(await api.cdmsRequest('/api/v1/miniapp/scale/stations', 'POST', writePayload(payload, 'station-create'), currentAccessToken()))
}

async function getStation (stationId) {
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}`, 'GET', null, currentAccessToken()))
}

async function createCheckin (stationId, checkinToken, payload = {}) {
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/checkins`, 'POST', writePayload(Object.assign({}, payload, {
    checkinToken: toText(checkinToken)
  }), 'station-checkin'), currentAccessToken()))
}

async function getTodayQueue (stationId) {
  return normalizeQueueList(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/queue`, 'GET', null, currentAccessToken()))
}

async function callNext (stationId, payload = {}) {
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/call-next`, 'POST', writePayload(payload, 'station-next'), currentAccessToken()))
}

async function skipQueueItem (stationId, queueItemId, payload = {}) {
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/queue/${encodeURIComponent(String(queueItemId || ''))}/skip`, 'POST', writePayload(payload, 'station-skip'), currentAccessToken()))
}

async function requeueQueueItem (stationId, queueItemId, payload = {}) {
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/queue/${encodeURIComponent(String(queueItemId || ''))}/requeue`, 'POST', writePayload(payload, 'station-requeue'), currentAccessToken()))
}

async function saveMeasurementDraft (stationId, queueItemId, payload = {}) {
  const body = writePayload({
    idempotencyKey: payload.idempotencyKey,
    deviceId: payload.deviceId,
    measuredAt: payload.measuredAt,
    gender: payload.gender,
    age: payload.age,
    height: payload.height,
    metrics: Array.isArray(payload.metrics) ? payload.metrics.map(normalizeMetric).filter(Boolean) : []
  }, 'station-draft')
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/queue/${encodeURIComponent(String(queueItemId || ''))}/draft`, 'POST', body, currentAccessToken()))
}

async function confirmMeasurement (stationId, queueItemId, draftId, payload = {}) {
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/queue/${encodeURIComponent(String(queueItemId || ''))}/drafts/${encodeURIComponent(String(draftId || ''))}/confirm`, 'POST', writePayload(payload, 'station-confirm'), currentAccessToken()))
}

async function closeStation (stationId, payload = {}) {
  const body = writePayload({
    idempotencyKey: payload.idempotencyKey,
    discardDraftIds: Array.isArray(payload.discardDraftIds) ? payload.discardDraftIds.map(id => toId(id)).filter(Boolean) : []
  }, 'station-close')
  return normalizeStation(await api.cdmsRequest(`/api/v1/miniapp/scale/stations/${encodeURIComponent(String(stationId || ''))}/close`, 'POST', body, currentAccessToken()))
}

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
  callNext,
  closeStation,
  confirmMeasurement,
  createCheckin,
  createIdempotencyKey,
  createStation,
  getStation,
  getTodayQueue,
  normalizeQueueItem,
  normalizeStation,
  requeueQueueItem,
  reduceStationState,
  saveMeasurementDraft,
  skipQueueItem
}
