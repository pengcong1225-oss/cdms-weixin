function getSessionStrategy (context = {}) {
  if (context.iotBaseUrl && context.wearableToken && context.wearableSessionId) return 'EXISTING'
  if (context.activeRole === 'PATIENT' && context.cdmsBaseUrl && context.accessToken && context.patientRef) {
    return 'CDMS_PATIENT'
  }
  if (context.managerBaseUrl && context.handoffCode) return 'MANAGER_HANDOFF'
  return 'MISSING'
}

module.exports = { getSessionStrategy }
