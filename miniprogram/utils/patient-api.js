const api = require('./api')

function accessToken () {
  try { return getApp()?.globalData?.accessToken || '' } catch (_) { return '' }
}

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
    normalized[key] = isIdKey(key) && item != null && item !== ''
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

function safeKeyword (keyword) {
  const text = String(keyword || '').trim()
  if (/^1\d{10}$/.test(text)) return ''
  if (/^\d{15}$/.test(text) || /^\d{17}[\dXx]$/.test(text)) return ''
  return text
}

async function listPatients (params = {}) {
  const { page = 1, pageSize = 20, keyword = '', orgId } = params
  const pairs = [
    ['page', page],
    ['pageSize', pageSize],
    ['keyword', safeKeyword(keyword)],
    ['orgId', orgId]
  ]
  if (Array.isArray(params.riskLevels)) params.riskLevels.forEach(level => pairs.push(['riskLevels', level]))
  pairs.push(['visitStatus', params.visitStatus])
  pairs.push(['upcoming', params.upcoming])
  pairs.push(['attentionLevel', params.attentionLevel])
  pairs.push(['attentionOnly', params.attentionOnly])
  const query = queryString(pairs)
  const data = normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/patients${query}`, 'GET', null, accessToken())))
  const list = Array.isArray(data?.list) ? data.list : Array.isArray(data?.records) ? data.records : Array.isArray(data?.items) ? data.items : []
  return Object.assign({ list: [], total: list.length, page, pageSize }, data || {}, { list })
}

async function getPatient (patientId) {
  const id = encodeURIComponent(String(patientId || ''))
  return normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/patients/${id}`, 'GET', null, accessToken())))
}

async function getPatient360 (patientId) {
  const id = encodeURIComponent(String(patientId || ''))
  return normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/patients/${id}/360`, 'GET', null, accessToken())))
}

async function checkDuplicate (payload, excludeId) {
  const basicInfo = payload && payload.basicInfo ? payload.basicInfo : payload
  const query = queryString([['excludeId', excludeId]])
  return normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/patients/duplicate-check${query}`, 'POST', normalizeIds(basicInfo || {}), accessToken())))
}

async function createPatient (payload) {
  return normalizeIds(unwrap(await api.cdmsRequest('/api/v1/patients', 'POST', normalizeIds(payload || {}), accessToken())))
}

async function updatePatient (patientId, payload) {
  const id = String(patientId || '')
  const response = unwrap(await api.cdmsRequest(`/api/v1/patients/${encodeURIComponent(id)}`, 'PUT', normalizeIds(payload || {}), accessToken()))
  return normalizeIds(response || Object.assign({ id }, payload || {}))
}

async function deletePatient (patientId) {
  const id = encodeURIComponent(String(patientId || ''))
  await api.cdmsRequest(`/api/v1/patients/${id}`, 'DELETE', null, accessToken())
}

function flattenOrganizations (items) {
  const result = []
  ;(items || []).forEach(item => {
    if (!item) return
    result.push(normalizeIds({ id: item.id, name: item.name, pId: item.pId }))
    if (Array.isArray(item.children)) result.push(...flattenOrganizations(item.children))
  })
  return result
}

async function listOrganizations ({ keyword = '' } = {}) {
  const text = String(keyword || '').trim()
  const path = text
    ? `/api/v1/org/search${queryString([['keyword', text]])}`
    : '/api/v1/org/tree'
  return flattenOrganizations(normalizeIds(unwrap(await api.cdmsRequest(path, 'GET', null, accessToken()))))
}

module.exports = {
  listPatients,
  getPatient,
  getPatient360,
  checkDuplicate,
  createPatient,
  updatePatient,
  deletePatient,
  listOrganizations,
  normalizeIds
}
