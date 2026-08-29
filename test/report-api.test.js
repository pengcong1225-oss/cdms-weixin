const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const reportApiPath = path.join(root, 'miniprogram/utils/report-api.js')

function createRequestSpy (responses = []) {
  const calls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  return {
    calls,
    async cdmsRequest (url, method, data, token) {
      calls.push({ url, method, data, token })
      const response = queue.length ? queue.shift() : { data: null }
      if (response instanceof Error) throw response
      return response
    }
  }
}

function loadReportApi (spy) {
  delete require.cache[apiPath]
  delete require.cache[reportApiPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: { cdmsRequest: spy.cdmsRequest.bind(spy) }
  }
  global.getApp = () => ({
    globalData: {
      accessToken: 'access-1',
      cdmsBaseUrl: 'https://cdms.example'
    }
  })
  return require(reportApiPath)
}

test('report access urls never enter route query or storage', async () => {
  const spy = createRequestSpy([
    { data: { items: [{ reportId: 9001, patientId: 768495013408443, category: 'RING', fileObjectKey: 'reports/ring/9001.pdf', downloadAvailable: true }], page: 1, pageSize: 10, nextCursor: 'cursor-1', hasMore: true } },
    { data: { url: 'https://short.example/report.pdf', expiresInSeconds: 600 } },
    { data: { url: 'https://short.example/file.png', expiresInSeconds: 15 } }
  ])
  const { listPatientReports, getReportAccessUrl, getFileAccessUrl, buildReportRoute } = loadReportApi(spy)

  const list = await listPatientReports('768495013408443', { category: 'RING', cursor: 'cursor-0', page: 1, pageSize: 10 })
  const reportUrl = await getReportAccessUrl('768495013408443', '9001')
  const fileUrl = await getFileAccessUrl('768495013408443', 'file-1', { expirySeconds: 15 })
  const route = buildReportRoute({ patientId: '768495013408443', reportId: '9001' })

  assert.strictEqual(spy.calls[0].url, '/api/v1/patients/768495013408443/reports?category=RING&cursor=cursor-0&page=1&pageSize=10')
  assert.strictEqual(spy.calls[1].url, '/api/v1/patients/768495013408443/reports/9001/access-url?expirySeconds=300&purpose=ACCESS')
  assert.strictEqual(spy.calls[2].url, '/api/v1/patients/768495013408443/reports/files/file-1/access-url?expirySeconds=15&purpose=ACCESS')
  assert.strictEqual(list.items[0].reportId, '9001')
  assert.strictEqual(list.items[0].patientId, '768495013408443')
  assert.strictEqual(reportUrl.url, 'https://short.example/report.pdf')
  assert.strictEqual(reportUrl.expiresInSeconds, 300)
  assert.strictEqual(fileUrl.url, 'https://short.example/file.png')
  assert.strictEqual(route.includes('accessUrl'), false)
  assert.strictEqual(route.includes('token'), false)
  assert.strictEqual(route.includes('reportId=9001'), true)
  assert.strictEqual(route.includes('patientId=768495013408443'), true)
})

test('ai report endpoints keep confirm body minimal and preserve string ids', async () => {
  const spy = createRequestSpy([
    { data: { reportId: 9101, patientId: '768495013408443', orgId: '1972545374712086529', reportType: 1, markdownContent: '# patient', doctorConfirmed: 0 } },
    { data: { reportId: 9102, patientId: '768495013408443', orgId: '1972545374712086529', reportType: 1, markdownContent: '# generated patient', doctorConfirmed: 0 } },
    { data: { reportId: 9201, patientId: '768495013408443', orgId: '1972545374712086529', reportType: 2, period: '2026-08', markdownContent: '# org', doctorConfirmed: 0 } },
    { data: { reportId: 9202, patientId: '768495013408443', orgId: '1972545374712086529', reportType: 2, period: '2026-08', markdownContent: '# generated org', doctorConfirmed: 0 } },
    { data: { reportId: 9202, patientId: '768495013408443', orgId: '1972545374712086529', reportType: 2, period: '2026-08', markdownContent: '# generated org', doctorConfirmed: 1, doctorRemark: '确认通过' } }
  ])
  const { getAiReport, generatePatientAiReport, getOrgAiReport, generateOrgAiReport, confirmAiReport } = loadReportApi(spy)

  const patientReport = await getAiReport('768495013408443')
  const patientGenerated = await generatePatientAiReport('768495013408443')
  const orgReport = await getOrgAiReport('1972545374712086529', '2026-08')
  const orgGenerated = await generateOrgAiReport('1972545374712086529', '2026-08')
  const confirmed = await confirmAiReport('9202', { confirmed: true, doctorRemark: '确认通过', ignored: 'value' })

  assert.strictEqual(spy.calls[0].url, '/api/v1/ai/report/patient/768495013408443')
  assert.strictEqual(spy.calls[1].url, '/api/v1/ai/report/patient/768495013408443/stream')
  assert.strictEqual(spy.calls[2].url, '/api/v1/ai/report/org/1972545374712086529?period=2026-08')
  assert.strictEqual(spy.calls[3].url, '/api/v1/ai/report/org/1972545374712086529/stream?period=2026-08')
  assert.strictEqual(spy.calls[4].url, '/api/v1/ai/report/9202/confirm')
  assert.deepStrictEqual(spy.calls[4].data, { confirmed: true, doctorRemark: '确认通过' })
  assert.strictEqual(patientReport.reportId, '9101')
  assert.strictEqual(patientGenerated.reportId, '9102')
  assert.strictEqual(orgReport.orgId, '1972545374712086529')
  assert.strictEqual(orgGenerated.reportId, '9202')
  assert.strictEqual(confirmed.doctorConfirmed, 1)
  assert.strictEqual(confirmed.doctorRemark, '确认通过')
})
