// 指环设备设置持久化：全部 key 与 device.js 的 monitoringTypes/告警分支保持一致。
// settings 形如：
// {
//   heartRateMonitoring: { enabled, startHour, startMinute, endHour, endMinute, intervalMinutes },
//   heartRateAlert: { enabled, high, low },
//   bloodOxygenAlert: { enabled, low }
// }
const STORAGE_PREFIX = 'rw.device.settings.'

// 数据自动同步间隔默认值（分钟）：患者端本地个性化，与后端/IoT 无关
const DEFAULT_SYNC_INTERVAL_MINUTES = 15

// device.js monitoringTypes 的 id → SDK 监测类型（用于持久化与重放/回读）
const MONITORING_TYPE_MAP = {
  heartRateMonitoring: 'heartRate',
  bloodOxygenMonitoring: 'bloodOxygen',
  hrvMonitoring: 'hrv',
  stressMonitoring: 'stress',
  bloodPressureMonitoring: 'bloodPressure',
  bloodSugarMonitoring: 'bloodSugar',
  temperatureMonitoring: 'temperature',
  ppgMonitoring: 'ppg'
}

function storageKey (deviceId) {
  return STORAGE_PREFIX + String(deviceId || '')
}

function load (deviceId) {
  if (!deviceId) return {}
  try {
    const value = wx.getStorageSync(storageKey(deviceId))
    return value && typeof value === 'object' ? value : {}
  } catch (_) {
    return {}
  }
}

function save (deviceId, settings) {
  if (!deviceId) return {}
  const next = Object.assign({}, load(deviceId), settings || {})
  try {
    wx.setStorageSync(storageKey(deviceId), next)
  } catch (_) {
    // 存储不可用时静默失败，不影响设备功能
  }
  return next
}

function clear (deviceId) {
  if (!deviceId) return
  try {
    wx.removeStorageSync(storageKey(deviceId))
  } catch (_) {
    // 静默失败
  }
}

// 读取数据自动同步间隔（分钟）：取不到或非法时回落到默认 15
function getSyncIntervalMinutes (deviceId) {
  const saved = deviceId ? load(deviceId) : {};
  const value = Number(saved && saved.syncIntervalMinutes);
  if (Number.isFinite(value) && value > 0) return value;
  return DEFAULT_SYNC_INTERVAL_MINUTES;
}

module.exports = {
  MONITORING_TYPE_MAP,
  STORAGE_PREFIX,
  DEFAULT_SYNC_INTERVAL_MINUTES,
  load,
  save,
  clear,
  getSyncIntervalMinutes
}
