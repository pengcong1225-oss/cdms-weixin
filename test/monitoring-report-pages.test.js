const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const authGuardPath = path.join(root, 'miniprogram/utils/auth-guard.js')
const monitoringApiPath = path.join(root, 'miniprogram/utils/monitoring-api.js')
const patientApiPath = path.join(root, 'miniprogram/utils/patient-api.js')
const reportApiPath = path.join(root, 'miniprogram/utils/report-api.js')

function installPageEnv ({ session = {}, stubs = {}, wxOverrides = {} } = {}) {
  const pages = []
  const navigations = []
  const toasts = []
  const storageWrites = []
  const clipboardWrites = []
  const downloads = []
  const openDocuments = []
  const previews = []
  const previous = {
    Page: global.Page,
    getApp: global.getApp,
    wx: global.wx
  }

  global.Page = config => {
    config.data = JSON.parse(JSON.stringify(config.data || {}))
    config.setData = values => {
      config.data = Object.assign({}, config.data, values)
    }
    pages.push(config)
  }
  global.getApp = () => ({
    globalData: Object.assign({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      activeRole: 'DOCTOR',
      patientRef: '768495013408443',
      orgId: '1972545374712086529',
      cdmsBaseUrl: 'https://cdms.example'
    }, session)
  })
  global.wx = Object.assign({
    getStorageSync: () => null,
    setStorageSync: (key, value) => storageWrites.push([key, value]),
    removeStorageSync: () => {},
    navigateTo: options => navigations.push(options),
    switchTab: options => navigations.push(options),
    reLaunch: options => navigations.push(options),
    showToast: options => toasts.push(options),
    showModal: options => {
      if (options.success) options.success({ confirm: true })
    },
    stopPullDownRefresh: () => {},
    setClipboardData: options => {
      clipboardWrites.push(options.data)
      if (options.success) options.success({})
    },
    downloadFile: options => {
      downloads.push(options)
      if (options.success) options.success({ tempFilePath: options.filePath || '/tmp/report.pdf' })
    },
    openDocument: options => {
      openDocuments.push(options)
      if (options.success) options.success({})
    },
    previewImage: options => {
      previews.push(options)
      if (options.success) options.success({})
    }
  }, wxOverrides)

  ;[authGuardPath, monitoringApiPath, patientApiPath, reportApiPath].forEach(modulePath => {
    delete require.cache[modulePath]
  })
  Object.entries(stubs).forEach(([modulePath, exports]) => {
    require.cache[modulePath] = {
      id: modulePath,
      filename: modulePath,
      loaded: true,
      exports
    }
  })

  return {
    pages,
    navigations,
    toasts,
    storageWrites,
    clipboardWrites,
    downloads,
    openDocuments,
    previews,
    cleanup () {
      global.Page = previous.Page
      global.getApp = previous.getApp
      global.wx = previous.wx
      ;[authGuardPath, monitoringApiPath, patientApiPath, reportApiPath].forEach(modulePath => {
        delete require.cache[modulePath]
      })
    }
  }
}

function loadPage (relativePath) {
  const fullPath = path.join(root, relativePath)
  delete require.cache[fullPath]
  require(fullPath)
}

