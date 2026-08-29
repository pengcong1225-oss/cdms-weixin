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

async function listMessages (params = {}) {
  const query = queryString([
    ['page', params.page || 1],
    ['pageSize', params.pageSize || 20]
  ])
  return normalizeIds(unwrap(await api.cdmsRequest(`/api/v1/messages${query}`, 'GET', null, currentAccessToken())))
}

async function getUnreadCount () {
  return normalizeIds(unwrap(await api.cdmsRequest('/api/v1/messages/unread-count', 'GET', null, currentAccessToken())))
}

async function markMessageRead (id) {
  const messageId = encodeURIComponent(String(id || ''))
  await api.cdmsRequest(`/api/v1/messages/${messageId}/read`, 'POST', null, currentAccessToken())
}

async function markAllMessagesRead () {
  await api.cdmsRequest('/api/v1/messages/read-all', 'POST', null, currentAccessToken())
}

module.exports = {
  getUnreadCount,
  listMessages,
  markAllMessagesRead,
  markMessageRead,
  normalizeIds
}
