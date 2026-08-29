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

function clampExpiry (value) {
  const numeric = Number(value || 300)
  if (!Number.isFinite(numeric)) return 300
  return Math.max(1, Math.min(300, Math.floor(numeric)))
}

function normalizeReportList (response) {
  const data = normalizeIds(unwrap(response)) || {}
  const items = Array.isArray(data.items)
    ? data.items
    : Array.isArray(data.list)
      ? data.list
      : Array.isArray(data.records)
        ? data.records
        : []
  return Object.assign({ items: [], list: [], total: items.length, page: 1, pageSize: items.length }, data, { items, list: items })
}

function normalizeReportUrl (response) {
  const data = normalizeIds(unwrap(response)) || {}
  return {
    url: String(data.url || ''),
    expiresInSeconds: clampExpiry(data.expiresInSeconds)
  }
}

function normalizeAiReport (response) {
  return normalizeIds(unwrap(response))
}

async function listPatientReports (patientId, params = {}) {
  const query = queryString([
    ['category', params.category],
    ['cursor', params.cursor],
    ['page', params.page || 1],
    ['pageSize', params.pageSize || 20]
  ])
  return normalizeReportList(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId || ''))}/reports${query}`, 'GET', null, currentAccessToken()))
}

async function getReportAccessUrl (patientId, reportId, params = {}) {
  const query = queryString([
    ['expirySeconds', clampExpiry(params.expirySeconds)],
    ['purpose', params.purpose || 'ACCESS']
  ])
  return normalizeReportUrl(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId || ''))}/reports/${encodeURIComponent(String(reportId || ''))}/access-url${query}`, 'POST', null, currentAccessToken()))
}

async function getFileAccessUrl (patientId, fileId, params = {}) {
  const query = queryString([
    ['expirySeconds', clampExpiry(params.expirySeconds)],
    ['purpose', params.purpose || 'ACCESS']
  ])
  return normalizeReportUrl(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(String(patientId || ''))}/reports/files/${encodeURIComponent(String(fileId || ''))}/access-url${query}`, 'POST', null, currentAccessToken()))
}

async function getAiReport (patientId) {
  return normalizeAiReport(await api.cdmsRequest(`/api/v1/ai/report/patient/${encodeURIComponent(String(patientId || ''))}`, 'GET', null, currentAccessToken()))
}

async function generatePatientAiReport (patientId) {
  return normalizeAiReport(await api.cdmsRequest(`/api/v1/ai/report/patient/${encodeURIComponent(String(patientId || ''))}/stream`, 'POST', null, currentAccessToken()))
}

async function getOrgAiReport (orgId, period) {
  const query = queryString([['period', period]])
  return normalizeAiReport(await api.cdmsRequest(`/api/v1/ai/report/org/${encodeURIComponent(String(orgId || ''))}${query}`, 'GET', null, currentAccessToken()))
}

async function generateOrgAiReport (orgId, period) {
  const query = queryString([['period', period]])
  return normalizeAiReport(await api.cdmsRequest(`/api/v1/ai/report/org/${encodeURIComponent(String(orgId || ''))}/stream${query}`, 'POST', null, currentAccessToken()))
}

async function confirmAiReport (reportId, body = {}) {
  return normalizeAiReport(await api.cdmsRequest(`/api/v1/ai/report/${encodeURIComponent(String(reportId || ''))}/confirm`, 'POST', {
    confirmed: Boolean(body.confirmed),
    doctorRemark: body.doctorRemark === undefined || body.doctorRemark === null ? '' : String(body.doctorRemark)
  }, currentAccessToken()))
}

function buildReportRoute ({ reportId }) {
  const query = queryString([
    ['reportId', reportId]
  ])
  return `/pages/reports/detail${query}`
}

module.exports = {
  buildReportRoute,
  confirmAiReport,
  generateOrgAiReport,
  generatePatientAiReport,
  getAiReport,
  getFileAccessUrl,
  getOrgAiReport,
  getReportAccessUrl,
  listPatientReports,
  normalizeIds
}
