// 蓝牙 MAC 地址解析工具。
//
// 事实（2026-09-17 生产实测，nginx UA 佐证）：
// - Android：wx 的 deviceId 就是系统可见的真实 MAC（如 34:20:00:01:7D:08），显示与绑定都正常。
// - iOS：deviceId 是系统 UUID（13214DCA-…），只能从设备下发的广播/设备帧取 MAC，
//   而固件按小端序（低字节在前）下发，按字节原序拼接得到的是反序值（如 25:30:01:00:20:34）。
//
// 判定规则（IEEE 802 语义，不依赖任何厂商 OUI 白名单）：
// 设备地址必须是单播；厂商设备还应是全球唯一地址，即首字节 bit0=0（非组播）且 bit1=0（非本地管理）。
// 因此对任意来源的 MAC 候选，只有当"反转后"的地址质量更高时才反转，否则保持原样。

function normalizeMac (value) {
  const text = String(value || '').trim().replace(/-/g, ':').toUpperCase()
  return /^([0-9A-F]{2}:){5}[0-9A-F]{2}$/.test(text) ? text : ''
}

function reverseMac (mac) {
  const normalized = normalizeMac(mac)
  if (!normalized) return ''
  return normalized.split(':').reverse().join(':')
}

/**
 * 地址质量：2 = 单播且全球唯一（厂商 MAC，最优）；1 = 单播但本地管理；0 = 组播（不可能是设备地址）。
 */
function macQuality (mac) {
  const normalized = normalizeMac(mac)
  if (!normalized) return -1
  const first = parseInt(normalized.slice(0, 2), 16)
  if (first & 0x01) return 0
  return (first & 0x02) ? 1 : 2
}

/**
 * 对任意来源的 MAC（广播解析、设备帧 readBleAddress、deviceId、本地缓存）做字节序校正：
 * 反转后地址质量更高才采用反转值，避免误伤本来正确的地址。
 */
function correctMacByteOrder (mac) {
  const normalized = normalizeMac(mac)
  if (!normalized) return ''
  const flipped = reverseMac(normalized)
  if (!flipped || flipped === normalized) return normalized
  return macQuality(flipped) > macQuality(normalized) ? flipped : normalized
}

/**
 * 从扫描结果解析真实 MAC。
 * 优先级：Android 的 deviceId（平台权威）> 本次广播解析（校正后）> 本地缓存（校正后）。
 * 注意：缓存可能是修复前写入的反序值，因此不能优先于本次扫描结果，且必须同样校正。
 */
function resolveScanMacAddress ({ deviceId, macAddress, cachedAddress } = {}) {
  const platformMac = normalizeMac(deviceId)
  if (platformMac) return platformMac
  const advertised = correctMacByteOrder(macAddress)
  if (advertised) return advertised
  return correctMacByteOrder(cachedAddress)
}

module.exports = {
  normalizeMac,
  reverseMac,
  macQuality,
  correctMacByteOrder,
  resolveScanMacAddress
}
