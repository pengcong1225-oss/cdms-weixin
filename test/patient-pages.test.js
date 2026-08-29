const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')

function read (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson (relativePath) {
  return JSON.parse(read(relativePath))
}

function installPageTestEnv ({ patientApi, session, wxOverrides } = {}) {
  const pages = []
  const navigations = []
  const toasts = []
  const ensureSessionCalls = []
  const app = {
    globalData: Object.assign({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      activeRole: 'DOCTOR',
      orgId: 'client-org-should-not-filter'
    }, session)
  }
  global.Page = config => {
    config.data = JSON.parse(JSON.stringify(config.data || {}))
    config.setData = values => { config.data = Object.assign({}, config.data, values) }
    pages.push(config)
  }
  global.getApp = () => app
  global.wx = Object.assign({
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    onBluetoothAdapterStateChange: () => {},
    openBluetoothAdapter: options => options && options.success && options.success({}),
    navigateTo: options => navigations.push(options),
    switchTab: options => navigations.push(options),
    reLaunch: options => navigations.push(options),
    showToast: options => toasts.push(options),
    stopPullDownRefresh: () => {}
  }, wxOverrides)

  const apiPath = path.join(root, 'miniprogram/utils/patient-api.js')
  const guardPath = path.join(root, 'miniprogram/utils/auth-guard.js')
  delete require.cache[apiPath]
  delete require.cache[guardPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: patientApi || {}
  }
  require.cache[guardPath] = {
    id: guardPath,
    filename: guardPath,
    loaded: true,
    exports: {
      ensureSession: async options => {
        ensureSessionCalls.push(options || {})
        return global.getApp().globalData
      }
    }
  }
  return { app, pages, navigations, toasts, ensureSessionCalls }
}

function loadPage (relativePath) {
  const fullPath = path.join(root, relativePath)
  delete require.cache[fullPath]
  require(fullPath)
}

test('patient routes are registered and use native shared components', () => {
  const appConfig = readJson('miniprogram/app.json')
  ;['pages/patient-list/index', 'pages/patient-detail/index', 'pages/patient-360/index'].forEach(route => {
    assert.ok(appConfig.pages.includes(route), `${route} must be registered`)
  })

  const listJson = readJson('miniprogram/pages/patient-list/index.json')
  const detailJson = readJson('miniprogram/pages/patient-detail/index.json')
  const patient360Json = readJson('miniprogram/pages/patient-360/index.json')
  ;['app-header', 'patient-card', 'state-panel'].forEach(name => assert.ok(listJson.usingComponents[name]))
  ;['app-header', 'form-section', 'status-tag', 'bottom-action-bar', 'state-panel'].forEach(name => assert.ok(detailJson.usingComponents[name]))
  ;['app-header', 'form-section', 'status-tag', 'state-panel'].forEach(name => assert.ok(patient360Json.usingComponents[name]))
})

test('doctor workspace opens the native patient list', async () => {
  const env = installPageTestEnv()
  loadPage('miniprogram/pages/doctor/workspace/index.js')
  const page = env.pages[0]

  await page.onLoad()
  page.onEntrySelect({ currentTarget: { dataset: { index: 0 } } })

  assert.equal(page.data.entries[0].disabled, false)
  assert.deepStrictEqual(env.navigations, [{ url: '/pages/patient-list/index' }])
})

test('doctor workspace opens the native body-composition station', async () => {
  const env = installPageTestEnv()
  loadPage('miniprogram/pages/doctor/workspace/index.js')
  const page = env.pages[0]

  await page.onLoad()
  page.onEntrySelect({ currentTarget: { dataset: { index: 1 } } })

  assert.equal(page.data.entries[1].disabled, false)
  assert.deepStrictEqual(env.navigations, [{ url: '/pages/device-scale/station/index' }])
})

test('patient list keeps fixed state, paginates server results, and does not client-filter org scope', async () => {
  const calls = []
  const env = installPageTestEnv({
    patientApi: {
      listPatients: async params => {
        calls.push(params)
        return calls.length === 1
          ? { list: [{ id: '768495013408443', name: '测试患者2', orgName: 'server-org', attentionLevel: 2, riskLevel: 2 }], page: 1, pageSize: 1, total: 2 }
          : { list: [{ id: '768495013408445', name: '测试患者', orgName: 'other-server-org', attentionLevel: 1, riskLevel: 1 }], page: 2, pageSize: 1, total: 2 }
      }
    }
  })
  loadPage('miniprogram/pages/patient-list/index.js')
  const page = env.pages[0]

  assert.deepStrictEqual(Object.keys(page.data).filter(key => ['loading', 'refreshing', 'keyword', 'patients', 'page', 'hasMore', 'error', 'empty'].includes(key)).sort(),
    ['empty', 'error', 'hasMore', 'keyword', 'loading', 'page', 'patients', 'refreshing'].sort())

  await page.onLoad()
  await page.onReachBottom()
  page.onPatientSelect({ currentTarget: { dataset: { id: '768495013408443' } } })

  assert.deepStrictEqual(calls, [
    { page: 1, pageSize: 20, keyword: '' },
    { page: 2, pageSize: 20, keyword: '' }
  ])
  assert.equal(page.data.patients.length, 2)
  assert.equal(page.data.patients[1].id, '768495013408445')
  assert.equal(page.data.patients[1].orgName, 'othe***')
  assert.deepStrictEqual(page.data.patients.map(patient => patient.statusText), ['状态已脱敏', '状态已脱敏'])
  assert.deepStrictEqual(page.data.patients.map(patient => patient.statusTone), ['neutral', 'neutral'])
  assert.equal(page.data.hasMore, false)
  assert.equal(env.app.globalData.currentPatientId, '768495013408443')
  assert.deepStrictEqual(env.navigations, [{ url: '/pages/patient-detail/index' }])
})

test('patient list shows permission errors and retry reloads first page', async () => {
  let calls = 0
  const forbidden = new Error('HTTP 403')
  forbidden.statusCode = 403
  const env = installPageTestEnv({
    patientApi: {
      listPatients: async () => {
        calls += 1
        if (calls === 1) throw forbidden
        return { list: [], page: 1, pageSize: 20, total: 0 }
      }
    }
  })
  loadPage('miniprogram/pages/patient-list/index.js')
  const page = env.pages[0]

  await page.onLoad()
  assert.equal(page.data.error, '无权访问患者列表')
  assert.equal(page.data.empty, false)

  await page.retry()
  assert.equal(page.data.error, '')
  assert.equal(page.data.empty, true)
})

test('patient detail masks sensitive display values and saves PatientSaveDTO body', async () => {
  const calls = []
  const env = installPageTestEnv({
    patientApi: {
      getPatient: async id => {
        calls.push(['get', id])
        return {
          id,
          basicInfo: { name: '测试患者', phone: '18696144935', idCard: '429004199102162952', gender: 1, age: 35 },
          orgInfo: { orgId: '1972545374712086529', orgName: '沌阳街', serveOrgId: '1972545374712086529' },
          smokeInfo: {},
          lungFunction: { goldGradeText: 'GOLD IV' },
          copdInfo: {},
          riskInfo: { diseaseStatusText: '已确诊', riskLevelText: '极高危' },
          allergies: [],
          dustExposures: []
        }
      },
      checkDuplicate: async (basicInfo, excludeId) => {
        calls.push(['duplicate', basicInfo.phone, basicInfo.idCard, excludeId])
        return { idCardConflict: false, phoneConflict: false }
      },
      updatePatient: async (id, payload) => {
        calls.push(['update', id, payload])
        return { id, basicInfo: payload.basicInfo }
      }
    },
    session: { currentPatientId: '768495013408443' }
  })
  loadPage('miniprogram/pages/patient-detail/index.js')
  const page = env.pages[0]

  await page.onLoad({ id: 'route-leak' })
  assert.equal(env.app.globalData.currentPatientId, undefined)
  assert.deepStrictEqual(calls[0], ['get', '768495013408443'])
  assert.equal(page.data.summary.phoneMasked, '186****4935')
  assert.equal(page.data.summary.idCardMasked, '429004********2952')
  assert.equal(page.data.summary.statusMasked, '状态已脱敏')
  assert.notEqual(page.data.summary.statusMasked, '已确诊')
  assert.notEqual(page.data.summary.statusMasked, '极高危')
  assert.notEqual(page.data.summary.statusMasked, 'GOLD IV')

  page.edit()
  page.updateBasicField({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '18696144936' } })
  await page.save()

  const update = calls.find(call => call[0] === 'update')
  assert.equal(update[1], '768495013408443')
  assert.deepStrictEqual(Object.keys(update[2]).sort(), ['allergies', 'basicInfo', 'copdInfo', 'dustExposures', 'lungFunction', 'smokeInfo'].sort())
  assert.equal(update[2].basicInfo.phone, '18696144936')
  assert.equal(update[2].basicInfo.orgId, '1972545374712086529')
})

