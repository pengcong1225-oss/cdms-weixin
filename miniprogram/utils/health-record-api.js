// 健康档案接口封装：患者 360 档案 / 我的随访列表 / 随访详情。
// 统一走 cdmsRequest（自带 401 刷新重试），token 取 getApp().globalData.accessToken，
// 返回值统一 unwrap data，调用方直接拿到业务数据。
const api = require('./api')

function unwrapData (response) {
  return response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')
    ? response.data
    : response
}

function accessToken () {
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    return (app && app.globalData && app.globalData.accessToken) || ''
  } catch (_) {
    return ''
  }
}

// 分页 Map 结构兼容：list / records / items 三种键名都识别，统一返回 { list, total }
function normalizePage (payload) {
  const data = unwrapData(payload)
  const rawList = data && (data.list || data.records || data.items)
  const list = Array.isArray(rawList) ? rawList : []
  const total = data && data.total !== undefined && data.total !== null
    ? Number(data.total) || 0
    : list.length
  return { list, total }
}

// 患者 360 档案（患者端后端校验只能查本人）：
// 返回 { patientId, detail: { basicInfo, lungFunction, copdInfo, riskInfo, orgInfo, followupSummary, ... }, followups, assessments, ... }
async function getPatient360 (patientId) {
  const path = '/api/v1/patients/' + encodeURIComponent(String(patientId)) + '/360'
  return unwrapData(await api.cdmsRequest(path, 'GET', null, accessToken()))
}

// 我的随访记录（患者端按 JWT patientId 隔离），page 从 1 开始：返回 { list, total }
async function getMyFollowUps (page, pageSize) {
  const safePage = Math.max(1, Number(page) || 1)
  const safePageSize = Math.max(1, Number(pageSize) || 10)
  const path = '/api/v1/followups/my?page=' + safePage + '&page_size=' + safePageSize
  return normalizePage(await api.cdmsRequest(path, 'GET', null, accessToken()))
}

// 随访详情：返回 FollowUpDetailVO（visitDate/visitTypeText/catAnswers/catScore/mmrcGradeText/medicationComplianceText 等）
async function getFollowUpDetail (id) {
  const path = '/api/v1/followups/' + encodeURIComponent(String(id))
  return unwrapData(await api.cdmsRequest(path, 'GET', null, accessToken()))
}

module.exports = { getPatient360, getMyFollowUps, getFollowUpDetail }
