/**
 * 客户端持久化幂等框架（设计 §14，阶段三收敛）。
 *
 * 客户端规则（§14.6）：
 * - 一次用户动作只生成一个 key，直到「明确成功」或「业务拒绝（4xx）」才消费；
 * - 网络超时 / 5xx / 结果未知的重试【复用同一 key】，绝不中途换新；
 * - 409 状态冲突保留 key：修正前置状态（如按服务端回传刷新后重试）仍属同一动作；
 * - key 在成功消费后清除，下一个动作才拿到新 key；不同动作互不串用。
 *
 * 本模块为纯框架、零依赖、ES2018；key 生成器由调用方注入（页面统一注入
 * station-api.createIdempotencyKey 以保持 'station-*-' 前缀形态）。
 */

/** 生成随机不可猜测的幂等 key（与 station-api.writePayload 的缺省形态一致）。 */
function createIdempotencyKey (prefix = 'action') {
  return `${String(prefix)}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`
}

function statusCodeOf (error) {
  if (!error || typeof error !== 'object') return NaN
  const code = Number(error && (error.statusCode || error.code))
  return Number.isFinite(code) ? code : NaN
}

/**
 * 该失败是否应【保留】幂等 key 等待重试：
 * - 无状态码（网络层/超时/未知）→ 保留；
 * - 5xx → 保留（服务端可能已执行，重试必须同 key）；
 * - 409 → 保留（冲突后按同一动作刷新重试，§14）；
 * - 其余 4xx（400/401/403/404/410/422…）= 业务拒绝，key 被消费，下次动作换新。
 */
function isRetryableFailure (error) {
  const code = statusCodeOf(error)
  if (!Number.isFinite(code) || code === 0) return true
  if (code >= 500) return true
  return code === 409
}

/** 业务拒绝（definitive 4xx）：本次动作终结，key 可消费。 */
function isRejectedFailure (error) {
  return !isRetryableFailure(error)
}

/**
 * 动作级 key 追踪器：key(name) 返回【该动作当前持有】的 key（首次调用才生成），
 * release(name) 在明确成功 / 业务拒绝时消费，releaseAll() 用于会话终结（410/关闭/换人）。
 */
function createIdempotencyTracker (options = {}) {
  const pending = new Map()
  const generator = typeof options.generator === 'function' ? options.generator : createIdempotencyKey
  const normalize = name => String(name === null || name === undefined ? 'action' : name)
  return {
    key (name) {
      const id = normalize(name)
      let entry = pending.get(id)
      if (!entry) {
        entry = { key: generator(id) }
        pending.set(id, entry)
      }
      return entry.key
    },
    peek (name) {
      const entry = pending.get(normalize(name))
      return entry ? entry.key : ''
    },
    has (name) {
      return pending.has(normalize(name))
    },
    release (name) {
      pending.delete(normalize(name))
    },
    releaseAll () {
      pending.clear()
    },
    size () {
      return pending.size
    }
  }
}

module.exports = {
  createIdempotencyKey,
  createIdempotencyTracker,
  isRejectedFailure,
  isRetryableFailure,
  statusCodeOf
}
