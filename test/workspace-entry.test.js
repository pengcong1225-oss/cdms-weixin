const assert = require('assert')
const path = require('path')
const test = require('node:test')
const { getWorkspaceEntries } = require('../miniprogram/utils/workspace-entry')

const root = path.resolve(__dirname, '..')
const doctorWorkspacePath = path.join(root, 'miniprogram/pages/doctor/workspace/index.js')
const authGuardPath = path.join(root, 'miniprogram/utils/auth-guard.js')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const bleManagerPath = path.join(root, 'miniprogram/services/bleManager.js')
const statsApiPath = path.join(root, 'miniprogram/utils/stats-api.js')
const patientApiPath = path.join(root, 'miniprogram/utils/patient-api.js')
const doctorWorkspaceWxmlPath = path.join(root, 'miniprogram/pages/doctor/workspace/index.wxml')

function installDoctorWorkspaceEnv (session = {}) {
  const pages = []
  const navigations = []
  const toasts = []
  const app = {
    globalData: Object.assign({
      accessToken: 'doctor-access',
      refreshToken: 'doctor-refresh',
      activeRole: 'DOCTOR'
    }, session),
    clearAuth: () => {}
  }
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
  global.getApp = () => app
  global.wx = {
    navigateTo: options => navigations.push(options),
    switchTab: options => navigations.push(options),
    reLaunch: options => navigations.push(options),
    showToast: options => toasts.push(options),
    showModal: options => options.success && options.success({ confirm: true })
  }

  delete require.cache[doctorWorkspacePath]
  delete require.cache[authGuardPath]
  delete require.cache[apiPath]
  delete require.cache[bleManagerPath]
  delete require.cache[statsApiPath]
  delete require.cache[patientApiPath]

  require.cache[authGuardPath] = {
    id: authGuardPath,
    filename: authGuardPath,
    loaded: true,
    exports: {
      ensureSession: async () => global.getApp().globalData
    }
  }
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: {
      logout: async () => {}
    }
  }
  require.cache[bleManagerPath] = {
    id: bleManagerPath,
    filename: bleManagerPath,
    loaded: true,
    exports: {
      unbind: async () => {}
    }
  }
  require.cache[statsApiPath] = {
    id: statsApiPath,
    filename: statsApiPath,
    loaded: true,
    exports: {
      getHomeStats: async () => ({ totalPatients: 18, todayPending: 4, todayCompleted: 6, highRiskCount: 2, upcoming3Days: 7 })
    }
  }
  require.cache[patientApiPath] = {
    id: patientApiPath,
    filename: patientApiPath,
    loaded: true,
    exports: {
      listPatients: async () => ({
        list: [
          { id: '768495013408443', name: '张三', visitStatus: 0, visitStatusText: '待随访', riskLevel: 3, riskLevelText: '高危', nextVisitDate: '2026-08-30' },
          { id: '768495013408444', name: '李四', visitStatus: 1, visitStatusText: '已随访', riskLevel: 1, riskLevelText: '低危', nextVisitDate: '2026-09-02' }
        ],
        total: 2
      })
    }
  }

  require(doctorWorkspacePath)

  return {
    app,
    page: pages[0],
    navigations,
    toasts,
    cleanup () {
      global.Page = previous.Page
      global.getApp = previous.getApp
      global.wx = previous.wx
      delete require.cache[doctorWorkspacePath]
      delete require.cache[authGuardPath]
      delete require.cache[apiPath]
      delete require.cache[bleManagerPath]
      delete require.cache[statsApiPath]
      delete require.cache[patientApiPath]
    }
  }
}

test('workspace entry registry keeps patient and doctor native roots', () => {
  assert.deepStrictEqual(getWorkspaceEntries('PATIENT'), [
    { key: 'patient-workspace', title: '患者工作台', subtitle: '随访、报告和健康服务入口', type: 'NATIVE', url: '/pages/patient/workspace/index' },
    { key: 'device', title: '指环设备', subtitle: '在小程序中连接与同步设备', type: 'NATIVE', url: '/pages/device/device' },
    { key: 'public-questionnaire', title: '建档问卷', subtitle: '复制公开问卷地址', type: 'COPY', copyText: 'https://jq.mockr.com.cn/mzf-sq/#/screen' }
  ])

  assert.deepStrictEqual(getWorkspaceEntries('DOCTOR'), [
    { key: 'doctor-workspace', title: '医生工作台', subtitle: '患者管理、随访和设备工作站入口', type: 'NATIVE', url: '/pages/doctor/workspace/index' }
  ])

  assert.deepStrictEqual(getWorkspaceEntries(''), [])

  const appConfig = require('../miniprogram/app.json')
  assert.ok(!appConfig.pages.includes('pages/device-scale/index'), '体脂秤页面暂不注册入口')
  assert.ok(appConfig.pages.includes('pages/device-scale/station/index'), '体脂秤工作站页必须注册')
  assert.ok(appConfig.pages.includes('pages/device/device'), '患者手环设备页必须保留')
  assert.ok(!appConfig.pages.includes('pages/h5/index'), '业务 H5 WebView 页面不得注册')
})

