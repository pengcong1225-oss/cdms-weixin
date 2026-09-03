const qrcode = require('./qrcode-generator')

function createCheckinPayload (stationId, checkinToken) {
  const station = String(stationId || '').trim()
  const token = String(checkinToken || '').trim()
  if (!station || !token) return ''
  return `cdms://scale-checkin?stationId=${encodeURIComponent(station)}&token=${encodeURIComponent(token)}`
}

function parseCheckinPayload (raw) {
  const value = String(raw || '').trim()
  if (!value.startsWith('cdms://scale-checkin?')) return null
  const query = value.slice(value.indexOf('?') + 1)
  const params = {}
  query.split('&').forEach(pair => {
    const index = pair.indexOf('=')
    if (index < 1) return
    const key = decodeURIComponent(pair.slice(0, index))
    params[key] = decodeURIComponent(pair.slice(index + 1))
  })
  if (!params.stationId || !params.token || params.patientId || params.orgId) return null
  return { stationId: String(params.stationId), checkinToken: String(params.token) }
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

module.exports = { buildQrMatrix, createCheckinPayload, drawQr, parseCheckinPayload }
