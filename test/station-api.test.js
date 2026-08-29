const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const stationApiPath = path.join(root, 'miniprogram/utils/station-api.js')

function loadStationApi (responses = []) {
  const calls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  delete require.cache[apiPath]
  delete require.cache[stationApiPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: {
      cdmsRequest: async (url, method, data) => {
        calls.push({ url, method, data })
        return queue.length ? queue.shift() : { data: null }
      }
    }
  }
  const stationApi = require(stationApiPath)
  return { stationApi, calls }
}

test('station api sends opaque station and checkin payloads with idempotency keys', async () => {
  const { stationApi, calls } = loadStationApi([
    { data: { id: 'station-1', status: 'OPEN', checkinToken: 'token-1', queue: [] } },
    { data: { id: 'station-1', status: 'OPEN', queue: [] } },
    { data: { id: 'station-1', status: 'OPEN', queue: [{ id: 'queue-1', status: 'CALLED' }] } },
    { data: { id: 'station-1', status: 'OPEN', queue: [{ id: 'queue-1', status: 'RESULT_PENDING' }] } },
    { data: { id: 'station-1', status: 'OPEN', queue: [{ id: 'queue-1', status: 'COMPLETED' }] } },
    { data: { id: 'station-1', status: 'CLOSED' } }
  ])

  await stationApi.createStation({ stationName: '轮测场次', idempotencyKey: 'create-1' })
  await stationApi.createCheckin('station-1', 'opaque-token', { idempotencyKey: 'scan-1' })
  await stationApi.callNext('station-1', { idempotencyKey: 'next-1' })
  await stationApi.saveMeasurementDraft('station-1', 'queue-1', {
    idempotencyKey: 'draft-1',
    deviceId: 'scale-1',
    measuredAt: '2026-08-29T09:00:00',
    gender: 1,
    age: 68,
    height: 172,
    metrics: [{ type: 'weight', value: 65.2, unit: 'kg' }]
  })
  await stationApi.confirmMeasurement('station-1', 'queue-1', 'draft-1', { idempotencyKey: 'confirm-1' })
  await stationApi.closeStation('station-1', { idempotencyKey: 'close-1', discardDraftIds: ['draft-1'] })

  assert.deepStrictEqual(calls[0], {
    url: '/api/v1/miniapp/scale/stations',
    method: 'POST',
    data: { stationName: '轮测场次', idempotencyKey: 'create-1' }
  })
  assert.deepStrictEqual(calls[1], {
    url: '/api/v1/miniapp/scale/stations/station-1/checkins',
    method: 'POST',
    data: { checkinToken: 'opaque-token', idempotencyKey: 'scan-1' }
  })
  assert.strictEqual(Object.prototype.hasOwnProperty.call(calls[1].data, 'patientId'), false)
  assert.deepStrictEqual(calls[2], {
    url: '/api/v1/miniapp/scale/stations/station-1/call-next',
    method: 'POST',
    data: { idempotencyKey: 'next-1' }
  })
  assert.deepStrictEqual(calls[3], {
    url: '/api/v1/miniapp/scale/stations/station-1/queue/queue-1/draft',
    method: 'POST',
    data: {
      idempotencyKey: 'draft-1',
      deviceId: 'scale-1',
      measuredAt: '2026-08-29T09:00:00',
      gender: 1,
      age: 68,
      height: 172,
      metrics: [{ type: 'weight', value: 65.2, unit: 'kg' }]
    }
  })
  assert.deepStrictEqual(calls[4], {
    url: '/api/v1/miniapp/scale/stations/station-1/queue/queue-1/drafts/draft-1/confirm',
    method: 'POST',
    data: { idempotencyKey: 'confirm-1' }
  })
  assert.deepStrictEqual(calls[5], {
    url: '/api/v1/miniapp/scale/stations/station-1/close',
    method: 'POST',
    data: { idempotencyKey: 'close-1', discardDraftIds: ['draft-1'] }
  })
})

test('station reducer blocks a second active queue item', () => {
  const { reduceStationState } = require(stationApiPath)
  const next = reduceStationState({
    status: 'OPEN',
    activeQueueItemId: 'queue-1',
    queue: [
      { id: 'queue-1', status: 'CALLED' },
      { id: 'queue-2', status: 'WAITING' }
    ]
  }, { type: 'CALL_NEXT' })

  assert.strictEqual(next.error, '当前已有患者正在测量')
  assert.strictEqual(next.queue[0].status, 'CALLED')
})

test('station reducer promotes the first waiting queue item', () => {
  const { reduceStationState } = require(stationApiPath)
  const next = reduceStationState({
    status: 'OPEN',
    queue: [
      { id: 'queue-1', status: 'WAITING' },
      { id: 'queue-2', status: 'WAITING' }
    ]
  }, { type: 'CALL_NEXT' })

  assert.strictEqual(next.error, '')
  assert.strictEqual(next.activeQueueItemId, 'queue-1')
  assert.strictEqual(next.queue[0].status, 'CALLED')
  assert.strictEqual(next.queue[1].status, 'WAITING')
})