test('monitoring page renders server data and refreshes after alert acknowledgement', async () => {
  const calls = []
  let acknowledged = false
  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [monitoringApiPath]: {
        getMonitoringSummary: async patientId => {
          calls.push(['summary', patientId])
          return {
            patientId,
            attentionLevel: 3,
            attentionLevelText: '高危',
            dataStatus: 'ACTIVE',
            primaryAlertType: '血氧',
            primaryAlertValue: 91.2,
            primaryAlertUnit: '%',
            primaryAlertReason: '夜间血氧偏低',
            activeAlertCount: acknowledged ? 0 : 1,
            deviceName: 'Ring',
            lastMeasurementAt: '2026-08-29T08:00:00'
          }
        },
        getMonitoringTrends: async (patientId, params) => {
          calls.push(['trends', patientId, params])
          return {
            patientId,
            rangeDays: params.range === '30d' ? 30 : 7,
            bloodOxygen: [{ date: '2026-08-29', value: 91.2, unit: '%' }],
            heartRate: [{ date: '2026-08-29', value: 72, unit: 'bpm' }],
            steps: [{ date: '2026-08-29', value: 4200, unit: '步' }],
            sleepDuration: [{ date: '2026-08-29', value: 6.5, unit: 'h' }]
          }
        },
        getMonitoringAlerts: async (patientId, params) => {
          calls.push(['alerts', patientId, params])
          return {
            list: acknowledged
              ? [{ id: 9001, patientId, alertType: '血氧下降', active: 0, acknowledgedAt: '2026-08-29T09:30:00' }]
              : [{ id: 9001, patientId, alertType: '血氧下降', active: 1, acknowledgedAt: null }],
            page: params.page,
            pageSize: params.pageSize,
            total: 1
          }
        },
        acknowledgeAlert: async id => {
          calls.push(['ack', id])
          acknowledged = true
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/monitoring/index.js')
    const page = env.pages[0]

    await page.onLoad({ patientId: '768495013408443' })
    await page.acknowledgeAlert({ currentTarget: { dataset: { id: '9001' } } })

    assert.strictEqual(page.data.patientId, '768495013408443')
    assert.strictEqual(page.data.summaryCards[0].value, '高危')
    assert.strictEqual(page.data.trendSections[0].points[0].value, '91.2 %')
    assert.strictEqual(page.data.alerts[0].acknowledgedAt, '2026-08-29 09:30')
    assert.deepStrictEqual(calls.map(call => call[0]), ['summary', 'trends', 'alerts', 'ack', 'summary', 'trends', 'alerts'])
  } finally {
    env.cleanup()
  }
})

test('monitoring trend rows bind the point item explicitly in WXML', () => {
  const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/monitoring/index.wxml'), 'utf8')
  assert.match(wxml, /wx:for="\{\{item\.points\}\}"\s+wx:for-item="point"/)
  assert.match(wxml, /{{point\.dateText}}/)
  assert.match(wxml, /{{point\.value}}/)
  assert.match(wxml, /{{point\.caption}}/)
})

test('reports pages keep short-lived access urls in memory only', async () => {
  const listCalls = []
  const env = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '768495013408443' })
      },
      [reportApiPath]: {
        listPatientReports: async (patientId, params) => {
          listCalls.push(['list', patientId, params])
          return {
            items: [
              {
                reportId: 9001,
                patientId,
                reportNo: 'RPT-9001',
                category: 'RING',
                fileId: 'file-9001',
                fileStatus: 'STORED',
                fileBucket: 'oss',
                fileObjectKey: 'reports/ring/9001.pdf',
                createdAt: '2026-08-29T10:00:00',
                downloadAvailable: true
              }
            ],
            nextCursor: null,
            hasMore: false,
            page: 1,
            pageSize: 20
          }
        },
        getReportAccessUrl: async (patientId, reportId) => {
          listCalls.push(['report-url', patientId, reportId])
          return { url: 'https://short.example/report-9001.pdf', expiresInSeconds: 300 }
        },
        getFileAccessUrl: async (patientId, fileId) => {
          listCalls.push(['file-url', patientId, fileId])
          return { url: 'https://short.example/file-9001.pdf', expiresInSeconds: 300 }
        },
        buildReportRoute: ({ patientId, reportId }) => `/pages/reports/detail?patientId=${patientId}&reportId=${reportId}`
      }
    }
  })
  try {
    loadPage('miniprogram/pages/reports/index.js')
    loadPage('miniprogram/pages/reports/detail.js')
    const indexPage = env.pages[0]
    const detailPage = env.pages[1]

    await indexPage.onLoad({ patientId: '768495013408443' })
    indexPage.onReportTap({ currentTarget: { dataset: { reportId: '9001' } } })

    await detailPage.onLoad({ patientId: '768495013408443', reportId: '9001' })
    await detailPage.openReport()
    await detailPage.openAttachment()

    assert.strictEqual(indexPage.data.reports[0].reportId, '9001')
    assert.deepStrictEqual(env.navigations, [{ url: '/pages/reports/detail?patientId=768495013408443&reportId=9001' }])
    assert.strictEqual(env.storageWrites.length, 0)
    assert.strictEqual(env.clipboardWrites.length, 0)
    assert.strictEqual(env.downloads[0].url, 'https://short.example/report-9001.pdf')
    assert.strictEqual(env.downloads[1].url, 'https://short.example/file-9001.pdf')
    assert.strictEqual(env.openDocuments[0].filePath, '/tmp/report.pdf')
    assert.strictEqual(env.openDocuments[1].filePath, '/tmp/report.pdf')
    assert.strictEqual(listCalls.some(call => String(call[2]?.accessUrl || '').length), false)
  } finally {
    env.cleanup()
  }
})

