const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const fs = require('fs')
const authGuardPath = path.join(root, 'miniprogram/utils/auth-guard.js')
const followupApiPath = path.join(root, 'miniprogram/utils/followup-api.js')
const messageApiPath = path.join(root, 'miniprogram/utils/message-api.js')
const statsApiPath = path.join(root, 'miniprogram/utils/stats-api.js')
const followupDetailWxmlPath = path.join(root, 'miniprogram/pages/followups/detail.wxml')

function installPageEnv ({ session = {}, stubs = {}, wxOverrides = {} } = {}) {
  const pages = []
  const navigations = []
  const toasts = []
  const clipboard = []
  const modalCalls = []
  const app = {
    globalData: Object.assign({
      accessToken: 'access-1',
      refreshToken: 'refresh-1',
      activeRole: 'PATIENT',
      cdmsBaseUrl: 'https://cdms.example'
    }, session)
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
  global.wx = Object.assign({
    getStorageSync: () => null,
    setStorageSync: () => {},
    removeStorageSync: () => {},
    onBluetoothAdapterStateChange: () => {},
    offBluetoothAdapterStateChange: () => {},
    openBluetoothAdapter: options => options && options.success && options.success({}),
    closeBluetoothAdapter: options => options && options.success && options.success({}),
    navigateTo: options => navigations.push(options),
    switchTab: options => navigations.push(options),
    reLaunch: options => navigations.push(options),
    showToast: options => toasts.push(options),
    showModal: options => {
      modalCalls.push(options)
      if (options.success) options.success({ confirm: true })
    },
    stopPullDownRefresh: () => {},
    setClipboardData: options => {
      clipboard.push(options.data)
      if (options.success) options.success({})
    },
    chooseMedia: options => {
      if (options.success) {
        options.success({
          tempFiles: [{ tempFilePath: '/tmp/photo.jpg', fileName: 'photo.jpg', size: 1024 }]
        })
      }
    }
  }, wxOverrides)

  ;[authGuardPath, followupApiPath, messageApiPath, statsApiPath].forEach(modulePath => {
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
    app,
    pages,
    navigations,
    toasts,
    clipboard,
    modalCalls,
    cleanup () {
      global.Page = previous.Page
      global.getApp = previous.getApp
      global.wx = previous.wx
      ;[authGuardPath, followupApiPath, messageApiPath, statsApiPath].forEach(modulePath => {
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

test('followup list switches between patient and doctor scope and opens detail pages', async () => {
  const patientCalls = []
  const patientEnv = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '768495013408443' })
      },
      [followupApiPath]: {
        listMyFollowups: async params => {
          patientCalls.push(params)
          return { list: [{ id: 9001, visitDate: '2026-08-28T09:00:00', patientStatusText: '稳定' }], total: 1, page: 1, pageSize: 20 }
        },
        listPatientFollowups: async () => {
          throw new Error('doctor scope should not be used for patient')
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/index.js')
    const page = patientEnv.pages[0]

    await page.onLoad()
    page.onFollowupSelect({ currentTarget: { dataset: { id: '9001' } } })

    assert.strictEqual(page.data.scope, 'PATIENT')
    assert.strictEqual(page.data.canEdit, false)
    assert.strictEqual(page.data.followups[0].id, '9001')
    assert.deepStrictEqual(patientCalls, [{ page: 1, pageSize: 20 }])
    assert.deepStrictEqual(patientEnv.navigations, [{ url: '/pages/followups/detail?id=9001' }])
  } finally {
    patientEnv.cleanup()
  }

  const doctorCalls = []
  const doctorEnv = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [followupApiPath]: {
        listMyFollowups: async () => {
          throw new Error('patient scope should not be used for doctor')
        },
        listPatientFollowups: async (patientId, params) => {
          doctorCalls.push({ patientId, params })
          return { list: [{ id: 9002, visitDate: '2026-08-27T09:00:00', patientStatusText: '改善' }], total: 1, page: 1, pageSize: 20 }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/index.js')
    const page = doctorEnv.pages[0]

    await page.onLoad({ patientId: '768495013408443' })
    page.onFollowupSelect({ currentTarget: { dataset: { id: '9002' } } })

    assert.strictEqual(page.data.scope, 'DOCTOR')
    assert.strictEqual(page.data.canEdit, true)
    assert.strictEqual(page.data.patientId, '768495013408443')
    assert.strictEqual(page.data.followups[0].id, '9002')
    assert.deepStrictEqual(doctorCalls, [{ patientId: '768495013408443', params: { page: 1, pageSize: 20 } }])
    assert.deepStrictEqual(doctorEnv.navigations, [{ url: '/pages/followups/detail?id=9002' }])
  } finally {
    doctorEnv.cleanup()
  }
})

test('doctor followup list without patient context blocks personal fallback', async () => {
  const doctorCalls = []
  const doctorEnv = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [followupApiPath]: {
        listMyFollowups: async () => {
          throw new Error('patient scope should not be used for doctor without patient context')
        },
        listPatientFollowups: async (patientId, params) => {
          doctorCalls.push({ patientId, params })
          return { list: [], total: 0, page: 1, pageSize: 20 }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/index.js')
    const page = doctorEnv.pages[0]

    await page.onLoad()
    await page.retry()

    assert.strictEqual(page.data.scope, 'DOCTOR')
    assert.strictEqual(page.data.patientId, '')
    assert.strictEqual(page.data.error, '请选择患者后再查看随访')
    assert.strictEqual(page.data.followups.length, 0)
    assert.deepStrictEqual(doctorCalls, [])
  } finally {
    doctorEnv.cleanup()
  }
})

test('doctor followup list consumes transient workspace patient context and clears the shared handoff', async () => {
  const doctorCalls = []
  const doctorEnv = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529', currentPatientId: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [followupApiPath]: {
        listMyFollowups: async () => {
          throw new Error('patient scope should not be used for doctor workspace handoff')
        },
        listPatientFollowups: async (patientId, params) => {
          doctorCalls.push({ patientId, params })
          return { list: [{ id: 9003, visitDate: '2026-08-29T09:00:00', patientStatusText: '稳定' }], total: 1, page: 1, pageSize: 20 }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/index.js')
    const page = doctorEnv.pages[0]

    await page.onLoad()

    assert.strictEqual(page.data.scope, 'DOCTOR')
    assert.strictEqual(page.data.patientId, '768495013408443')
    assert.deepStrictEqual(doctorCalls, [{ patientId: '768495013408443', params: { page: 1, pageSize: 20 } }])
    assert.strictEqual(doctorEnv.app.globalData.currentPatientId, undefined)
  } finally {
    doctorEnv.cleanup()
  }
})

test('doctor followup creation keeps patient identifier out of route query and detail consumes transient context', async () => {
  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [followupApiPath]: {
        listMyFollowups: async () => {
          throw new Error('patient scope should not be used for doctor followup creation')
        },
        listPatientFollowups: async () => ({ list: [], total: 0, page: 1, pageSize: 20 })
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/index.js')
    loadPage('miniprogram/pages/followups/detail.js')
    const indexPage = env.pages[0]
    const detailPage = env.pages[1]

    indexPage.setData({ canEdit: true, patientId: '768495013408443' })
    indexPage.createFollowup()

    assert.deepStrictEqual(env.navigations, [{ url: '/pages/followups/detail' }])
    assert.strictEqual(env.app.globalData.currentPatientId, '768495013408443')

    await detailPage.onLoad()

    assert.strictEqual(detailPage.data.canEdit, true)
    assert.strictEqual(detailPage.data.patientId, '768495013408443')
    assert.strictEqual(detailPage.data.form.patientId, '768495013408443')
    assert.strictEqual(env.app.globalData.currentPatientId, undefined)
  } finally {
    env.cleanup()
  }
})

test('doctor followup detail ignores route patient id and consumes transient context', async () => {
  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529', currentPatientId: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [followupApiPath]: {
        buildPayload: payload => JSON.parse(JSON.stringify(payload)),
        validateFollowup: () => ({ ok: true, errors: {} })
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/detail.js')
    const page = env.pages[0]

    await page.onLoad({ patientId: 'route-leak' })

    assert.strictEqual(page.data.canEdit, true)
    assert.strictEqual(page.data.patientId, '768495013408443')
    assert.strictEqual(page.data.form.patientId, '768495013408443')
    assert.strictEqual(env.app.globalData.currentPatientId, undefined)
  } finally {
    env.cleanup()
  }
})

test('followup detail blocks invalid submit, saves drafts, and uploads photos', async () => {
  const calls = []
  let allowSubmit = false
  const env = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [followupApiPath]: {
        buildPayload: payload => JSON.parse(JSON.stringify(payload)),
        getFollowup: async () => ({ id: '9001', patientId: '768495013408443', visitDate: '2026-08-27T09:00:00', catAnswers: [0, 1, 2, 3, 4, 5, 0, 1], photos: [] }),
        validateFollowup: payload => {
          if (!allowSubmit || !payload.visitDate || !Array.isArray(payload.catAnswers) || payload.catAnswers.length !== 8) {
            return {
              ok: false,
              errors: {
                visitDate: '随访日期必填',
                catAnswers: 'CAT 8 项必须齐全且每项 0-5'
              }
            }
          }
          return { ok: true, errors: {} }
        },
        saveFollowupDraft: async payload => {
          calls.push(['draft', payload])
          return { id: 'draft-1', patientId: String(payload.patientId || '768495013408443') }
        },
        saveFollowup: async payload => {
          calls.push(['submit', payload])
          return { id: 'record-1', patientId: String(payload.patientId || '768495013408443') }
        },
        updateFollowup: async (id, payload) => {
          calls.push(['update', id, payload])
          return { id, patientId: String(payload.patientId || '768495013408443') }
        },
        uploadPhoto: async filePath => {
          calls.push(['upload', filePath])
          return { url: 'https://cdn.example/photo.jpg', fileName: 'photo.jpg', fileSize: 1024 }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/followups/detail.js')
    const page = env.pages[0]

    await page.onLoad({ patientId: '768495013408443' })
    page.setData({
      form: Object.assign({}, page.data.form, {
        patientId: '768495013408443',
        visitDate: '',
        catAnswers: [0, 1],
        photos: []
      })
    })

    await page.submit()
    assert.strictEqual(page.data.error, '随访日期必填')
    assert.strictEqual(calls.some(item => item[0] === 'submit'), false)

    await page.saveDraft()
    assert.strictEqual(calls[0][0], 'draft')
    assert.strictEqual(calls[0][1].patientId, '768495013408443')

    await page.addPhoto()
    assert.strictEqual(page.data.form.photos[0].url, 'https://cdn.example/photo.jpg')

    allowSubmit = true
    page.setData({
      error: '',
      form: Object.assign({}, page.data.form, {
        visitDate: '2026-08-28T09:00:00',
        catAnswers: [0, 1, 2, 3, 4, 5, 0, 1],
        patientStatus: 1,
        visitType: 1
      })
    })
    await page.submit()

    assert.strictEqual(calls[calls.length - 1][0], 'update')
    assert.strictEqual(calls.find(item => item[0] === 'upload')[1], '/tmp/photo.jpg')
  } finally {
    env.cleanup()
  }
})

test('messages page marks one message read and refreshes unread count', async () => {
  const calls = []
  const env = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '768495013408443' })
      },
      [messageApiPath]: {
        listMessages: async () => {
          calls.push(['list'])
          return {
            list: [
              { id: 1001, title: '复诊提醒', content: '请按时随访', read: false, createTime: '2026-08-28T09:00:00' }
            ],
            total: 1,
            page: 1,
            pageSize: 20
          }
        },
        getUnreadCount: async () => {
          calls.push(['count'])
          return { count: 1 }
        },
        markMessageRead: async id => {
          calls.push(['read', id])
        },
        markAllMessagesRead: async () => {
          calls.push(['read-all'])
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/messages/index.js')
    const page = env.pages[0]

    await page.onLoad()
    await page.onMessageTap({ currentTarget: { dataset: { id: '1001' } } })
    await page.markAllRead()

    assert.strictEqual(page.data.unreadCount, 1)
    assert.strictEqual(page.data.messages[0].id, '1001')
    assert.deepStrictEqual(calls, [
      ['list'],
      ['count'],
      ['read', '1001'],
      ['list'],
      ['count'],
      ['read-all'],
      ['list'],
      ['count']
    ])
  } finally {
    env.cleanup()
  }
})

test('messages page normalizes records and items response shapes before rendering', async () => {
  const env = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '768495013408443' })
      },
      [messageApiPath]: {
        listMessages: async () => ({
          records: [
            { id: 1002, patientId: 768495013408443, alertId: 2002, title: '复诊短信', content: '请查看记录', read: true, createTime: '2026-08-28T10:00:00' }
          ],
          total: 1,
          page: 1,
          pageSize: 20
        }),
        getUnreadCount: async () => ({ count: 0 })
      }
    }
  })
  try {
    loadPage('miniprogram/pages/messages/index.js')
    const page = env.pages[0]

    await page.onLoad()

    assert.strictEqual(page.data.messages[0].id, '1002')
    assert.strictEqual(page.data.messages[0].patientId, '768495013408443')
  } finally {
    env.cleanup()
  }
})

