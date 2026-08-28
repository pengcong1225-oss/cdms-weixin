const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const matrixPath = path.join(__dirname, '..', 'docs', 'superpowers', 'contracts', '2026-08-28-miniapp-api-matrix.md')

function readMatrix () {
  return fs.readFileSync(matrixPath, 'utf8')
}

function expectIncludes (source, expected) {
  assert.ok(
    source.includes(expected),
    `expected contract matrix to include: ${expected}`
  )
}

test('documents H5 to native replacement routes', () => {
  const matrix = readMatrix()
  ;[
    '/h5/patients -> /pages/doctor/workspace/index',
    '/h5/followups -> /pages/followups/index',
    'PatientDetail -> /pages/patient-detail/index',
    'Patient360 -> /pages/patient-360/index',
    'MonitoringDetail -> /pages/monitoring/index',
    'Messages -> /pages/messages/index',
    'Statistics -> /pages/statistics/index',
    'History/Reports -> /pages/reports/index',
    '体脂秤工作站 -> /pages/device-scale/station/index'
  ].forEach(item => expectIncludes(matrix, item))
})

test('documents required miniapp and iot contract baselines plus server gaps', () => {
  const matrix = readMatrix()
  ;[
    'POST /api/v1/miniapp/auth/login',
    'POST /api/v1/miniapp/auth/doctor-login',
    'POST /api/v1/miniapp/auth/switch-role',
    'POST /api/v1/miniapp/auth/refresh',
    'POST /api/v1/miniapp/auth/logout',
    'GET /api/v1/miniapp/auth/me',
    'GET /api/v1/patients',
    'GET /api/v1/patients/{id}',
    'POST /api/v1/patients',
    'PUT /api/v1/patients/{id}',
    'DELETE /api/v1/patients/{id}',
    'POST /api/v1/patients/duplicate-check',
    'GET /api/v1/patients/{patientId}/followups',
    'GET /api/v1/followups/{id}',
    'GET /api/v1/followups/my',
    'POST /api/v1/followups',
    'POST /api/v1/followups/draft',
    'PUT /api/v1/followups/{id}',
    'DELETE /api/v1/followups/{id}',
    'GET /api/v1/patients/{patientId}/360',
    'GET /api/v1/patients/{patientId}/monitoring/summary',
    'GET /api/v1/patients/{patientId}/monitoring/trends',
    'GET /api/v1/patients/{patientId}/monitoring/alerts',
    'POST /api/v1/monitoring/alerts/{alertId}/acknowledge',
    'GET /api/v1/messages',
    'GET /api/v1/messages/unread-count',
    'POST /api/v1/messages/{id}/read',
    'POST /api/v1/messages/read-all',
    'GET /api/v1/stats/home',
    'GET /api/v1/stats/detail',
    'GET /api/v1/stats/my-followups',
    'GET /api/v1/stats/my',
    'GET /api/v1/patients/{patientId}/reports',
    'POST /api/v1/patients/{patientId}/reports/{reportId}/access-url',
    'POST /api/v1/patients/{patientId}/reports/files/{fileId}/access-url',
    'GET /api/v1/ai/report/patient/{patientId}',
    'POST /api/v1/ai/report/patient/{patientId}/stream',
    'GET /api/v1/ai/report/org/{orgId}',
    'POST /api/v1/ai/report/org/{orgId}/stream',
    'POST /api/v1/ai/report/{reportId}/confirm',
    'POST /api/v1/miniapp/iot/wearable-session',
    'DELETE /api/v1/miniapp/iot/wearable-session',
    'POST /api/v1/miniapp/iot/scale/measurements',
    'POST /v1/wearable-sessions',
    'POST /v1/wearable-upload-batches',
    'GET /v1/measurements',
    'POST /v1/acquisition-sessions',
    'GET /v1/acquisition-sessions/{sessionId}',
    'GET /v1/reports',
    'GET /api/v1/screening/h5/questions',
    'GET /api/v1/screening/h5/organizations',
    'POST /api/v1/screening/h5/submit',
    'cdmsManager',
    'ScreeningController.java',
    'POST /api/v1/checkins?patientId=...',
    '不满足扫码后由令牌派生患者身份的要求',
    '受保护的 /api/v1/miniapp/scale/stations* 契约缺口',
    'MiniappScaleStationController.java',
    'Task 7 才能接入小程序'
  ].forEach(item => expectIncludes(matrix, item))
})

test('locks string ids, auth session semantics, screening rules and report URL lifecycle', () => {
  const payload = { patientId: '768495013408443', orgId: '1972545374712086529', reportId: '9001', sessionId: 'session-1' }
  assert.equal(typeof payload.patientId, 'string')
  assert.equal(typeof payload.orgId, 'string')
  assert.equal(typeof payload.reportId, 'string')
  assert.equal(typeof payload.sessionId, 'string')
  assert.equal(encodeURIComponent(payload.patientId), '768495013408443')

  const matrix = readMatrix()
  ;[
    '所有路径参数和请求体中的患者、机构、任务、报告、设备会话 ID 均使用 String',
    '机构 ID 以字符串传输，避免 19 位雪花 ID 在前端精度丢失',
    '脱敏',
    '403',
    '400',
    'Refresh Token survives network, timeout and 5xx',
    'concurrent 401 uses one single-flight refresh',
    'each request retries once',
    'role switch preserves account session while clearing role/device context',
    'POST /api/v1/miniapp/auth/refresh',
    'POST /api/v1/miniapp/auth/switch-role',
    '7 题 COPD-SQ',
    'totalScore >= 16',
    '启用机构选择',
    '提交时机构状态校验',
    'GET /api/v1/screening/h5/questions',
    'GET /api/v1/screening/h5/organizations',
    'POST /api/v1/screening/h5/submit',
    'expiresInSeconds',
    '1-300 秒',
    '短时地址只在当前内存中使用',
    '不得写入 URL、Storage、日志、埋点或剪贴板'
  ].forEach(item => expectIncludes(matrix, item))
})
