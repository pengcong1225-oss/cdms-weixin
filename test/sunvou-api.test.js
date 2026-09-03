const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const sunvouApiPath = path.join(root, 'miniprogram/utils/sunvou-api.js')
const reportApiPath = path.join(root, 'miniprogram/utils/report-api.js')

function installEnv (session = {}) {
  const calls = []
  const previous = {
    getApp: global.getApp
  }
  global.getApp = () => ({
    globalData: Object.assign({
      activeRole: 'DOCTOR',
      patientRef: '768495013408443',
      patientId: '768495013408443'
    }, session)
  })
  delete require.cache[sunvouApiPath]
  delete require.cache[reportApiPath]
  return {
    calls,
    cleanup () {
      global.getApp = previous.getApp
      delete require.cache[sunvouApiPath]
      delete require.cache[reportApiPath]
    }
  }
}

test('sunvou api normalizes report lists and resolves the current patient context', async () => {
  const env = installEnv()
  try {
    const stub = {
      listPatientReports: async (patientId, params) => {
        env.calls.push(['list', patientId, params])
        return {
          records: [
            { reportId: 9001, patientId, reportNo: 'SV-9001', category: 'SUNVOU', fileId: 'file-1' }
          ],
          page: params.page || 1,
          pageSize: params.pageSize || 50,
          nextCursor: null,
          hasMore: false
        }
      },
      getReportAccessUrl: async (patientId, reportId, params) => {
        env.calls.push(['report-url', patientId, reportId, params])
        return { url: 'https://short.example/report.pdf', expiresInSeconds: 300 }
      },
      getFileAccessUrl: async (patientId, fileId, params) => {
        env.calls.push(['file-url', patientId, fileId, params])
        return { url: 'https://short.example/file.pdf', expiresInSeconds: 300 }
      }
    }
    require.cache[reportApiPath] = {
      id: reportApiPath,
      filename: reportApiPath,
      loaded: true,
      exports: stub
    }

    const sunvouApi = require(sunvouApiPath)
    const reports = await sunvouApi.listReports({ page: 1, pageSize: 20 })
    assert.deepStrictEqual(reports.items.map(item => item.reportId), ['9001'])
    assert.deepStrictEqual(reports.list.map(item => item.reportId), ['9001'])
    assert.deepStrictEqual(env.calls[0], ['list', '768495013408443', { page: 1, pageSize: 20 }])

    const report = await sunvouApi.getReport('9001')
    assert.strictEqual(report.reportNo, 'SV-9001')
    assert.deepStrictEqual(env.calls[1], ['list', '768495013408443', { pageSize: 50 }])

    const accessUrl = await sunvouApi.getReportAccessUrl('9001', { expirySeconds: 180 })
    assert.strictEqual(accessUrl.url, 'https://short.example/report.pdf')
    assert.deepStrictEqual(env.calls[2], ['report-url', '768495013408443', '9001', { expirySeconds: 180 }])

    const fileUrl = await sunvouApi.getFileAccessUrl('file-1', { expirySeconds: 180 })
    assert.strictEqual(fileUrl.url, 'https://short.example/file.pdf')
    assert.deepStrictEqual(env.calls[3], ['file-url', '768495013408443', 'file-1', { expirySeconds: 180 }])
  } finally {
    env.cleanup()
  }
})

test('sunvou api refuses to load reports without a patient context', async () => {
  const env = installEnv({
    patientRef: '',
    patientId: ''
  })
  try {
    require.cache[reportApiPath] = {
      id: reportApiPath,
      filename: reportApiPath,
      loaded: true,
      exports: {
        listPatientReports: async () => []
      }
    }
    const sunvouApi = require(sunvouApiPath)
    await assert.rejects(() => sunvouApi.listReports(), /请选择患者后再查看报告/)
  } finally {
    env.cleanup()
  }
})