test('patient detail opens patient 360 through transient context and a clean route', async () => {
  const env = installPageTestEnv({
    session: { currentPatientId: '768495013408443' },
    patientApi: {
      getPatient: async id => ({
        id,
        basicInfo: { name: '测试患者2', gender: 1, age: 35 },
        orgInfo: {},
        smokeInfo: {},
        lungFunction: {},
        copdInfo: {},
        allergies: [],
        dustExposures: []
      })
    }
  })
  loadPage('miniprogram/pages/patient-detail/index.js')
  const page = env.pages[0]

  await page.onLoad()
  page.onAction({ currentTarget: { dataset: { key: 'patient360' } } })

  assert.equal(env.app.globalData.currentPatientId, '768495013408443')
  assert.deepStrictEqual(env.navigations, [{ url: '/pages/patient-360/index' }])
})

test('patient detail enables native followups action through transient context and a clean route', async () => {
  const env = installPageTestEnv({
    session: { currentPatientId: '768495013408443' },
    patientApi: {
      getPatient: async id => ({
        id,
        basicInfo: { name: '测试患者2', gender: 1, age: 35 },
        orgInfo: {},
        smokeInfo: {},
        lungFunction: {},
        copdInfo: {},
        allergies: [],
        dustExposures: []
      })
    }
  })
  loadPage('miniprogram/pages/patient-detail/index.js')
  const page = env.pages[0]

  await page.onLoad()
  const followupsAction = page.data.actions.find(item => item.key === 'followups')
  assert.equal(followupsAction.enabled, true)

  page.onAction({ currentTarget: { dataset: { key: 'followups' } } })

  assert.equal(env.app.globalData.currentPatientId, '768495013408443')
  assert.deepStrictEqual(env.navigations, [{ url: '/pages/followups/index' }])
})

