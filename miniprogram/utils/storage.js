const BOUND_DEVICE_KEY = "rwsdk.boundDevice.v1";
const HEALTH_RECORDS_KEY = "rwsdk.healthRecords.v1";
const DEVICE_ADDRESS_MAP_KEY = "rwsdk.deviceAddressMap.v1";

function getCurrentPatientRef() {
  try {
    const app = typeof getApp === "function" ? getApp() : null;
    return String(app && app.globalData && app.globalData.patientRef || "").trim();
  } catch (_) {
    return "";
  }
}

function getHealthScopeKey(deviceId) {
  const patientRef = getCurrentPatientRef();
  return patientRef ? `${patientRef}::${deviceId}` : deviceId;
}

function getDeviceHealthRecords(all, deviceId) {
  const scopeKey = getHealthScopeKey(deviceId);
  if (scopeKey !== deviceId && !all[scopeKey] && all[deviceId]) {
    all[scopeKey] = all[deviceId];
    delete all[deviceId];
    wx.setStorageSync(HEALTH_RECORDS_KEY, all);
  }
  return { scopeKey, records: all[scopeKey] || {} };
}

function getBoundDevice() {
  return wx.getStorageSync(BOUND_DEVICE_KEY) || null;
}

function saveBoundDevice(device) {
  wx.setStorageSync(BOUND_DEVICE_KEY, device);
}

function clearBoundDevice() {
  wx.removeStorageSync(BOUND_DEVICE_KEY);
}

function getDeviceAddress(deviceId) {
  if (!deviceId) return "";
  const addressMap = wx.getStorageSync(DEVICE_ADDRESS_MAP_KEY) || {};
  return addressMap[deviceId] || "";
}

function saveDeviceAddress(deviceId, macAddress) {
  if (!deviceId || !macAddress) return;
  const addressMap = wx.getStorageSync(DEVICE_ADDRESS_MAP_KEY) || {};
  if (addressMap[deviceId] === macAddress) return;
  addressMap[deviceId] = macAddress;
  wx.setStorageSync(DEVICE_ADDRESS_MAP_KEY, addressMap);
}

function getHealthRecords(deviceId, type) {
  const all = wx.getStorageSync(HEALTH_RECORDS_KEY) || {};
  const deviceRecords = getDeviceHealthRecords(all, deviceId).records;
  return (deviceRecords[type] || []).slice();
}

function getLastHealthRecord(deviceId, type) {
  const records = getHealthRecords(deviceId, type);
  return records.length ? records[0] : null;
}

function saveHealthRecord(deviceId, type, record) {
  const all = wx.getStorageSync(HEALTH_RECORDS_KEY) || {};
  const scoped = getDeviceHealthRecords(all, deviceId);
  const deviceRecords = scoped.records;
  const records = deviceRecords[type] || [];
  const normalized = Object.assign(
    {
      id: `${type}-${Date.now()}`,
      measuredAt: Date.now(),
      value: "--",
      unit: "",
    },
    record,
  );
  deviceRecords[type] = [normalized, ...records].slice(0, 500);
  all[scoped.scopeKey] = deviceRecords;
  wx.setStorageSync(HEALTH_RECORDS_KEY, all);
  return normalized;
}

function saveHealthRecords(deviceId, type, incomingRecords) {
  const all = wx.getStorageSync(HEALTH_RECORDS_KEY) || {};
  const scoped = getDeviceHealthRecords(all, deviceId);
  const deviceRecords = scoped.records;
  const recordsById = new Map();
  (deviceRecords[type] || []).forEach((record) => {
    recordsById.set(record.id || `${type}-${record.measuredAt}`, record);
  });
  (incomingRecords || []).forEach((record) => {
    const normalized = Object.assign(
      {
        id: `${type}-${record.measuredAt || Date.now()}`,
        measuredAt: Date.now(),
        value: "--",
        unit: "",
      },
      record,
    );
    recordsById.set(normalized.id, normalized);
  });
  const merged = Array.from(recordsById.values())
    .sort((first, second) => second.measuredAt - first.measuredAt)
    .slice(0, 1000);
  deviceRecords[type] = merged;
  all[scoped.scopeKey] = deviceRecords;
  wx.setStorageSync(HEALTH_RECORDS_KEY, all);
  return merged;
}

function clearDeviceHealthRecords(deviceId) {
  const all = wx.getStorageSync(HEALTH_RECORDS_KEY) || {};
  delete all[getHealthScopeKey(deviceId)];
  wx.setStorageSync(HEALTH_RECORDS_KEY, all);
}

module.exports = {
  getBoundDevice,
  saveBoundDevice,
  clearBoundDevice,
  getDeviceAddress,
  saveDeviceAddress,
  getHealthRecords,
  getLastHealthRecord,
  saveHealthRecord,
  saveHealthRecords,
  clearDeviceHealthRecords,
};