test('reports detail only shows attachment action for valid file ids', async () => {
  const calls = []
  const env = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '768495013408443' })
      },
      [reportApiPath]: {
        listPatientReports: async patientId => ({
          items: [
            {
              reportId: 9001,
              patientId,
              reportNo: 'RPT-9001',
              category: 'RING',
              fileObjectKey: 'reports/ring/9001.pdf',
              createdAt: '2026-08-29T10:00:00',
              downloadAvailable: true
            }
          ],
          list: [],
          records: [],
          page: 1,
          pageSize: 20
        }),
        getFileAccessUrl: async (patientId, fileId) => {
          calls.push(['file-url', patientId, fileId])
          return { url: 'https://short.example/file-9001.pdf', expiresInSeconds: 300 }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/reports/detail.js')
    const page = env.pages[0]

    await page.onLoad({ patientId: '768495013408443', reportId: '9001' })
    assert.strictEqual(page.data.reportItem.fileId, '')
    await page.openAttachment()

    assert.deepStrictEqual(calls, [])
    assert.strictEqual(env.toasts.at(-1)?.title, '暂无附件')

    const wxml = fs.readFileSync(path.join(root, 'miniprogram/pages/reports/detail.wxml'), 'utf8')
    assert.match(wxml, /wx:if="\{\{reportItem\.fileId\}\}"/)
    assert.strictEqual(wxml.includes('reportItem.fileObjectKey'), false)
    assert.strictEqual(wxml.includes('reportItem.reportId'), false)
  } finally {
    env.cleanup()
  }
})

test('reports detail retries ai load and confirms with minimal body', async () => {
  const calls = []
  let failOnce = true
  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [reportApiPath]: {
        getOrgAiReport: async (orgId, period) => {
          calls.push(['get', orgId, period])
          if (failOnce) {
            failOnce = false
            throw Object.assign(new Error('HTTP 500'), { statusCode: 500 })
          }
          return {
            reportId: 9202,
            orgId,
            period,
            reportType: 2,
            markdownContent: '# 机构 AI 报告',
            doctorConfirmed: 0,
            doctorRemark: ''
          }
        },
        generateOrgAiReport: async (orgId, period) => {
          calls.push(['generate', orgId, period])
          return {
            reportId: 9202,
            orgId,
            period,
            reportType: 2,
            markdownContent: '# 机构 AI 报告',
            doctorConfirmed: 0,
            doctorRemark: ''
          }
        },
        confirmAiReport: async (reportId, body) => {
          calls.push(['confirm', reportId, body])
          return {
            reportId,
            orgId: '1972545374712086529',
            period: '2026-08',
            reportType: 2,
            markdownContent: '# 机构 AI 报告',
            doctorConfirmed: 1,
            doctorRemark: body.doctorRemark
          }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/reports/detail.js')
    const page = env.pages[0]

    await page.onLoad({ mode: 'org', period: '2026-08' })
    assert.strictEqual(page.data.error, 'AI 报告加载失败，请稍后重试')

    await page.retry()
    assert.strictEqual(page.data.aiReport.reportId, '9202')

    page.setData({ doctorRemark: '已确认', confirmChecked: true })
    await page.confirmReport()

    assert.deepStrictEqual(calls.map(call => call[0]), ['get', 'get', 'confirm', 'get'])
    assert.deepStrictEqual(calls[2][2], { confirmed: true, doctorRemark: '已确认' })
  } finally {
    env.cleanup()
  }
})

test('patient 360 exposes monitoring and report shortcuts', async () => {
  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [patientApiPath]: {
        getPatient360: async patientId => ({
          patientId,
          detail: {
            basicInfo: { name: '测试患者2', genderText: '男', age: 35 },
            orgInfo: { orgName: '沌阳街' },
            lungFunction: { catScore: 31, goldGradeText: 'II级' },
            copdInfo: { symptom: '活动后气短' },
            monitoringSummary: { dataStatus: 'ACTIVE', lastMeasurementAt: '2026-08-26T13:05:22' }
          },
          followups: { list: [{ id: 'f1', visitDate: '2026-08-20', patientStatusText: '稳定' }], total: 1 }
        })
      }
    }
  })
  try {
    loadPage('miniprogram/pages/patient-360/index.js')
    const page = env.pages[0]

    await page.onLoad({ patientId: '768495013408443' })
    page.onQuickActionSelect({ currentTarget: { dataset: { key: 'monitoring' } } })
    page.onQuickActionSelect({ currentTarget: { dataset: { key: 'reports' } } })

    assert.deepStrictEqual(env.navigations, [
      { url: '/pages/monitoring/index?patientId=768495013408443' },
      { url: '/pages/reports/index?patientId=768495013408443' }
    ])
    assert.strictEqual(page.data.quickActions.some(item => item.key === 'monitoring'), true)
    assert.strictEqual(page.data.quickActions.some(item => item.key === 'reports'), true)
  } finally {
    env.cleanup()
  }
})

test('native report routes are registered', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
  assert.ok(appConfig.pages.includes('pages/monitoring/index'))
  assert.ok(appConfig.pages.includes('pages/reports/index'))
  assert.ok(appConfig.pages.includes('pages/reports/detail'))
})
