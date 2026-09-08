/**
 * 客户端幂等框架（阶段三交付项 2，设计 §14）：一次用户动作一个 key，
 * 明确成功 / 业务拒绝(4xx)前复用同 key；网络超时/5xx/409 重试不换 key；
 * 成功消费后清除；跨动作不串。
 * 风格对齐现有 *.test.js：require + assert，直接 node test/idempotency-key.test.js 运行。
 */
const assert = require('assert')
const idempotency = require('../miniprogram/utils/idempotency')
const stationApi = require('../miniprogram/utils/station-api')

function networkError () { const e = new Error('timeout'); return e }
function httpError (status) {
  const e = new Error('HTTP ' + status)
  e.statusCode = status
  return e
}

// ---- key 生成：默认形态与 station-api 前缀注入 ----

const raw = idempotency.createIdempotencyKey('station-next')
assert.ok(raw.startsWith('station-next-'), '生成 key 带动作前缀')
assert.notStrictEqual(idempotency.createIdempotencyKey('a'), idempotency.createIdempotencyKey('a'), '两次生成不同 key')

// 注入 station-api 生成器：页面迁移后 key 前缀形态不变（既有测试锁定 'station-draft-' 等）
const tracker = idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey })
assert.ok(tracker.key('station-draft').startsWith('station-draft-'), '注入生成器保持既有前缀形态')

// ---- 一次动作一个 key：成功前始终同 key ----

const t1 = idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey })
const key1 = t1.key('station-next')
const key2 = t1.key('station-next')
assert.strictEqual(key1, key2, '未消费前多次取 key 返回同一个 key')
assert.strictEqual(t1.peek('station-next'), key1)

// 网络层错误（无 statusCode）→ retryable：保留 key
assert.strictEqual(idempotency.isRetryableFailure(networkError()), true, '网络超时视为可重试')
assert.strictEqual(idempotency.isRetryableFailure(httpError(500)), true, '5xx 视为可重试')
assert.strictEqual(idempotency.isRetryableFailure(httpError(502)), true, '5xx 视为可重试')
assert.strictEqual(idempotency.isRetryableFailure(httpError(409)), true, '409 冲突保留 key（刷新后同动作重试）')
assert.strictEqual(idempotency.isRetryableFailure(undefined), true, '未知失败按可重试处理')
assert.strictEqual(idempotency.isRejectedFailure(httpError(500)), false)

// 业务拒绝（4xx 非 409）→ 消费 key
for (const status of [400, 401, 403, 404, 410, 422]) {
  assert.strictEqual(idempotency.isRejectedFailure(httpError(status)), true, status + ' 属业务拒绝')
  assert.strictEqual(idempotency.isRetryableFailure(httpError(status)), false, status + ' 不再可重试')
}

// ---- 成功消费：release 后下一次取 key 是新的 ----

t1.release('station-next')
const key3 = t1.key('station-next')
assert.notStrictEqual(key3, key1, '成功消费后新动作拿新 key')
assert.strictEqual(t1.has('station-next'), true, '新 key 已入池')
t1.release('station-next')
assert.strictEqual(t1.has('station-next'), false, '消费后动作 key 被清除')
assert.strictEqual(t1.peek('station-next'), '', 'peek 返回空串表示无待定 key')

// ---- 业务拒绝消费语义：拒绝后重试得到新 key（同动作）----

const t2 = idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey })
const rejectedFirst = t2.key('station-create')
// 服务端 400 业务拒绝 → 本次动作终结
t2.release('station-create')
const rejectedRetry = t2.key('station-create')
assert.notStrictEqual(rejectedRetry, rejectedFirst, '业务拒绝后重试是新动作（新 key）')

// ---- 网络超时复用语义：失败不 release，重试得到同一个 key ----

const t3 = idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey })
const timeoutFirst = t3.key('station-skip')
// 超时 → 不消费 key
assert.strictEqual(idempotency.isRetryableFailure(networkError()), true)
const timeoutRetry = t3.key('station-skip')
assert.strictEqual(timeoutRetry, timeoutFirst, '网络超时重试必须复用同一 key')
t3.release('station-skip')
assert.notStrictEqual(t3.key('station-skip'), timeoutFirst, '最终成功后新动作换新 key')

// ---- 跨动作不串：不同动作 key 互不影响 ----

const t4 = idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey })
const createKey = t4.key('station-create')
const draftKey = t4.key('station-draft')
const confirmKey = t4.key('station-confirm')
assert.notStrictEqual(createKey, draftKey)
assert.notStrictEqual(draftKey, confirmKey)
assert.notStrictEqual(createKey, confirmKey)
t4.release('station-create')
assert.strictEqual(t4.peek('station-create'), '', '释放一个动作不影响其他动作')
assert.strictEqual(t4.peek('station-draft'), draftKey, '其他动作 key 保持待定')
t4.releaseAll()
assert.strictEqual(t4.size(), 0, 'releaseAll 清空全部待定 key')

// ---- 页面用法端到端：草稿失败（网络）保留 key、业务拒绝才消费 ----

const pageLike = { tracker: idempotency.createIdempotencyTracker({ generator: stationApi.createIdempotencyKey }) }
pageLike.actionKey = name => pageLike.tracker.key(name)
pageLike.settleIfRejected = (name, error) => { if (idempotency.isRejectedFailure(error)) pageLike.tracker.release(name) }
pageLike.settle = name => pageLike.tracker.release(name)

const draftK1 = pageLike.actionKey('station-draft')
// 网络超时失败：保留
pageLike.settleIfRejected('station-draft', networkError())
assert.strictEqual(pageLike.actionKey('station-draft'), draftK1, '超时后重试沿用同一草稿 key')
// 5xx 失败：保留
pageLike.settleIfRejected('station-draft', httpError(503))
assert.strictEqual(pageLike.actionKey('station-draft'), draftK1, '5xx 后重试沿用同一草稿 key')
// 409 冲突：保留
pageLike.settleIfRejected('station-draft', httpError(409))
assert.strictEqual(pageLike.actionKey('station-draft'), draftK1, '409 后按刷新重试沿用同一草稿 key')
// 明确成功：消费
pageLike.settle('station-draft')
assert.strictEqual(pageLike.tracker.peek('station-draft'), '', '明确成功消费 key')
assert.notStrictEqual(pageLike.actionKey('station-draft'), draftK1, '下一动作是新 key')
// 业务拒绝 400：消费
const draftK2 = pageLike.actionKey('station-draft')
pageLike.settleIfRejected('station-draft', httpError(400))
assert.strictEqual(pageLike.tracker.peek('station-draft'), '', '业务拒绝消费 key')
assert.notStrictEqual(pageLike.actionKey('station-draft'), draftK2, '拒绝后重试是新 key')

console.log('idempotency key tests passed')
