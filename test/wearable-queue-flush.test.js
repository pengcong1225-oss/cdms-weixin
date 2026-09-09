const assert = require('assert')
const path = require('path')

const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')

function scenario (statuses) {
  const values = new Map()
  const requests = []
  global.getApp = () => ({ globalData: { patientRef: 'patient-1' } })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    request: options => {
      requests.push(options)
      const statusCode = statuses[requests.length - 1] || 200
      setImmediate(() => options.success(statusCode >= 200 && statusCode < 300
        ? { statusCode, data: { accepted: 1, duplicates: 0, rejected: 0 } }
        : { statusCode, data: { code: `HTTP-${statusCode}`, message: 'retry later' } }))
    }
  }
  delete require.cache[apiPath]
  return { api: require(apiPath), values, requests }
}

async function run () {
  {
    const { api, requests } = scenario([])
    api.enqueue({ batchId: 'a-1', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
    api.enqueue({ batchId: 'a-2', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
    api.enqueue({ batchId: 'a-2', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
    api.enqueue({ batchId: 'b-1', patientRef: 'patient-1', deviceRef: 'ring-b', sessionId: 'session-b' })

    const first = api.flushQueue({
      baseUrl: 'https://iot',
      token: 'token-a',
      scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
    })
    const second = api.flushQueue({
      baseUrl: 'https://iot',
      token: 'token-a',
      scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
    })
    const result = await Promise.all([first, second])
    assert.deepStrictEqual(result[0], { accepted: 2, duplicates: 0, rejected: 0 })
    assert.deepStrictEqual(result[1], result[0], 'same queue flush should share one lock/result')
    assert.deepStrictEqual(requests.map(item => item.data.batchId), ['a-1', 'a-2'])
    assert.deepStrictEqual(api.readQueue('patient-1', 'ring-a', 'session-a'), [])
    assert.deepStrictEqual(api.readQueue('patient-1', 'ring-b', 'session-b').map(item => item.batchId), ['b-1'])
  }

  {
    const { api, requests } = scenario([500])
    api.enqueue({ batchId: 'a-1', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
    api.enqueue({ batchId: 'a-2', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
    await assert.rejects(() => api.flushQueue({
      baseUrl: 'https://iot',
      token: 'token-a',
      scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
    }), error => error.statusCode === 500)
    assert.strictEqual(requests.length, 1)
    assert.deepStrictEqual(api.readQueue('patient-1', 'ring-a', 'session-a').map(item => item.batchId), ['a-1', 'a-2'])
  }

  {
    const { api, requests } = scenario([400])
    api.enqueue({ batchId: 'a-1', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' })
    await assert.rejects(() => api.flushQueue({
      baseUrl: 'https://iot',
      token: 'token-a',
      scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-a' }
    }), error => error.statusCode === 400)
    assert.strictEqual(requests.length, 1, 'non-retryable 4xx must not loop internally')
    assert.strictEqual(api.readQueue('patient-1', 'ring-a', 'session-a').length, 1)
  }

  {
    const { api, requests } = scenario([])
    api.enqueue({ batchId: 'old', patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-old' })
    const result = await api.flushQueue({
      baseUrl: 'https://iot',
      token: 'token-new',
      scope: { patientRef: 'patient-1', deviceRef: 'ring-a', sessionId: 'session-new' }
    })
    assert.deepStrictEqual(result, { accepted: 0, duplicates: 0, rejected: 0 })
    assert.strictEqual(requests.length, 0, 'a token for another session must never upload the old batch')
    assert.strictEqual(api.readQueue('patient-1', 'ring-a', 'session-old').length, 1)
  }

  console.log('Wearable queue flush tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
