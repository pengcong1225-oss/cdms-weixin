// 建档问卷接口：复用 cdmsManager 既有 H5 筛查问卷的匿名端点
// （机构列表 → 签发一次性 token → 提交，服务端 matchOrCreate 即建档）。
// 走 managerBaseUrl（https://.../cdmsmanagerapi/api/v1），不依赖小程序登录态。
const { request } = require('./api')

function baseUrl () {
  let base = ''
  try {
    const app = typeof getApp === 'function' ? getApp() : null
    base = String((app && app.globalData && app.globalData.managerBaseUrl) || '')
  } catch (_) {
    base = ''
  }
  return base.replace(/\/+$/, '')
}

// cdmsManager 统一用 HTTP 200 + body.code 表达业务错误（如身份证重复、token 失效），
// api.request 只按 HTTP 状态判定成功，这里补一层业务码检查，否则失败会被当成成功。
function call (path, method, data) {
  const base = baseUrl()
  if (!base) return Promise.reject(new Error('未配置管理端服务地址'))
  return request(base + path, method, data, '').then(response => {
    const code = Number(response && response.code)
    if (Number.isFinite(code) && code !== 200) {
      throw new Error((response && response.message) || '请求失败，请稍后重试')
    }
    return response
  })
}

function listOrganizations () {
  return call('/screening/h5/organizations', 'GET')
}

function listQuestions () {
  return call('/screening/h5/questions', 'GET')
}

// 选定机构后签发短期一次性 token：提交时服务端据此派生机构，不信任裸 orgId。
function issueToken (orgId) {
  return call('/screening/h5/token?orgId=' + encodeURIComponent(String(orgId == null ? '' : orgId)), 'POST', null)
}

function submit (payload) {
  return call('/screening/h5/submit', 'POST', payload)
}

module.exports = { listOrganizations, listQuestions, issueToken, submit }
