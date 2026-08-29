const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const authGuardPath = path.join(root, 'miniprogram/utils/auth-guard.js')
const stationApiPath = path.join(root, 'miniprogram/utils/station-api.js')
const scaleBlePath = path.join(root, 'miniprogram/services/scaleBle.js')

function installPageEnv ({ session = {}, stubs = {}, wxOverrides = {} } = {}) {
  const pages = []
  const navigations = []
  const toasts = []
  const modals = []
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
      orgId: '1972545374712086529',
      patientRef: ''
    }, session)
  })
  global.wx = Object.assign({
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    navigateTo: options => navigations.push(options),
    switchTab: options => navigations.push(options),
    reLaunch: options => navigations.push(options),
    showToast: options => toasts.push(options),
    showModal: options => {
      modals.push(options)
      if (options.success) options.success({ confirm: true })
    },
    stopPullDownRefresh: () => {},
    setClipboardData: options => {
      if (options.success) options.success({})
    }
  }, wxOverrides)

  ;[authGuardPath, stationApiPath, scaleBlePath].forEach(modulePath => {
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
    modals,
    cleanup () {
      global.Page = previous.Page
      global.getApp = previous.getApp
      global.wx = previous.wx
      ;[authGuardPath, stationApiPath, scaleBlePath].forEach(modulePath => {
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

test('station page calls next and configures the scale from the current patient summary', async () => {
  const calls = []
  const configureCalls = []
  class FakeScaleBle {
    constructor (handlers = {}) {
      this.handlers = handlers
      this.deviceId = 'scale-1'
    }

    async configurePatient (patient) {
      configureCalls.push(patient)
    }

    async disconnect () {}

    destroy () {}
  }

  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [stationApiPath]: {
        createIdempotencyKey: prefix => `${prefix}-id-1`,
        createStation: async body => {
          calls.push(['create', body])
          return { id: 'station-1', status: 'OPEN', checkinToken: 'token-1', queue: [] }
        },
        getStation: async stationId => {
          calls.push(['get', stationId])
          return {
            id: stationId,
            status: 'OPEN',
            checkinToken: 'token-1',
            queue: []
          }
        },
        getTodayQueue: async stationId => {
          calls.push(['queue', stationId])
          return { items: [] }
        },
        callNext: async (stationId, body) => {
          calls.push(['next', stationId, body])
          return {
            id: stationId,
            status: 'OPEN',
            currentQueueItem: {
              id: 'queue-1',
              status: 'CALLED',
              patientSummary: { maskedName: '测试患者2', gender: 1, age: 68, height: 172 }
            },
            queue: [{ id: 'queue-1', status: 'CALLED' }]
          }
        }
      },
      [scaleBlePath]: {
        ScaleBle: FakeScaleBle
      }
    }
  })

  try {
    loadPage('miniprogram/pages/device-scale/station/index.js')
    const page = env.pages[0]

    await page.onLoad()
    await page.callNext()

    assert.strictEqual(page.data.stationId, 'station-1')
    assert.strictEqual(page.data.currentQueueItem.id, 'queue-1')
    assert.deepStrictEqual(configureCalls, [{ gender: 1, age: 68, height: 172 }])
    assert.deepStrictEqual(calls.map(item => item[0]), ['create', 'get', 'queue', 'next'])
    assert.strictEqual(calls[3][2].idempotencyKey.length > 0, true)
  } finally {
    env.cleanup()
  }
})

test('station page saves a draft, confirms it, and closes only after discard is provided', async () => {
  const calls = []
  class FakeScaleBle {
    constructor () {
      this.deviceId = 'scale-1'
    }

    async configurePatient () {}

    async disconnect () {}

    destroy () {}
  }

  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [stationApiPath]: {
        createIdempotencyKey: prefix => `${prefix}-id-1`,
        createStation: async () => ({ id: 'station-1', status: 'OPEN', checkinToken: 'token-1', queue: [] }),
        getStation: async () => ({ id: 'station-1', status: 'OPEN', queue: [] }),
        getTodayQueue: async () => ({ items: [] }),
        saveMeasurementDraft: async (stationId, queueItemId, body) => {
          calls.push(['draft', stationId, queueItemId, body])
          return {
            id: 'station-1',
            stationId: 'station-1',
            status: 'OPEN',
            currentQueueItem: {
              id: queueItemId,
              status: 'RESULT_PENDING',
              draftId: 'draft-1',
              draftStatus: 'RESULT_PENDING',
              patientSummary: { maskedName: '测试患者2', gender: 1, age: 68, height: 172 }
            },
            currentDraft: {
              id: 'draft-1',
              status: 'RESULT_PENDING',
              queueItemId
            },
            queue: [{
              id: queueItemId,
              status: 'RESULT_PENDING',
              draftId: 'draft-1',
              draftStatus: 'RESULT_PENDING',
              patientSummary: { maskedName: '测试患者2', gender: 1, age: 68, height: 172 }
            }]
          }
        },
        confirmMeasurement: async (stationId, queueItemId, draftId, body) => {
          calls.push(['confirm', stationId, queueItemId, draftId, body])
          return {
            id: 'station-1',
            stationId: 'station-1',
            status: 'OPEN',
            currentQueueItem: {
              id: queueItemId,
              status: 'COMPLETED',
              draftId,
              draftStatus: 'CONFIRMED',
              patientSummary: { maskedName: '测试患者2', gender: 1, age: 68, height: 172 }
            },
            currentDraft: {
              id: draftId,
              status: 'CONFIRMED',
              queueItemId
            },
            queue: [{
              id: queueItemId,
              status: 'COMPLETED',
              draftId,
              draftStatus: 'CONFIRMED',
              patientSummary: { maskedName: '测试患者2', gender: 1, age: 68, height: 172 }
            }]
          }
        },
        closeStation: async (stationId, body) => {
          calls.push(['close', stationId, body])
          return { id: stationId, status: 'CLOSED', queue: [] }
        }
      },
      [scaleBlePath]: {
        ScaleBle: FakeScaleBle
      }
    }
  })

  try {
    loadPage('miniprogram/pages/device-scale/station/index.js')
    const page = env.pages[0]

    await page.onLoad()
    page.setData({
      stationId: 'station-1',
      currentQueueItem: { id: 'queue-1', status: 'CALLED', patientSummary: { maskedName: '测试患者2', gender: 1, age: 68, height: 172 } },
      currentDraft: { id: 'draft-1' }
    })
    await page.onScaleResult({
      complete: true,
      metrics: [{ name: 'weight', value: 65.2, unit: 'kg' }]
    })
    await page.confirmMeasurement()
    await page.closeStation()

    assert.strictEqual(calls[0][0], 'draft')
    assert.strictEqual(calls[0][1], 'station-1')
    assert.strictEqual(calls[0][2], 'queue-1')
    assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[0][3], 'patientId'), false)
    assert.strictEqual(calls[1][0], 'confirm')
    assert.strictEqual(calls[1][3], 'draft-1')
    assert.strictEqual(calls[2][0], 'close')
    assert.deepStrictEqual(calls[2][2], { idempotencyKey: calls[2][2].idempotencyKey, discardDraftIds: ['draft-1'] })
  } finally {
    env.cleanup()
  }
})
