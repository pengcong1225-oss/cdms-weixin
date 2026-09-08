/**
 * 安全签到二维码解析（设计 §12 / §17，阶段三收敛）。
 *
 * 二维码内容分两代：
 * - NEW（v2 安全码）：严格 JSON，仅允许 {\"version\":1,\"scene\":...,\"token\":...} 三个字段，
 *   token 为服务端签发的不透明令牌。未知 version / 未知 scene / 多余字段 / 非字符串 token /
 *   结构异常一律返回 null —— 失败关闭（fail-closed），由调用方提示重新扫描。
 * - LEGACY（老协议，v1 过渡）：cdms://scale-checkin?stationId=...&token=...（设备场次码）与
 *   cdms://checkin?orgId=...（通用机构码）。老码继续走 v1 通道，行为零改动。
 *
 * 本模块是纯函数、零依赖、ES2018，可直接被 node 测试 require。
 */
const QR_VERSION = 1
const CHECKIN_SCENES = ['ORG_CHECKIN', 'DEVICE_STATION']
const MAX_TOKEN_LENGTH = 4096
const LEGACY_STATION_PREFIX = 'cdms://scale-checkin?'
const LEGACY_GENERIC_PREFIX = 'cdms://checkin?'

function parseQueryParams (query) {
  const params = {}
  String(query || '').split('&').forEach(pair => {
    const index = pair.indexOf('=')
    if (index < 1) return
    const key = decodeURIComponent(pair.slice(0, index))
    params[key] = decodeURIComponent(pair.slice(index + 1))
  })
  return params
}

function isPlainObject (value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}

function looksLikeJson (text) {
  return text.charAt(0) === '{'
}

function hasForbiddenControlChars (value) {
  return /[\u0000-\u001f\u007f]/.test(value)
}

/** 严格 NEW JSON：只接受 version=1 + 白名单 scene + 非空短 token，字段集恰好为三键。 */
function parseNewJson (text) {
  let parsed
  try {
    parsed = JSON.parse(text)
  } catch (_) {
    return null
  }
  if (!isPlainObject(parsed)) return null
  const keys = Object.keys(parsed)
  if (keys.length !== 3 || keys.some(key => key !== 'version' && key !== 'scene' && key !== 'token')) return null
  // 未知/缺失版本 → 拒绝（老后端签发的其他版本不应进入 v2 通道）
  if (parsed.version !== QR_VERSION) return null
  const scene = parsed.scene
  if (typeof scene !== 'string' || CHECKIN_SCENES.indexOf(scene) < 0) return null
  const token = parsed.token
  if (typeof token !== 'string') return null
  const trimmed = token.trim()
  if (!trimmed || trimmed.length > MAX_TOKEN_LENGTH || hasForbiddenControlChars(trimmed)) return null
  return { kind: 'NEW', version: QR_VERSION, scene, token: trimmed }
}

function parseLegacyStation (text) {
  const query = text.slice(text.indexOf('?') + 1)
  const params = parseQueryParams(query)
  const stationId = String(params.stationId || '').trim()
  const checkinToken = String(params.token || '').trim()
  if (!stationId || !checkinToken) return null
  return { kind: 'LEGACY_STATION', stationId, checkinToken }
}

/**
 * 统一解析入口：
 *  NEW JSON → {kind:'NEW',version,scene,token}
 *  老场次码 → {kind:'LEGACY_STATION',stationId,checkinToken}
 *  老通用码 → {kind:'LEGACY_GENERIC',params}
 *  其余（含损坏/篡改/未知版本/未知 scene）→ null（失败关闭）
 */
function parse (raw) {
  if (typeof raw !== 'string') return null
  const text = raw.trim()
  if (!text) return null
  if (looksLikeJson(text)) return parseNewJson(text)
  if (text.startsWith(LEGACY_STATION_PREFIX)) return parseLegacyStation(text)
  if (text.startsWith(LEGACY_GENERIC_PREFIX)) {
    const query = text.slice(text.indexOf('?') + 1)
    return { kind: 'LEGACY_GENERIC', params: parseQueryParams(query) }
  }
  return null
}

module.exports = {
  CHECKIN_SCENES,
  LEGACY_GENERIC_PREFIX,
  LEGACY_STATION_PREFIX,
  MAX_TOKEN_LENGTH,
  QR_VERSION,
  parse
}
