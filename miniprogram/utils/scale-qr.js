const qrcode = require('./qrcode-generator')

const CHECKIN_PREFIX = 'cdms://checkin?'
const SCALE_CHECKIN_PREFIX = 'cdms://scale-checkin?'

// 场次签到码（医生工作台生成，保持原输出不变，医生端 device-scale/device-mfa1 依赖）
function createCheckinPayload (stationId, checkinToken) {
  const station = String(stationId || '').trim()
  const token = String(checkinToken || '').trim()
  if (!station || !token) return ''
  return `cdms://scale-checkin?stationId=${encodeURIComponent(station)}&token=${encodeURIComponent(token)}`
}

// 通用签到码：机构/医生可为患者生成，患者扫码后走通用签到接口
function createGenericCheckinPayload (orgId) {
  const org = String(orgId || '').trim()
  if (!org) return ''
  return `cdms://checkin?orgId=${encodeURIComponent(org)}`
}

function parseQueryParams (query) {
  const params = {}
  query.split('&').forEach(pair => {
    const index = pair.indexOf('=')
    if (index < 1) return
    const key = decodeURIComponent(pair.slice(0, index))
    params[key] = decodeURIComponent(pair.slice(index + 1))
  })
  return params
}

// 泛化扫码签到解析：
// - 同时识别 'cdms://checkin?'（通用签到）与 'cdms://scale-checkin?'（场次老码）；
// - 携带 stationId 与 token → 场次签到 {kind:'STATION'}；
// - 其余协议内载荷（如仅 orgId 或空参数）→ 通用签到 {kind:'GENERIC'}；
// - 协议头不匹配返回 null（由调用方提示“请扫描 CDMS 签到二维码”）。
function parseCheckinPayload (raw) {
  const value = String(raw || '').trim()
  if (!value.startsWith(CHECKIN_PREFIX) && !value.startsWith(SCALE_CHECKIN_PREFIX)) return null
  const query = value.slice(value.indexOf('?') + 1)
  const params = parseQueryParams(query)
  if (params.stationId && params.token) {
    return { stationId: String(params.stationId), checkinToken: String(params.token), kind: 'STATION' }
  }
  return { kind: 'GENERIC', params }
}

function buildQrMatrix (payload) {
  const qr = qrcode(0, 'M')
  qr.addData(String(payload || ''), 'Byte')
  qr.make()
  const size = qr.getModuleCount()
  const matrix = []
  for (let row = 0; row < size; row += 1) {
    const line = []
    for (let column = 0; column < size; column += 1) line.push(qr.isDark(row, column))
    matrix.push(line)
  }
  return matrix
}

function drawQr (context, matrix, options = {}) {
  if (!context || !Array.isArray(matrix) || !matrix.length) return
  const canvasSize = Number(options.size) || 240
  const quiet = Number(options.quiet) || 4
  const moduleCount = matrix.length
  const cell = canvasSize / (moduleCount + quiet * 2)
  context.setFillStyle(options.background || '#ffffff')
  context.fillRect(0, 0, canvasSize, canvasSize)
  context.setFillStyle(options.foreground || '#14352b')
  matrix.forEach((line, row) => line.forEach((dark, column) => {
    if (dark) context.fillRect((column + quiet) * cell, (row + quiet) * cell, cell + 0.4, cell + 0.4)
  }))
  context.draw()
}

module.exports = { buildQrMatrix, createCheckinPayload, createGenericCheckinPayload, drawQr, parseCheckinPayload }
