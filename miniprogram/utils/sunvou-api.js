const reportApi = require('./report-api')

function appContext () {
  const app = typeof getApp === 'function' ? getApp() : null
  return app?.globalData || {}
}

function currentPatientId (params = {}) {
  return String(params.patientId || appContext().patientRef || appContext().patientId || '').trim()
}

function normalizeIds (value) {
  if (Array.isArray(value)) return value.map(normalizeIds)
  if (!value || typeof value !== 'object') return value
  const normalized = {}
  Object.keys(value).forEach(key => {
    const item = value[key]
    normalized[key] = (key === 'id' || key === 'pId' || /Id$/.test(key) || /Ref$/.test(key)) && item !== null && item !== undefined && item !== ''
      ? String(item)
      : normalizeIds(item)
  })
  return normalized
}

function normalizeList (response) {
  const rawData = response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
  const data = normalizeIds(rawData)
  const items = Array.isArray(data?.items)
    ? data.items
    : Array.isArray(data?.list)
      ? data.list
      : Array.isArray(data?.records)
        ? data.records
        : []
  return Object.assign({}, data, { items, list: items })
}

async function listReports (params = {}) {
  const patientId = currentPatientId(params)
  if (!patientId) throw new Error('请选择患者后再查看报告')
  const response = await reportApi.listPatientReports(patientId, params)
  return normalizeList(response)
}

async function getReport (reportId, params = {}) {
  const response = await listReports(Object.assign({}, params, { pageSize: params.pageSize || 50 }))
  const report = (response.items || []).find(item => String(item.reportId || item.id || '') === String(reportId || ''))
  return report || null
}

async function getReportAccessUrl (reportId, params = {}) {
  const patientId = currentPatientId(params)
  if (!patientId) throw new Error('请选择患者后再查看报告')
  return reportApi.getReportAccessUrl(patientId, reportId, params)
}

async function getFileAccessUrl (fileId, params = {}) {
  const patientId = currentPatientId(params)
  if (!patientId) throw new Error('请选择患者后再查看报告')
  return reportApi.getFileAccessUrl(patientId, fileId, params)
}

module.exports = {
  getFileAccessUrl,
  getReport,
  getReportAccessUrl,
  listReports,
  normalizeList
}
