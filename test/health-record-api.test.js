const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const healthRecordApiPath = path.join(root, 'miniprogram/utils/health-record-api.js')

// mock wx.request + getApp（与 report-api-contract.test.js 同一模式），
// responses 按请求顺序出队，每个元素为 Result 包裹的业务 body。
function installEnv (responses) {
  const requests = []
  const previous = { getApp: global.getApp, wx: global.wx }
  global.getApp = () => ({ globalData: { cdmsBaseUrl: 'https://cdms.example', accessToken: 'patient-jwt' } })
  global.wx = {
    request: options => {
      requests.push(options)
      const index = requests.length - 1
      const body = index < responses.length ? responses[index] : { code: 200, data: {} }
      options.success && options.success({ statusCode: 200, data: body })
    }
  }
  delete require.cache[apiPath]
  delete require.cache[healthRecordApiPath]
  return {
    requests,
    cleanup () {
      global.getApp = previous.getApp
      global.wx = previous.wx
      delete require.cache[apiPath]
      delete require.cache[healthRecordApiPath]
    }
  }
}

test('getPatient360 hits /360 with bearer token and unwraps data', async () => {
  const env = installEnv([{
    code: 200,
    data: { patientId: 768495013408443, detail: { basicInfo: { name: '张三', gender: 1 }, lungFunction: null }, followups: { list: [], total: 0 }, assessments: [] }
  }])
  try {
    const healthRecordApi = require(healthRecordApiPath)
    const data = await healthRecordApi.getPatient360('768495013408443')
    assert.strictEqual(env.requests.length, 1)
    assert.strictEqual(env.requests[0].method, 'GET')
    assert.strictEqual(env.requests[0].url, 'https://cdms.example/api/v1/patients/768495013408443/360')
    assert.strictEqual(env.requests[0].header.Authorization, 'Bearer patient-jwt')
    assert.strictEqual(data.detail.basicInfo.name, '张三')
    assert.strictEqual(data.detail.lungFunction, null)
    assert.deepStrictEqual(data.assessments, [])
  } finally {
    env.cleanup()
  }
})

test('getMyFollowUps sends page/page_size and normalizes list/records/items', async () => {
  // list 键
  const env = installEnv([{ code: 200, data: { list: [{ id: 11, catScore: 12 }], total: 21 } }])
  let healthRecordApi
  try {
    healthRecordApi = require(healthRecordApiPath)
    const page2 = await healthRecordApi.getMyFollowUps(2, 10)
    assert.strictEqual(env.requests[0].url, 'https://cdms.example/api/v1/followups/my?page=2&page_size=10')
    assert.strictEqual(env.requests[0].method, 'GET')
    assert.deepStrictEqual(page2, { list: [{ id: 11, catScore: 12 }], total: 21 })

    // records 键兼容
    env.requests.length = 0
    env.responsesOverride = null
    const records = await new Promise((resolve, reject) => {
      global.wx.request = options => {
        options.success && options.success({ statusCode: 200, data: { code: 200, data: { records: [{ id: 12 }], total: 3 } } })
      }
      healthRecordApi.getMyFollowUps(1, 10).then(resolve, reject)
    })
    assert.deepStrictEqual(records, { list: [{ id: 12 }], total: 3 })

    // items 键兼容
    const items = await new Promise((resolve, reject) => {
      global.wx.request = options => {
        options.success && options.success({ statusCode: 200, data: { code: 200, data: { items: [{ id: 13 }], total: 1 } } })
      }
      healthRecordApi.getMyFollowUps(1, 10).then(resolve, reject)
    })
    assert.deepStrictEqual(items, { list: [{ id: 13 }], total: 1 })

    // 默认参数 page=1&page_size=10
    env.requests.length = 0
    global.wx.request = options => {
      env.requests.push(options)
      options.success && options.success({ statusCode: 200, data: { code: 200, data: { list: [], total: 0 } } })
    }
    await healthRecordApi.getMyFollowUps()
    assert.strictEqual(env.requests[0].url, 'https://cdms.example/api/v1/followups/my?page=1&page_size=10')

    // 顶层无 data 包裹的分页结构也能识别
    const bare = await new Promise((resolve, reject) => {
      global.wx.request = options => {
        options.success && options.success({ statusCode: 200, data: { list: [{ id: 14 }], total: 5 } })
      }
      healthRecordApi.getMyFollowUps(1, 10).then(resolve, reject)
    })
    assert.deepStrictEqual(bare, { list: [{ id: 14 }], total: 5 })
  } finally {
    env.cleanup()
  }
})

test('getFollowUpDetail hits /followups/{id} and unwraps FollowUpDetailVO', async () => {
  const env = installEnv([{
    code: 200,
    data: { id: 88, patientId: 768495013408443, visitType: 2, visitTypeText: '电话', catAnswers: [1, 2, 3, 4, 5, 6, 7, 8], catScore: 36, medicationComplianceText: '良好' }
  }])
  try {
    const healthRecordApi = require(healthRecordApiPath)
    const detail = await healthRecordApi.getFollowUpDetail('88')
    assert.strictEqual(env.requests.length, 1)
    assert.strictEqual(env.requests[0].method, 'GET')
    assert.strictEqual(env.requests[0].url, 'https://cdms.example/api/v1/followups/88')
    assert.strictEqual(env.requests[0].header.Authorization, 'Bearer patient-jwt')
    assert.strictEqual(detail.id, 88)
    assert.strictEqual(detail.visitTypeText, '电话')
    assert.strictEqual(detail.catScore, 36)
    assert.strictEqual(detail.medicationComplianceText, '良好')
  } finally {
    env.cleanup()
  }
})
