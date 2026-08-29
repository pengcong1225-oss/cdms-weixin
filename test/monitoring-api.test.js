const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const monitoringApiPath = path.join(root, 'miniprogram/utils/monitoring-api.js')

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

function loadMonitoringApi (spy) {
  delete require.cache[apiPath]
  delete require.cache[monitoringApiPath]
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
  return require(monitoringApiPath)
}

test('monitoring APIs normalize ids and keep acknowledge requests scoped', async () => {
  const spy = createRequestSpy([
    { data: { patientId: 768495013408443, attentionLevel: 2, attentionLevelText: '高危', primaryAlertType: '血氧', primaryAlertValue: 91.2, primaryAlertUnit: '%', activeAlertCount: 2 } },
    { data: { patientId: 768495013408443, rangeDays: 30, bloodOxygen: [{ date: '2026-08-29', value: 91.2, unit: '%' }], heartRate: [{ date: '2026-08-29', value: 72, unit: 'bpm' }], steps: [], sleepDuration: [] } },
    { data: { records: [{ id: 9001, patientId: 768495013408443, alertType: '血氧下降', alertValue: 91, alertUnit: '%', level: 3, levelText: '高危', active: 1 }], page: 1, pageSize: 20, total: 1 } },
    { data: null }
  ])
  const { getMonitoringSummary, getMonitoringTrends, getMonitoringAlerts, acknowledgeAlert } = loadMonitoringApi(spy)

  const summary = await getMonitoringSummary('768495013408443')
  const trends = await getMonitoringTrends('768495013408443', { range: '30d' })
  const alerts = await getMonitoringAlerts('768495013408443', { page: 1, pageSize: 20 })
  await acknowledgeAlert('9001')

  assert.strictEqual(spy.calls[0].url, '/api/v1/patients/768495013408443/monitoring/summary')
  assert.strictEqual(spy.calls[1].url, '/api/v1/patients/768495013408443/monitoring/trends?range=30d')
  assert.strictEqual(spy.calls[2].url, '/api/v1/patients/768495013408443/monitoring/alerts?page=1&pageSize=20')
  assert.strictEqual(spy.calls[3].url, '/api/v1/monitoring/alerts/9001/acknowledge')
  assert.strictEqual(summary.patientId, '768495013408443')
  assert.strictEqual(summary.attentionLevel, 2)
  assert.strictEqual(trends.patientId, '768495013408443')
  assert.strictEqual(trends.bloodOxygen[0].date, '2026-08-29')
  assert.strictEqual(alerts.list[0].id, '9001')
  assert.strictEqual(alerts.list[0].patientId, '768495013408443')
})