test('statistics page loads patient and doctor scopes using the selected time range', async () => {
  const patientCalls = []
  const patientEnv = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '768495013408443' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '768495013408443' })
      },
      [statsApiPath]: {
        getMyStats: async () => {
          patientCalls.push(['my'])
          return { totalFollowups: 18, myPatients: 9, thisMonth: 4, avgPerDay: 1.5 }
        },
        getMyFollowupStats: async params => {
          patientCalls.push(['followups', params])
          return {
            totalCount: 18,
            patientCount: 9,
            byMonth: [{ month: '2026-08', count: 6 }],
            byType: [{ type: 1, count: 4, name: '常规随访' }]
          }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/statistics/index.js')
    const page = patientEnv.pages[0]

    await page.onLoad()

    assert.strictEqual(page.data.mode, 'PATIENT')
    assert.deepStrictEqual(patientCalls[0], ['my'])
    assert.strictEqual(patientCalls[1][0], 'followups')
    assert.strictEqual(typeof patientCalls[1][1].startDate, 'string')
    assert.strictEqual(typeof patientCalls[1][1].endDate, 'string')
    assert.strictEqual(page.data.summaryCards[0].value, '18')
  } finally {
    patientEnv.cleanup()
  }

  const doctorCalls = []
  const doctorEnv = installPageEnv({
    session: { activeRole: 'DOCTOR', orgId: '1972545374712086529' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'DOCTOR', orgId: '1972545374712086529' })
      },
      [statsApiPath]: {
        getHomeStats: async () => {
          doctorCalls.push(['home'])
          return { totalPatients: 12, todayPending: 2, todayCompleted: 4, highRiskCount: 1, upcoming3Days: 3, todayDate: '2026-08-28' }
        },
        getStatsDetail: async params => {
          doctorCalls.push(['detail', params])
          return {
            followupRate: { target: 100, completed: 82, rate: 82 },
            patientStats: { total: 12, newThisMonth: 2, highRisk: 1, pending7days: 3 },
            riskDistribution: [{ level: 3, count: 4, name: '高危' }],
            highRiskPatients: [{ patientId: 768495013408443, name: '测试患者2', age: 34, riskLevel: 3, riskLevelText: '高危', catScore: 31, hasAcuteExacerbation: false }]
          }
        }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/statistics/index.js')
    const page = doctorEnv.pages[0]

    await page.onLoad()

    assert.strictEqual(page.data.mode, 'DOCTOR')
    assert.deepStrictEqual(doctorCalls[0], ['home'])
    assert.strictEqual(doctorCalls[1][0], 'detail')
    assert.strictEqual(doctorCalls[1][1].orgId, '1972545374712086529')
    assert.strictEqual(doctorCalls[1][1].month, '2026-08')
    assert.strictEqual(page.data.summaryCards[0].value, '12')
    assert.strictEqual(page.data.highlightRows[0].caption, '')
  } finally {
    doctorEnv.cleanup()
  }
})

