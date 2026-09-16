// 蓝牙 MAC 地址解析工具。
// 背景：厂商广播里 MAC 以小端序（低字节在前）出现，SDK 的 sd()/sI() 按字节原序拼接，
// 结果是反序 MAC；而 wx 的 deviceId 在 Android 上等于真实 MAC，iOS 上是系统 UUID。
// 展示与绑定都应使用"真实 MAC"，这里统一给出解析规则。

// 生产环境已确认的厂商 OUI（RW 设备真实 MAC 前缀）。
const VENDOR_MAC_OUI_PREFIXES = ['34:20:00']

function normalizeMac (value) {
  const text = String(value || '').trim().replace(/-/g, ':').toUpperCase()
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(text) ? text : ''
}

function reverseMac (mac) {
  const normalized = normalizeMac(mac)
  if (!normalized) return ''
  return normalized.split(':').reverse().join(':')
}

function isVendorOui (mac) {
  const normalized = normalizeMac(mac)
  if (!normalized) return false
  return VENDOR_MAC_OUI_PREFIXES.some(prefix => normalized.startsWith(prefix))
}

/**
 * 从扫描结果解析真实 MAC。
 * @param {object} input
 * @param {string} input.deviceId   wx BLE deviceId（Android=MAC，iOS=UUID）
 * @param {string} input.macAddress SDK 从广播解析出的 MAC（可能为小端反序）
 * @param {string} input.cachedAddress 本机缓存过的设备上报 MAC（来自 readBleAddress）
 * @returns {string} 真实 MAC；无法确定时返回 ''
 */
function resolveScanMacAddress ({ deviceId, macAddress, cachedAddress } = {}) {
  const platformMac = normalizeMac(deviceId)
  // Android：deviceId 就是系统可见的真实 MAC，权威。
  if (platformMac) return platformMac
  const cached = normalizeMac(cachedAddress)
  // iOS：deviceId 是 UUID；之前连过并缓存过设备上报 MAC 时优先使用。
  if (cached) return cached
  const advertised = normalizeMac(macAddress)
  if (!advertised) return ''
  // 首次扫描：广播 MAC 为小端序，反转后命中厂商 OUI 才采用，避免误伤其他设备。
  const flipped = reverseMac(advertised)
  if (isVendorOui(flipped)) return flipped
  return advertised
}

module.exports = {
  VENDOR_MAC_OUI_PREFIXES,
  normalizeMac,
  reverseMac,
  isVendorOui,
  resolveScanMacAddress
}
