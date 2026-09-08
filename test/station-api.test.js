const assert = require('assert')
const api = require('../miniprogram/utils/api')
const stationApi = require('../miniprogram/utils/station-api')

// ---- normalizeStation / normalizeQueueItem ----

// 雪花 ID 一律以字符串形式进入客户端（超出 Number 精度，服务端按字符串返回）
const station = stationApi.normalizeStation({
  data: {
    id: '1972545374712086529',
    orgId: '9001',
    status: 'OPEN',
    deviceType: 'MFA1',
    checkinToken: 'tok-1',
    tokenExpiresAt: '2026-08-30T10:00:00',
    queue: [{
      id: '551',
      queueNo: 3,
      status: 'WAITING',
      patientSummary: { maskedName: '张*生', gender: 1, age: 68, height: 172 },
      metrics: [{ type: 'weight', value: 71.5, unit: 'kg' }],
      patientId: '768495013408443'
    }]
  }
})

// 所有 ID 必须按字符串处理；超出 Number 安全范围的雪花 ID 不能被数值化
assert.strictEqual(station.id, '1972545374712086529')
assert.strictEqual(String(Number(station.id)) === station.id, false, 'snowflake id must not round-trip through Number')
assert.strictEqual(station.orgId, '9001')
// 设备类型字段透传保留（SCALE / MFA1 共用一套场次状态机）
assert.strictEqual(station.deviceType, 'MFA1')
assert.strictEqual(station.queue[0].id, '551')
assert.strictEqual(station.queue[0].queueNo, 3)
assert.deepStrictEqual(station.queue[0].patientSummary, {
  maskedName: '张*生', gender: 1, genderText: '', age: 68, height: 172, heightText: '', bmi: ''
})

// 安全不变量：原始患者 ID 不得进入客户端队列状态
assert.strictEqual(station.queue[0].patientId, undefined)

// 顶层/嵌套 null 与缺省字段回填
const empty = stationApi.normalizeStation({})
assert.strictEqual(empty.status, 'OPEN')
assert.strictEqual(empty.id, '')
assert.strictEqual(empty.deviceType, 'SCALE')
assert.deepStrictEqual(empty.queue, [])

const wrapped = stationApi.normalizeStation({ data: null })
assert.strictEqual(wrapped.status, 'OPEN')

// ---- 幂等键 ----

const keyA = stationApi.createIdempotencyKey('station-create')
const keyB = stationApi.createIdempotencyKey('station-create')
assert.ok(keyA.startsWith('station-create-'))
assert.ok(keyB.startsWith('station-create-'))
assert.notStrictEqual(keyA, keyB)