test('patient detail handles save permission errors without logging raw identity values', async () => {
  const logs = []
  const forbidden = new Error('HTTP 403')
  forbidden.statusCode = 403
  const originalWarn = console.warn
  const originalError = console.error
  const env = installPageTestEnv({
    patientApi: {
      checkDuplicate: async () => ({ idCardConflict: false, phoneConflict: false }),
      createPatient: async () => { throw forbidden }
    },
    wxOverrides: {
      showToast: () => {}
    }
  })
  console.warn = (...args) => logs.push(args.join(' '))
  console.error = (...args) => logs.push(args.join(' '))
  try {
    loadPage('miniprogram/pages/patient-detail/index.js')
    const page = env.pages[0]

    await page.onLoad({})
    page.updateBasicField({ currentTarget: { dataset: { field: 'name' } }, detail: { value: '测试患者' } })
    page.updateBasicField({ currentTarget: { dataset: { field: 'phone' } }, detail: { value: '18696144935' } })
    page.updateBasicField({ currentTarget: { dataset: { field: 'idCard' } }, detail: { value: '429004199102162952' } })
    await page.save()

    assert.equal(page.data.error, '无权保存患者档案')
    assert.equal(logs.join('\n').includes('18696144935'), false)
    assert.equal(logs.join('\n').includes('429004199102162952'), false)
  } finally {
    console.warn = originalWarn
    console.error = originalError
  }
})

test('patient 360 renders server clinical sections without recomputing risk', async () => {
  const env = installPageTestEnv({
    patientApi: {
      getPatient360: async patientId => ({
        patientId,
        detail: {
          basicInfo: { name: '测试患者2', genderText: '男', age: 35 },
          orgInfo: { orgName: '沌阳街' },
          lungFunction: { catScore: 31, goldGradeText: 'II级' },
          copdInfo: { symptom: '活动后气短' },
          monitoringSummary: { dataStatus: 'ACTIVE', lastMeasurementAt: '2026-08-26T13:05:22' }
        },
        followups: { list: [{ id: 'f1', visitDate: '2026-08-20', patientStatusText: '稳定' }], total: 1 },
        deviceMetrics: [{ type: 'HEART_RATE', value: 72, unit: 'bpm', measuredAt: '2026-08-26T13:05:22' }],
        riskTips: [{ levelText: '服务端重点关注', message: '服务端结论' }]
      })
    },
    session: { currentPatientId: '768495013408443' }
  })
  loadPage('miniprogram/pages/patient-360/index.js')
  const page = env.pages[0]

  await page.onLoad({ patientId: 'route-leak' })

  assert.deepStrictEqual(env.ensureSessionCalls, [{ role: 'DOCTOR' }])
  assert.equal(page.data.patientId, '768495013408443')
  assert.equal(env.app.globalData.currentPatientId, undefined)
  assert.equal(page.data.sections.basicInfo.title, '基本信息')
  assert.equal(page.data.sections.copd.title, 'COPD 专档')
  assert.equal(page.data.sections.latestFollowup.items[0].value, '稳定')
  assert.equal(page.data.sections.deviceMetrics.items[0].value, '72 bpm')
  assert.equal(page.data.sections.riskTips.items[0].value, '服务端结论')
  assert.equal(JSON.stringify(page.data.sections).includes('极高危'), false)
})

test('patient detail and patient 360 WXML expose the native followups action copy', () => {
  const detailWxml = read('miniprogram/pages/patient-detail/index.wxml')
  const patient360Wxml = read('miniprogram/pages/patient-360/index.wxml')

  assert.match(detailWxml, /action-grid/)
  assert.match(patient360Wxml, /caption="进入随访、监测中心和报告中心"/)
  assert.match(patient360Wxml, /title="\{\{item\.title\}\}"/)
})