test('doctor workspace exposes every native business entry without disabled placeholders', async () => {
  const env = installDoctorWorkspaceEnv()
  try {
    const page = env.page
    await page.onLoad()

    assert.deepStrictEqual(page.data.entries.map(item => item.key), [
      'patients',
      'station',
      'followups',
      'monitoring',
      'messages',
      'statistics',
      'reports',
      'devices'
    ])
    assert.equal(page.data.entries[1].key, 'station')
    assert.equal(page.data.entries.some(item => item.disabled), false)
    assert.equal(page.data.entries.some(item => /后续接入/.test(item.subtitle)), false)
    assert.equal(page.data.stats.some(item => /后续/.test(String(item.caption || ''))), false)
  } finally {
    env.cleanup()
  }
})

test('doctor workspace ignores query-derived patient context and keeps patient urls clean', async () => {
  const env = installDoctorWorkspaceEnv()
  try {
    const page = env.page
    await page.onLoad({ patientId: 'query-patient', id: 'query-id' })

    assert.equal(page.data.currentPatientId, '')
    assert.equal(env.app.globalData.currentPatientId, undefined)
  } finally {
    env.cleanup()
  }
})

test('doctor workspace navigates native entries without patientId in urls and uses transient patient context', async () => {
  const env = installDoctorWorkspaceEnv()
  try {
    const page = env.page
    await page.onLoad()

    ;[0, 1, 2, 3, 4, 5, 6, 7].forEach(index => {
      page.onEntrySelect({ currentTarget: { dataset: { index } } })
    })

    assert.deepStrictEqual(env.navigations, [
      { url: '/pages/patient-list/index' },
      { url: '/pages/device-scale/station/index' },
      { url: '/pages/patient-list/index?selection=1' },
      { url: '/pages/patient-list/index?selection=1' },
      { url: '/pages/messages/index' },
      { url: '/pages/statistics/index' },
      { url: '/pages/patient-list/index?selection=1' },
      { url: '/pages/device/device' }
    ])
    assert.deepStrictEqual(env.toasts, [])
  } finally {
    env.cleanup()
  }

  const scopedEnv = installDoctorWorkspaceEnv({ currentPatientId: '768495013408443' })
  try {
    const page = scopedEnv.page
    await page.onLoad()

    const followupsIndex = page.data.entries.findIndex(item => item.key === 'followups')
    const monitoringIndex = page.data.entries.findIndex(item => item.key === 'monitoring')
    const reportsIndex = page.data.entries.findIndex(item => item.key === 'reports')

    page.onEntrySelect({ currentTarget: { dataset: { index: followupsIndex } } })
    page.onEntrySelect({ currentTarget: { dataset: { index: monitoringIndex } } })
    page.onEntrySelect({ currentTarget: { dataset: { index: reportsIndex } } })

    assert.deepStrictEqual(scopedEnv.navigations, [
      { url: '/pages/followups/index' },
      { url: '/pages/monitoring/index' },
      { url: '/pages/reports/index' }
    ])
    assert.equal(scopedEnv.app.globalData.currentPatientId, '768495013408443')
  } finally {
    scopedEnv.cleanup()
  }
})

test('doctor workspace records one pending patient-scoped destination before selecting a patient', async () => {
  const env = installDoctorWorkspaceEnv()
  try {
    const page = env.page
    await page.onLoad()
    const monitoringIndex = page.data.entries.findIndex(item => item.key === 'monitoring')

    page.onEntrySelect({ currentTarget: { dataset: { index: monitoringIndex } } })

    assert.equal(env.app.globalData.pendingDoctorEntry, 'monitoring')
    assert.deepStrictEqual(env.navigations, [{ url: '/pages/patient-list/index?selection=1' }])
  } finally {
    env.cleanup()
  }
})

test('doctor workspace loads actionable summary stats and prioritized patients', async () => {
  const env = installDoctorWorkspaceEnv()
  try {
    const page = env.page
    await page.onLoad()

    assert.deepStrictEqual(page.data.summaryCards.map(item => [item.key, item.value]), [
      ['totalPatients', '18'],
      ['todayPending', '4'],
      ['upcoming3Days', '7'],
      ['highRiskCount', '2']
    ])
    assert.deepStrictEqual(page.data.todoPatients.map(item => item.id), ['768495013408443'])
    assert.equal(page.data.todoPatients[0].riskLevelText, '高危')
    assert.equal(page.data.todoPatients[0].visitStatusText, '待随访')
  } finally {
    env.cleanup()
  }
})

test('doctor workspace keeps device actions in a compact secondary group', async () => {
  const env = installDoctorWorkspaceEnv()
  try {
    const page = env.page
    await page.onLoad()
    assert.deepStrictEqual(page.data.primaryActions.map(item => item.key), ['patients', 'followups', 'monitoring', 'statistics', 'reports', 'messages'])
    assert.deepStrictEqual(page.data.deviceActions.map(item => item.key), ['devices', 'station'])
    const wxml = require('fs').readFileSync(doctorWorkspaceWxmlPath, 'utf8')
    assert.ok(wxml.includes('重点患者'))
    assert.ok(wxml.includes('设备入口'))
    assert.ok(wxml.includes('primaryActions'))
    assert.ok(wxml.includes('deviceActions'))
  } finally {
    env.cleanup()
  }
})

test('doctor workspace bottom navigation keeps workbench, patients, statistics and device tabs', () => {
  const appConfig = require('../miniprogram/app.json')
  assert.deepStrictEqual(appConfig.tabBar.list.map(item => item.pagePath), [
    'pages/doctor/workspace/index',
    'pages/patient-list/index',
    'pages/statistics/index',
    'pages/device/device'
  ])
})

console.log('workspace-entry tests passed')