;(async () => {
  // ---- 请求路径与载荷（桩掉 cdmsRequest） ----

  const calls = []
  const originalCdmsRequest = api.cdmsRequest
  api.cdmsRequest = async (path, method, body) => {
    calls.push({ path, method, body })
    return { data: { id: '197', status: 'OPEN', checkinToken: 'tok' } }
  }
  // 本用例固定走 v1 通道（灰度回退路径回归）；v2 device-stations 见 test/device-station-phase2.test.js
  stationApi.setStationApiVersion('v1')

  try {
    await stationApi.createStation({ stationName: '体脂秤轮测场次' })
    assert.strictEqual(calls[0].path, '/api/v1/miniapp/scale/stations')
    assert.strictEqual(calls[0].method, 'POST')
    assert.ok(calls[0].body.idempotencyKey.startsWith('station-create-'))
    // 未显式指定设备类型时不携带 deviceType 字段，由服务端缺省 SCALE
    assert.strictEqual(calls[0].body.deviceType, undefined)

    await stationApi.createCheckin('197', 'tok-xyz')
    assert.strictEqual(calls[1].path, '/api/v1/miniapp/scale/stations/197/checkins')
    assert.strictEqual(calls[1].body.checkinToken, 'tok-xyz')
    // 签到载荷不允许提交患者身份字段
    assert.strictEqual(calls[1].body.patientId, undefined)
    assert.strictEqual(calls[1].body.orgId, undefined)

    await stationApi.getTodayQueue('197')
    assert.strictEqual(calls[2].path, '/api/v1/miniapp/scale/stations/197/queue')
    assert.strictEqual(calls[2].method, 'GET')

    await stationApi.callNext('197')
    assert.strictEqual(calls[3].path, '/api/v1/miniapp/scale/stations/197/call-next')

    await stationApi.skipQueueItem('197', '551')
    assert.strictEqual(calls[4].path, '/api/v1/miniapp/scale/stations/197/queue/551/skip')

    await stationApi.requeueQueueItem('197', '551')
    assert.strictEqual(calls[5].path, '/api/v1/miniapp/scale/stations/197/queue/551/requeue')

    await stationApi.saveMeasurementDraft('197', '551', {
      deviceId: 'dev-1', measuredAt: '2026-08-30T10:00:00', gender: 1, age: 68, height: 172,
      metrics: [{ name: 'weight', value: 71.5, unit: 'kg' }]
    })
    assert.strictEqual(calls[6].path, '/api/v1/miniapp/scale/stations/197/queue/551/draft')
    // 草稿 metrics 统一使用 type 字段并附幂等键
    assert.deepStrictEqual(calls[6].body.metrics, [{ type: 'weight', value: 71.5, unit: 'kg' }])
    assert.ok(calls[6].body.idempotencyKey.startsWith('station-draft-'))

    await stationApi.confirmMeasurement('197', '551', '900')
    assert.strictEqual(calls[7].path, '/api/v1/miniapp/scale/stations/197/queue/551/drafts/900/confirm')

    await stationApi.closeStation('197', { discardDraftIds: ['900', '', null] })
    assert.strictEqual(calls[8].path, '/api/v1/miniapp/scale/stations/197/close')
    assert.deepStrictEqual(calls[8].body.discardDraftIds, ['900'])

    await stationApi.createStation({ stationName: 'MFA-1 血糖轮测场次', deviceType: 'MFA1' })
    assert.strictEqual(calls[9].path, '/api/v1/miniapp/scale/stations')
    assert.strictEqual(calls[9].body.deviceType, 'MFA1', 'createStation 必须透传 deviceType')
    assert.ok(calls[9].body.idempotencyKey.startsWith('station-create-'))

  } finally {
    api.cdmsRequest = originalCdmsRequest
    stationApi.setStationApiVersion('v2')
  }

  // ---- 场次状态机 ----

  const waiting = { id: '551', status: 'WAITING' }
  const state0 = stationApi.reduceStationState({ queue: [waiting] }, { type: 'CALL_NEXT' })
  assert.strictEqual(state0.activeQueueItemId, '551')
  assert.strictEqual(state0.queue[0].status, 'CALLED')
  assert.strictEqual(state0.error, '')

  // 已有激活患者时禁止叫下一位
  const busy = stationApi.reduceStationState({ queue: [{ id: '551', status: 'MEASURING' }, { id: '552', status: 'WAITING' }] }, { type: 'CALL_NEXT' })
  assert.strictEqual(busy.error, '当前已有患者正在测量')

  // 空队列叫号提示
  const idle = stationApi.reduceStationState({ queue: [] }, { type: 'CALL_NEXT' })
  assert.strictEqual(idle.error, '暂无待测患者')

  // 错误的患者上下文不得推进状态
  const mismatch = stationApi.reduceStationState({ activeQueueItemId: '551', queue: [waiting] }, { type: 'SAVE_DRAFT', queueItemId: '999', draftId: 'd1' })
  assert.strictEqual(mismatch.error, '当前患者不匹配')
  assert.strictEqual(mismatch.currentDraftId, '')

  // 草稿→确认→完成
  let machine = stationApi.reduceStationState({ queue: [waiting] }, { type: 'CALL_NEXT' })
  machine = stationApi.reduceStationState(machine, { type: 'SAVE_DRAFT', queueItemId: '551', draftId: 'd1' })
  assert.strictEqual(machine.currentDraftId, 'd1')
  assert.strictEqual(machine.currentDraftStatus, 'RESULT_PENDING')
  assert.strictEqual(machine.queue[0].status, 'RESULT_PENDING')
  machine = stationApi.reduceStationState(machine, { type: 'CONFIRM_MEASUREMENT', queueItemId: '551', draftId: 'd1' })
  assert.strictEqual(machine.queue[0].status, 'COMPLETED')
  assert.strictEqual(machine.currentDraftStatus, 'CONFIRMED')
  assert.strictEqual(machine.activeQueueItemId, '')

  // 跳过与重排
  machine = stationApi.reduceStationState(machine, { type: 'REQUEUE_QUEUE_ITEM', queueItemId: '551' })
  assert.strictEqual(machine.queue[0].status, 'WAITING')
  machine = stationApi.reduceStationState(machine, { type: 'SKIP_QUEUE_ITEM', queueItemId: '551' })
  assert.strictEqual(machine.queue[0].status, 'SKIPPED')

  // 关闭场次
  machine = stationApi.reduceStationState(machine, { type: 'CLOSE' })
  assert.strictEqual(machine.status, 'CLOSED')
  assert.strictEqual(machine.currentDraftId, '')

  console.log('station api tests passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})