test('patient workspace without patientRef only shows the masked prompt and fixed questionnaire url', async () => {
  const env = installPageEnv({
    session: { activeRole: 'PATIENT', patientRef: '' },
    stubs: {
      [authGuardPath]: {
        ensureSession: async () => ({ activeRole: 'PATIENT', patientRef: '' })
      },
      [statsApiPath]: {
        getMyStats: async () => { throw new Error('stats should not load without patientRef') },
        getMyFollowupStats: async () => { throw new Error('stats should not load without patientRef') },
        getHomeStats: async () => { throw new Error('stats should not load without patientRef') },
        getStatsDetail: async () => { throw new Error('stats should not load without patientRef') }
      },
      [messageApiPath]: {
        getUnreadCount: async () => { throw new Error('messages should not load without patientRef') }
      }
    }
  })
  try {
    loadPage('miniprogram/pages/patient/workspace/index.js')
    const page = env.pages[0]

    await page.onLoad()

    assert.strictEqual(page.data.hasPatientRef, false)
    assert.strictEqual(page.data.showWorkspaceContent, false)
    assert.strictEqual(page.data.publicScreeningUrl, 'https://jq.mockr.com.cn/mzf-sq/#/screen')
    assert.deepStrictEqual(env.toasts, [])
  } finally {
    env.cleanup()
  }
})

test('followup detail wxml keeps choice-tile read-only bindings when canEdit is false', () => {
  const wxml = fs.readFileSync(followupDetailWxmlPath, 'utf8')
  assert.ok(wxml.includes('<choice-tile options="{{visitTypeOptions}}" value="{{form.visitType}}" disabled="{{!canEdit}}" bindchange="onChoiceChange" data-field="visitType" />'))
  assert.ok(wxml.includes('<choice-tile options="{{patientStatusOptions}}" value="{{form.patientStatus}}" disabled="{{!canEdit}}" bindchange="onChoiceChange" data-field="patientStatus" />'))
  assert.ok(wxml.includes('<choice-tile options="{{catOptions}}" value="{{form.catAnswers[index]}}" disabled="{{!canEdit}}" bindchange="onCatChange" data-index="{{index}}" />'))
  assert.ok(wxml.includes('<choice-tile options="{{mmrcOptions}}" value="{{form.mmrcOption}}" disabled="{{!canEdit}}" bindchange="onChoiceChange" data-field="mmrcOption" />'))
})
