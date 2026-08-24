const api = require('./api')
const { flattenRecords } = require('./rwfit-normalize')
const { getSessionStrategy } = require('./session-strategy')

function appContext () {
  const app = typeof getApp === 'function' ? getApp() : null
  return app?.globalData || {}
}

function createUploadBatch ({ batchId, sessionId, patientRef, deviceRef, recordsByType, records, sdkVersion = 'RW_SDK_V2.0.0_20260807' }) {
  const normalized = records || flattenRecords(recordsByType)
  return {
    batchId: String(batchId || `wx-${Date.now()}`),
    sessionId: String(sessionId || ''),
    patientRef: String(patientRef || ''),
    deviceRef: String(deviceRef || ''),
    sdkVersion,
    records: normalized
  }
}

function updateContext (values) {
  const context = appContext()
  Object.assign(context, values)
  if (context.wearableToken && context.wearableSessionId) {
    try {
      wx.setStorageSync('cdms.miniapp.wearable', {
        iotBaseUrl: context.iotBaseUrl || '',
        wearableToken: context.wearableToken,
        wearableSessionId: context.wearableSessionId,
        wearableDeviceRef: context.wearableDeviceRef || context.deviceRef || '',
        patientRef: context.patientRef || ''
      })
    } catch (_) {
      // Storage may be unavailable in unit tests; the in-memory context remains valid.
    }
  }
  return context
}

async function ensureIoTSession (deviceRef) {
  const context = appContext()
  const strategy = getSessionStrategy(context)
  if (strategy === 'EXISTING') {
    return updateContext({ deviceRef, wearableDeviceRef: deviceRef })
  }
  let session
  if (strategy === 'CDMS_PATIENT') {
    const response = await api.createPatientWearableSession(deviceRef)
    session = response?.data || response
  } else {
    if (strategy !== 'MANAGER_HANDOFF') throw new Error('缺少小程序安全启动上下文')
    session = await api.exchangeHandoff({
      managerBaseUrl: context.managerBaseUrl,
      handoffCode: context.handoffCode,
      deviceRef
    })
  }
  return updateContext({
    iotBaseUrl: session.iotBaseUrl || context.iotBaseUrl,
    wearableToken: session.uploadToken || session.token,
    wearableSessionId: session.sessionId || context.wearableSessionId,
    patientRef: session.patientRef || context.patientRef,
    deviceRef,
    wearableDeviceRef: deviceRef
  })
}

async function enqueueAndFlush ({ deviceRef, recordsByType, records }) {
  const context = await ensureIoTSession(deviceRef)
  if (!context.iotBaseUrl || !context.wearableToken || !context.wearableSessionId || !context.patientRef) {
    throw new Error('IoT 会话范围不完整，无法上传健康数据')
  }
  const batch = createUploadBatch({
    sessionId: context.wearableSessionId,
    patientRef: context.patientRef,
    deviceRef,
    recordsByType,
    records
  })
  api.enqueue(batch)
  return api.flushQueue({ baseUrl: context.iotBaseUrl, token: context.wearableToken, scope: context.patientRef })
}

module.exports = { createUploadBatch, ensureIoTSession, enqueueAndFlush, updateContext }
