// 蓝牙 MAC 地址解析工具。
//
// 事实（2026-09-17/18 生产实测，nginx UA + 绑定表佐证）：
// - Android：wx 的 deviceId 就是系统可见的真实 MAC（如 34:20:00:01:7D:08），可直接作为设备标识；
// - iOS：deviceId 是系统 UUID（13214DCA-…），只能从设备下发的广播/设备帧取 MAC；
//   而 RW 固件按**小端序**（低字节在前）下发 6 字节，按字节原序拼接得到的是反序值。
//
// 判定规则（协议层面，单一规则，不依赖厂商 OUI 白名单）：
// 凡是"来自设备下发字节"的 MAC（广播解析、readBleAddress 设备帧、以及据此写入的本地缓存），
// 一律反转一次得到真实 MAC。平台自带的 deviceId（Android）是操作系统给出的真实 MAC，原样使用。
//
// 反例教训：曾用"IEEE 单播/全球唯一质量比较，哪种顺序更像设备地址就用哪种"，
// 但小端值的首字节是真实 MAC 的末字节，经常同样是"单播+全球唯一"（如 60:A6:…、98:3D:…），
// 两个方向打平 → 不反转 → 修复失效。故改为按协议无条件反转。

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
 * 设备下发的字节序是小端序：统一反转成真实 MAC。
 * 空值/非 MAC 返回 ''。
 */
function payloadMac (mac) {
  return reverseMac(mac)
}

/**
 * 从扫描结果解析真实 MAC。
 * 优先级：Android 的 deviceId（平台权威，原样）> 本次广播解析（反转）> 本地缓存（反转）。
 * 缓存可能是修复前写入的反序值，因此不能优先于本次扫描结果，且同样需要反转。
 */
function resolveScanMacAddress ({ deviceId, macAddress, cachedAddress } = {}) {
  const platformMac = normalizeMac(deviceId)
  if (platformMac) return platformMac
  const advertised = payloadMac(macAddress)
  if (advertised) return advertised
  return payloadMac(cachedAddress)
}

module.exports = {
  normalizeMac,
  reverseMac,
  payloadMac,
  resolveScanMacAddress
}
