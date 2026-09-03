const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const reportApiPath = path.join(root, 'miniprogram/utils/report-api.js')
const apiPath = path.join(root, 'miniprogram/utils/api.js')

function installEnv () {
  const requests = []
  const previous = { getApp: global.getApp, wx: global.wx }
  global.getApp = () => ({ globalData: { cdmsBaseUrl: 'https://cdms.example', accessToken: 'jwt-token' } })
  global.wx = {
    request: options => {
      requests.push(options)
      const url = String(options.url || '')
      const data = url.includes('/access-url')
        ? { url: 'https://short.example/doc.pdf', expiresInSeconds: 500 }
        : { records: [{ reportId: 9001, reportNo: 'SV-9001' }], page: 2, pageSize: 20 }
      options.success && options.success({ statusCode: 200, data: { code: 200, data } })
    }
  }
  delete require.cache[apiPath]
  delete require.cache[reportApiPath]
  return {
    requests,
    cleanup () {
      global.getApp = previous.getApp
      global.wx = previous.wx
      delete require.cache[apiPath]
      delete require.cache[reportApiPath]
    }
  }
}

test('report api exposes the sunvou-facing endpoints with string ids and clamped expiry', async () => {
  const env = installEnv()
  try {
    const reportApi = require(reportApiPath)
    const list = await reportApi.listPatientReports('768495013408443', { page: 2, pageSize: 20, category: 'SUNVOU' })
    assert.strictEqual(env.requests[0].method, 'GET')
    assert.strictEqual(env.requests[0].url, 'https://cdms.example/api/v1/patients/768495013408443/reports?category=SUNVOU&page=2&pageSize=20')
    assert.deepStrictEqual(list.items.map(item => item.reportId), ['9001'])
    assert.deepStrictEqual(list.list.map(item => item.reportId), ['9001'])

    const url1 = await reportApi.getReportAccessUrl('768495013408443', '9001', { expirySeconds: 999 })
    assert.strictEqual(env.requests[1].method, 'POST')
    assert.strictEqual(env.requests[1].url, 'https://cdms.example/api/v1/patients/768495013408443/reports/9001/access-url?expirySeconds=300&purpose=ACCESS')
    assert.strictEqual(url1.expiresInSeconds, 300)

    const url2 = await reportApi.getFileAccessUrl('768495013408443', 'file-1', { expirySeconds: 60 })
    assert.strictEqual(env.requests[2].url, 'https://cdms.example/api/v1/patients/768495013408443/reports/files/file-1/access-url?expirySeconds=60&purpose=ACCESS')
    assert.strictEqual(url2.url, 'https://short.example/doc.pdf')

    for (const request of env.requests) {
      assert.strictEqual(request.header.Authorization, 'Bearer jwt-token')
    }
  } finally {
    env.cleanup()
  }
})