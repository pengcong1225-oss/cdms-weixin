const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const messageApiPath = path.join(root, 'miniprogram/utils/message-api.js')
const statsApiPath = path.join(root, 'miniprogram/utils/stats-api.js')

function createRequestSpy (responses = []) {
  const calls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  return {
    calls,
    get last () { return calls[calls.length - 1] },
    async cdmsRequest (url, method, data, token) {
      calls.push({ url, method, data, token })
      const response = queue.length ? queue.shift() : { data: null }
      if (response instanceof Error) throw response
      return response
    }
  }
}

function loadMessageStatsApi (spy) {
  delete require.cache[apiPath]
  delete require.cache[messageApiPath]
  delete require.cache[statsApiPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: { cdmsRequest: spy.cdmsRequest.bind(spy) }
  }
  global.getApp = () => ({ globalData: { accessToken: 'access-1' } })
  return {
    messageApi: require(messageApiPath),
    statsApi: require(statsApiPath)
  }
}

test('message APIs load unread counts and mark reads on the server', async () => {
  const spy = createRequestSpy([
    {
      data: {
        list: [
          { id: 1001, patientId: 768495013408443, alertId: 2001, title: '复诊提醒', content: '请按时随访', read: false, createTime: '2026-08-28T09:00:00' }
        ],
        page: 1,
        pageSize: 20,
        total: 1
      }
    },
    { data: { count: 3 } },
    { data: null },
    { data: null }
  ])
  const { messageApi } = loadMessageStatsApi(spy)

  const list = await messageApi.listMessages({ page: 1, pageSize: 20 })
  const unread = await messageApi.getUnreadCount()
  await messageApi.markMessageRead('1001')
  await messageApi.markAllMessagesRead()

  assert.strictEqual(spy.calls[0].url, '/api/v1/messages?page=1&pageSize=20')
  assert.strictEqual(spy.calls[1].url, '/api/v1/messages/unread-count')
  assert.strictEqual(spy.calls[2].url, '/api/v1/messages/1001/read')
  assert.strictEqual(spy.calls[3].url, '/api/v1/messages/read-all')
  assert.strictEqual(list.list[0].id, '1001')
  assert.strictEqual(list.list[0].patientId, '768495013408443')
  assert.strictEqual(list.list[0].read, false)
  assert.deepStrictEqual(unread, { count: 3 })
})

test('stats APIs keep role-specific query params and string ids', async () => {
  const spy = createRequestSpy([
    { data: { totalPatients: 12, todayPending: 2, todayCompleted: 4, highRiskCount: 1, upcoming3Days: 3, todayDate: '2026-08-28' } },
    {
      data: {
        followupRate: { target: 100, completed: 82, rate: 82 },
        patientStats: { total: 12, newThisMonth: 2, highRisk: 1, pending7days: 3 },
        riskDistribution: [{ level: 3, count: 4, name: '高危' }],
        highRiskPatients: [{ patientId: 768495013408443, name: '测试患者2', age: 34, riskLevel: 3, riskLevelText: '高危', catScore: 31, hasAcuteExacerbation: false }]
      }
    },
    {
      data: {
        totalCount: 18,
        patientCount: 9,
        byMonth: [{ month: '2026-08', count: 6 }],
        byType: [{ type: 1, count: 4, name: '常规随访' }]
      }
    },
    { data: { totalFollowups: 18, myPatients: 9, thisMonth: 4, avgPerDay: 1.5 } }
  ])
  const { statsApi } = loadMessageStatsApi(spy)

  const home = await statsApi.getHomeStats()
  const detail = await statsApi.getStatsDetail({ month: '2026-08', orgId: '1972545374712086529' })
  const mine = await statsApi.getMyFollowupStats({ startDate: '2026-08-01', endDate: '2026-08-28' })
  const personal = await statsApi.getMyStats()

  assert.strictEqual(spy.calls[0].url, '/api/v1/stats/home')
  assert.strictEqual(spy.calls[1].url, '/api/v1/stats/detail?month=2026-08&org_id=1972545374712086529')
  assert.strictEqual(spy.calls[2].url, '/api/v1/stats/my-followups?start_date=2026-08-01&end_date=2026-08-28')
  assert.strictEqual(spy.calls[3].url, '/api/v1/stats/my')
  assert.strictEqual(detail.patientStats.total, 12)
  assert.strictEqual(detail.highRiskPatients[0].patientId, '768495013408443')
  assert.strictEqual(mine.byMonth[0].month, '2026-08')
  assert.strictEqual(personal.totalFollowups, 18)
  assert.strictEqual(home.totalPatients, 12)
})
