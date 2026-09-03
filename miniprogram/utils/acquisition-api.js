const api = require('./api')

function normalizeResponse (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

function sessionPath (sessionId) {
  const value = String(sessionId || '').trim()
  if (!value || value.includes('/')) throw new Error('会话 ID 无效')
  return `/api/v1/miniapp/iot/acquisition-sessions/${encodeURIComponent(value)}`
}

function facadeRequest (path, method, data) {
  const app = typeof getApp === 'function' ? getApp() : null
  const token = app?.globalData?.accessToken || ''
  if (!token) throw new Error('登录状态已失效，请重新登录')
  return api.cdmsRequest(path, method, data, token).then(normalizeResponse)
}

async function createSession (payload = {}) {
  return facadeRequest('/api/v1/miniapp/iot/acquisition-sessions', 'POST', {
    businessSessionId: String(payload.businessSessionId || '').trim(),
    orgId: String(payload.orgId || '').trim(),
    patientRef: String(payload.patientRef || '').trim(),
    deviceType: 'MFA1',
    sourceChannel: 'BLE',
    traceId: String(payload.traceId || '').trim(),
    expiresInSeconds: Number(payload.expiresInSeconds || 600)
  })
}

async function getSession (sessionId) {
  return facadeRequest(sessionPath(sessionId), 'GET', null)
}

async function getWssToken (sessionId) {
  return facadeRequest(`${sessionPath(sessionId)}/wss-token`, 'POST', null)
}

async function launchSession (sessionId) {
  return getWssToken(sessionId)
}

async function cancelSession (sessionId, reason) {
  const body = reason === undefined || reason === null || String(reason).trim() === ''
    ? null
    : { reason: String(reason).trim() }
  return facadeRequest(`${sessionPath(sessionId)}/cancel`, 'POST', body)
}

async function retrySession (sessionId) {
  return launchSession(sessionId)
}

module.exports = { cancelSession, createSession, getSession, getWssToken, launchSession, retrySession }
