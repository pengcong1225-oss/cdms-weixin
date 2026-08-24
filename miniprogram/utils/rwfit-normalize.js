const TYPE_MAP = Object.freeze({
  steps: 'steps',
  sleep: 'sleep',
  heartRate: 'heartRate',
  hr: 'heartRate',
  hrv: 'hrv',
  bloodOxygen: 'bloodOxygen',
  bloodOxy: 'bloodOxygen',
  bloodPressure: 'bloodPressure',
  bloodPress: 'bloodPressure',
  bloodSugar: 'bloodGlucose',
  bloodGlucose: 'bloodGlucose',
  stress: 'stress',
  temperature: 'temperature',
  workout: 'workout'
})

const BLOCKED_TYPES = new Set(['ppg', 'acc', 'muslimCount', 'sensorRaw', 'waveform'])

function mapSdkType (type) {
  const value = String(type || '').trim()
  return TYPE_MAP[value] || value
}

function numericValue (record, type, detail) {
  if (type === 'sleep' && Number.isFinite(Number(detail.totalMinutes))) return Number(detail.totalMinutes)
  if (type === 'bloodPressure' && typeof record.value === 'string') {
    const systolic = Number(record.value.split('/')[0])
    if (Number.isFinite(systolic)) return systolic
  }
  const value = Number(record.value)
  return Number.isFinite(value) ? value : null
}

function normalizeRecord (record) {
  if (!record || !record.id || record.measuredAt == null) return null
  const sourceType = String(record.type || '').trim()
  if (BLOCKED_TYPES.has(sourceType)) return null
  const type = mapSdkType(sourceType)
  if (!type || BLOCKED_TYPES.has(type)) return null
  const detail = record.detail && typeof record.detail === 'object' ? record.detail : {}
  const value = numericValue(record, type, detail)
  if (value == null) return null
  const unit = type === 'sleep' ? 'min' : String(record.unit || '')
  return {
    recordId: String(record.id),
    type,
    value,
    unit,
    measuredAt: Number(record.measuredAt),
    summary: String(record.summary || ''),
    detail
  }
}

function flattenRecords (recordsByType) {
  return Object.values(recordsByType || {})
    .flatMap(records => Array.isArray(records) ? records : [])
    .map(normalizeRecord)
    .filter(Boolean)
}

module.exports = { mapSdkType, normalizeRecord, flattenRecords }
