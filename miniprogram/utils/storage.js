const BOUND_DEVICE_KEY = "rwsdk.boundDevice.v1";
const BOUND_DEVICES_KEY = "rwsdk.boundDevice.v2";
const HEALTH_RECORDS_KEY = "rwsdk.healthRecords.v1";
const DEVICE_ADDRESS_MAP_KEY = "rwsdk.deviceAddressMap.v1";

function readStorage(key, fallback) {
  try {
    if (typeof wx !== "undefined" && typeof wx.getStorageSync === "function") {
      const value = wx.getStorageSync(key);
      return value == null ? fallback : value;
    }
  } catch (_) {
    // Storage may be unavailable in tests or a restricted mini-program context.
  }
  return fallback;
}

function writeStorage(key, value) {
  try {
    if (typeof wx !== "undefined" && typeof wx.setStorageSync === "function") {
      wx.setStorageSync(key, value);
    }
  } catch (_) {
    // Keep the in-memory caller state usable when persistence is unavailable.
  }
}

function removeStorage(key) {
  try {
    if (typeof wx !== "undefined" && typeof wx.removeStorageSync === "function") {
      wx.removeStorageSync(key);
    }
  } catch (_) {
    // Best effort only.
  }
}

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

function getBoundDevice(deviceRef, patientRef) {
  if (deviceRef != null || patientRef != null) {
    const direct = getScopedBoundDevice(deviceRef, patientRef);
    // Accept both (deviceRef, patientRef) and (patientRef, deviceRef) for
    // callers migrating from the old single-device helper.
    return direct || getScopedBoundDevice(patientRef, deviceRef);
  }
  const records = readBoundDeviceRecords();
  if (!records.length) return null;
  return toDevice(records[records.length - 1]);
}

// 绑定归属隔离（Task A）：绑定记录上标注归属患者 patientRef。
// 有当前患者上下文时自动补上 ownerPatientRef；无归属记录（旧数据）或非患者上下文则不动。
function attachOwnerPatientRef(device) {
  if (!device || typeof device !== "object") return device;
  const patientRef = getCurrentPatientRef();
  if (patientRef && !String(device.ownerPatientRef || "").trim()) {
    device.ownerPatientRef = patientRef;
  }
  return device;
}

function deviceScope(patientRef) {
  return String(patientRef == null ? "" : patientRef).trim();
}

function deviceRefOf(device) {
  return String(device && (device.deviceRef || device.deviceId) || "").trim();
}

function recordKey(record) {
  return `${deviceScope(record && record.patientRef)}\u0000${deviceRefOf(record)}`;
}

function normalizeBoundRecord(value) {
  if (!value || typeof value !== "object") return null;
  const device = value.device && typeof value.device === "object"
    ? Object.assign({}, value.device)
    : Object.assign({}, value);
  const deviceRef = deviceRefOf(device) || String(value.deviceRef || "").trim();
  if (!deviceRef) return null;
  const patientRef = deviceScope(
    value.patientRef != null
      ? value.patientRef
      : device.ownerPatientRef
  );
  if (patientRef && !String(device.ownerPatientRef || "").trim()) {
    device.ownerPatientRef = patientRef;
  }
  device.deviceId = String(device.deviceId || deviceRef);
  return { patientRef, deviceRef, device };
}

function readBoundDeviceRecords() {
  const raw = readStorage(BOUND_DEVICES_KEY, null);
  const records = [];
  const seen = new Map();
  const add = (value, replace = true) => {
    const record = normalizeBoundRecord(value);
    if (!record) return;
    const index = seen.get(recordKey(record));
    if (index == null) {
      seen.set(recordKey(record), records.length);
      records.push(record);
    } else if (replace) {
      records[index] = record;
    }
  };

  if (Array.isArray(raw)) {
    raw.forEach(add);
  } else if (raw && typeof raw === "object") {
    if (Array.isArray(raw.devices)) raw.devices.forEach(add);
    else if (raw.deviceId || raw.deviceRef) add(raw);
    else Object.keys(raw).forEach(key => {
      const value = raw[key];
      if (value && typeof value === "object") {
        add(Object.assign({ patientRef: key }, value));
      }
    });
  }

  const legacy = readStorage(BOUND_DEVICE_KEY, null);
  if (legacy && typeof legacy === "object") {
    add(Object.assign({}, legacy, {
      patientRef: legacy.patientRef || legacy.ownerPatientRef || getCurrentPatientRef()
    }), false);
    // The V1 key is only a migration source. Once observed, never let it
    // overwrite a newer V2 device collection on a later launch.
    removeStorage(BOUND_DEVICE_KEY);
    writeBoundDeviceRecords(records);
  }
  return records;
}

function writeBoundDeviceRecords(records) {
  writeStorage(BOUND_DEVICES_KEY, records.map(record => Object.assign({}, record.device, {
    patientRef: record.patientRef,
    deviceRef: record.deviceRef
  })));
}

