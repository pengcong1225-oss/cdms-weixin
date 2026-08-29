const api = require('./api')
const runtimeConfig = require('../config/runtime')
const { hmacSha256Hex, sha256Hex } = require('./crypto-lite')

function appContext () {
  const app = typeof getApp === 'function' ? getApp() : null
  return app?.globalData || {}
}

function resolveBaseUrl (context = appContext()) {
  return String(context.iotBaseUrl || runtimeConfig.iotBaseUrl || '').trim()
}

function resolveClientId (context = appContext()) {
  return String(context.acquisitionClientId || runtimeConfig.acquisitionClientId || '').trim()
}

function resolveClientSecret (context = appContext()) {
  return String(context.acquisitionClientSecret || runtimeConfig.acquisitionClientSecret || '').trim()
}

function createNonce () {
  return `nonce-${Date.now()}-${Math.random().toString(16).slice(2, 10)}`
}

function canonicalRequest (method, path, timestamp, nonce, rawBody) {
  return [
    String(method || '').toUpperCase(),
    String(path || ''),
    String(timestamp || ''),
    String(nonce || ''),
    sha256Hex(rawBody || '')
  ].join('\n')
}

function signBody (method, path, body, context = appContext()) {
  const clientId = resolveClientId(context)
  const clientSecret = resolveClientSecret(context)
  if (!clientId) throw new Error('缺少 acquisition clientId 配置')
  if (!clientSecret) throw new Error('缺少 acquisition HMAC 密钥配置')
  const timestamp = String(Date.now())
  const nonce = createNonce()
  const baseBody = Object.assign({}, body || {}, { clientId, timestamp, nonce })
  const rawBody = JSON.stringify(baseBody)
  const signature = hmacSha256Hex(clientSecret, canonicalRequest(method, path, timestamp, nonce, rawBody))
  return {
    rawBody: JSON.stringify(Object.assign({}, baseBody, { signature })),
    signature,
    clientId,
    timestamp,
    nonce
  }
}

function signedHeaders (method, path, context = appContext()) {
  const clientId = resolveClientId(context)
  const clientSecret = resolveClientSecret(context)
  if (!clientId) throw new Error('缺少 acquisition clientId 配置')
  if (!clientSecret) throw new Error('缺少 acquisition HMAC 密钥配置')
  const timestamp = String(Date.now())
  const nonce = createNonce()
  const signature = hmacSha256Hex(clientSecret, canonicalRequest(method, path, timestamp, nonce, ''))
  return {
    'X-CDMS-Client-Id': clientId,
    'X-CDMS-Timestamp': timestamp,
    'X-CDMS-Nonce': nonce,
    'X-CDMS-Signature': signature
  }
}

function normalizeSession (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

function acquisitionUrl (path) {
  const baseUrl = resolveBaseUrl()
  if (!baseUrl) throw new Error('未配置 IoT 服务地址')
  return `${baseUrl}${path}`
}

async function createSession (payload = {}) {
  const { rawBody } = signBody('POST', '/v1/acquisition-sessions', payload)
  return normalizeSession(await api.request(acquisitionUrl('/v1/acquisition-sessions'), 'POST', rawBody, '', {
    'content-type': 'application/json'
  }))
}

async function getSession (sessionId) {
  const path = `/v1/acquisition-sessions/${encodeURIComponent(String(sessionId || ''))}`
  return normalizeSession(await api.request(acquisitionUrl(path), 'GET', null, '', signedHeaders('GET', path)))
}

async function getWssToken (sessionId) {
  const path = `/v1/acquisition-sessions/${encodeURIComponent(String(sessionId || ''))}/wss-token`
  return normalizeSession(await api.request(acquisitionUrl(path), 'POST', null, '', signedHeaders('POST', path)))
}

async function launchSession (sessionId) {
  return getWssToken(sessionId)
}

async function cancelSession (sessionId, reason) {
  const path = `/v1/acquisition-sessions/${encodeURIComponent(String(sessionId || ''))}/cancel`
  const body = reason === undefined || reason === null || String(reason).trim() === ''
    ? null
    : { reason: String(reason) }
  return normalizeSession(await api.request(acquisitionUrl(path), 'POST', body, '', signedHeaders('POST', path)))
}

async function retrySession (sessionId) {
  return launchSession(sessionId)
}

module.exports = {
  acquisitionUrl,
  cancelSession,
  createSession,
  getSession,
  getWssToken,
  launchSession,
  retrySession,
  signedHeaders,
  signBody
}
