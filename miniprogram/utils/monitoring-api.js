const api = require('./api')

function unwrap (response) {
  if (response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')) {
    return response.data
  }
  return response
}

function isIdKey (key) {
  return key === 'id' || key === 'pId' || /Id$/.test(key) || /Ref$/.test(key)
}

function normalizeIds (value) {
  if (Array.isArray(value)) return value.map(normalizeIds)
  if (!value || typeof value !== 'object') return value
  const normalized = {}
  Object.keys(value).forEach(key => {
    const item = value[key]
    normalized[key] = isIdKey(key) && item !== null && item !== undefined && item !== ''
      ? String(item)
      : normalizeIds(item)
  })
  return normalized
}

function queryString (pairs) {
  const items = pairs
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return items.length ? `?${items.join('&')}` : ''
}

function currentAccessToken () {
  try {
    return getApp()?.globalData?.accessToken || ''
  } catch (_) {
    return ''
  }
}

function normalizeTrendSeries (series) {
  return (Array.isArray(series) ? series : []).map(point => normalizeIds(point))
}

function normalizeAlertsPage (response) {
  const data = normalizeIds(unwrap(response)) || {}
  const list = Array.isArray(data.list)
    ? data.list
    : Array.isArray(data.records)
      ? data.records
      : Array.isArray(data.items)
        ? data.items
        : []
  return Object.assign({ list: [], page: 1, pageSize: list.length, total: list.length }, data, { list })
}

async function getMonitoringSummary (patientId) {
  return normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId || ''))}/monitoring/summary`, 'GET', null, currentAccessToken())))
}

async function getMonitoringTrends (patientId, params = {}) {
  const query = queryString([['range', params.range || '7d']])
  const response = normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId || ''))}/monitoring/trends${query}`, 'GET', null, currentAccessToken())))
  if (!response || typeof response !== 'object') return response
  return Object.assign({}, response, {
    bloodOxygen: normalizeTrendSeries(response.bloodOxygen),
    heartRate: normalizeTrendSeries(response.heartRate),
    steps: normalizeTrendSeries(response.steps),
    sleepDuration: normalizeTrendSeries(response.sleepDuration)
  })
}

async function getMonitoringAlerts (patientId, params = {}) {
  const query = queryString([
    ['page', params.page || 1],
    ['pageSize', params.pageSize || 20]
  ])
  return normalizeAlertsPage(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId || ''))}/monitoring/alerts${query}`, 'GET', null, currentAccessToken()))
}

async function acknowledgeAlert (alertId) {
  const id = encodeURIComponent(String(alertId || ''))
  await api.cdmsRequest(`/api/v1/monitoring/alerts/${id}/acknowledge`, 'POST', null, currentAccessToken())
}

module.exports = {
  acknowledgeAlert,
  getMonitoringAlerts,
  getMonitoringSummary,
  getMonitoringTrends,
  normalizeIds
}