function toDevice(record) {
  if (!record) return null;
  const device = Object.assign({}, record.device, {
    deviceId: record.device.deviceId || record.deviceRef
  });
  if (!String(device.ownerPatientRef || "").trim() && record.patientRef) {
    device.ownerPatientRef = record.patientRef;
  }
  // patientRef/deviceRef are collection metadata, not part of the legacy
  // bound-device shape returned to existing page consumers.
  delete device.patientRef;
  delete device.deviceRef;
  return device;
}

function listBoundDevices(patientRef) {
  if (patientRef && typeof patientRef === "object") patientRef = patientRef.patientRef;
  const scope = deviceScope(patientRef == null ? getCurrentPatientRef() : patientRef);
  return readBoundDeviceRecords()
    .filter(record => !scope || !record.patientRef || record.patientRef === scope)
    .map(toDevice);
}

function getScopedBoundDevice(deviceRef, patientRef) {
  const records = readBoundDeviceRecords();
  const find = (refValue, scopeValue) => {
    const scope = deviceScope(scopeValue == null ? getCurrentPatientRef() : scopeValue);
    const ref = deviceRefOf({ deviceRef: refValue });
    return records.find(item => item.deviceRef === ref &&
      (!scope || !item.patientRef || item.patientRef === scope));
  };
  // Accept both (deviceRef, patientRef) and (patientRef, deviceRef). The
  // latter is convenient for callers that model the storage key order.
  return toDevice(find(deviceRef, patientRef) || find(patientRef, deviceRef));
}

function saveBoundDevice(device, patientRef) {
  // Preserve the historical helper contract: saving a device in a patient
  // context annotates the caller's object with ownerPatientRef as well.
  const candidate = attachOwnerPatientRef(device && typeof device === "object" ? device : {});
  const explicitPatient = patientRef != null ? patientRef : candidate.ownerPatientRef;
  const scope = deviceScope(explicitPatient || getCurrentPatientRef());
  const deviceRef = deviceRefOf(candidate);
  if (!deviceRef) return null;
  candidate.deviceId = String(candidate.deviceId || deviceRef);
  if (scope && !String(candidate.ownerPatientRef || "").trim()) candidate.ownerPatientRef = scope;
  const records = readBoundDeviceRecords();
  const next = { patientRef: scope, deviceRef, device: candidate };
  const index = records.findIndex(record => recordKey(record) === recordKey(next));
  if (index < 0) records.push(next);
  else records[index] = next;
  writeBoundDeviceRecords(records);
  return toDevice(next);
}

function clearBoundDevice(deviceRef, patientRef) {
  let ref = deviceRefOf({ deviceRef });
  let scope = deviceScope(patientRef == null ? getCurrentPatientRef() : patientRef);
  const records = readBoundDeviceRecords();
  if (ref && patientRef != null) {
    const direct = records.some(record => record.deviceRef === ref &&
      (!scope || !record.patientRef || record.patientRef === scope));
    const reverseRef = deviceScope(patientRef);
    const reverseScope = deviceScope(deviceRef);
    const reverse = records.some(record => record.deviceRef === reverseRef &&
      (!reverseScope || !record.patientRef || record.patientRef === reverseScope));
    if (!direct && reverse) {
      ref = reverseRef;
      scope = reverseScope;
    }
  }
  let next;
  if (ref) {
    next = records.filter(record => !(record.deviceRef === ref &&
      (!scope || !record.patientRef || record.patientRef === scope)));
  } else {
    // Legacy callers had no device argument. Restrict the compatibility
    // clear to the most recently saved record in the current scope instead of
    // deleting every long-term binding for that patient.
    const candidateIndex = records.reduce((found, record, index) => {
      const matchesScope = scope
        ? (!record.patientRef || record.patientRef === scope)
        : !record.patientRef;
      return matchesScope ? index : found;
    }, -1);
    next = candidateIndex < 0
      ? records
      : records.filter((_, index) => index !== candidateIndex);
  }
  writeBoundDeviceRecords(next);
  if (!ref) removeStorage(BOUND_DEVICE_KEY);
}

function removeBoundDevice(deviceRef, patientRef) {
  return clearBoundDevice(deviceRef, patientRef);
}

// 纯判定：该绑定是否属于指定患者。
// 无归属记录（旧数据）一律视为本人设备（保持现状）；有归属记录则严格比对。
function isBoundDeviceOwnedByPatient(boundDevice, patientRef) {
  if (!boundDevice) return true;
  const owner = String(boundDevice.ownerPatientRef || "").trim();
  if (!owner) return true;
  return owner === String(patientRef || "").trim();
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
  boundDeviceStorageKey: BOUND_DEVICES_KEY,
  getBoundDevice,
  getScopedBoundDevice,
  listBoundDevices,
  saveBoundDevice,
  clearBoundDevice,
  removeBoundDevice,
  isBoundDeviceOwnedByPatient,
  getDeviceAddress,
  saveDeviceAddress,
  getHealthRecords,
  getLastHealthRecord,
  saveHealthRecord,
  saveHealthRecords,
  clearDeviceHealthRecords,
};
