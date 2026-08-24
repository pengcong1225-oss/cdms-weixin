const vendor = require('../sdk/rw-ble-sdk.min.js')
const { flattenRecords } = require('./rwfit-normalize')

function sdk () {
  if (!vendor?.RingSdk) throw new Error('RWFit SDK V2 is not installed in cdms-weixin')
  return vendor.RingSdk
}

function scan (onDevices) {
  return sdk().startScan({ onDevices })
}

function connect (deviceId, options) {
  return sdk().connect(deviceId, options)
}

function healthType (type) {
  const key = String(type || 'heartRate')
    .replace('bloodOxygen', 'BLOOD_OXYGEN')
    .replace('heartRate', 'HEART_RATE')
    .replace('bloodPressure', 'BLOOD_PRESSURE')
    .replace('temperature', 'TEMPERATURE')
    .replace('bloodSugar', 'BLOOD_SUGAR')
    .replace('bloodGlucose', 'BLOOD_SUGAR')
    .replace('hrv', 'HRV')
    .replace('stress', 'STRESS')
    .toUpperCase()
  const code = sdk().HealthMeasurementType?.[key]
  if (code == null) throw new Error(`RWFit SDK 不支持实时指标：${type}`)
  return code
}

async function captureRealtime (connectedSdk, type) {
  const code = healthType(type)
  const records = []
  let unsubscribe
  try {
    return await new Promise(async (resolve, reject) => {
      unsubscribe = connectedSdk.onDeviceEvent(event => {
        if (event.type === 'health') records.push(...(event.records || []))
        if (event.type === 'healthStatus' && event.completed) {
          resolve(flattenRecords({ [type]: records }))
        }
      })
      try {
        await connectedSdk.setHealthMeasurement(code, true)
      } catch (error) {
        reject(error)
      }
    })
  } finally {
    try { unsubscribe?.() } catch (_) {}
    try { await connectedSdk.setHealthMeasurement(code, false) } catch (_) {}
  }
}

module.exports = {
  scan,
  connect,
  captureRealtime,
  flattenRecords,
  healthType,
  getSupportMenu: connectedSdk => connectedSdk?.supportMenu || {}
}
