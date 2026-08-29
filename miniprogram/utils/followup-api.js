const api = require('./api')

const MAX_PHOTO_SIZE = 5 * 1024 * 1024
const ALLOWED_PHOTO_EXTENSIONS = new Set(['jpg', 'jpeg', 'png'])

function unwrap (response) {
  if (response && typeof response === 'object' && Object.prototype.hasOwnProperty.call(response, 'data')) {
    return response.data
  }
  return response
}

function isIdKey (key) {
  return key === 'id' || key === 'pId' || /Id$/.test(key) || /Ref$/.test(key)
}

function normalizeIds (value) {
  if (Array.isArray(value)) return value.map(normalizeIds)
  if (!value || typeof value !== 'object') return value
  const normalized = {}
  Object.keys(value).forEach(key => {
    const item = value[key]
    normalized[key] = isIdKey(key) && item !== null && item !== undefined && item !== ''
      ? String(item)
      : normalizeIds(item)
  })
  return normalized
}

function queryString (pairs) {
  const items = pairs
    .filter(([, value]) => value !== undefined && value !== null && String(value).trim() !== '')
    .map(([key, value]) => `${encodeURIComponent(key)}=${encodeURIComponent(String(value))}`)
  return items.length ? `?${items.join('&')}` : ''
}

function currentAccessToken () {
  try {
    return getApp()?.globalData?.accessToken || ''
  } catch (_) {
    return ''
  }
}

function cdmsBaseUrl () {
  try {
    return getApp()?.globalData?.cdmsBaseUrl || ''
  } catch (_) {
    return ''
  }
}

function toNumber (value) {
  if (value === null || value === undefined || value === '') return value
  const numeric = Number(value)
  return Number.isFinite(numeric) ? numeric : value
}

function splitList (value) {
  if (Array.isArray(value)) {
    return value.map(item => String(item).trim()).filter(Boolean)
  }
  return String(value || '')
    .split(/[，,;；\n\r]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function normalizeFollowupQuery (params = {}) {
  return queryString([
    ['page', params.page || 1],
    ['page_size', params.pageSize || params.page_size || 20],
    ['visit_type', params.visitType !== undefined ? params.visitType : params.visit_type],
    ['start_date', params.startDate || params.start_date],
    ['end_date', params.endDate || params.end_date]
  ])
}

function normalizeFollowupResponse (response) {
  return normalizeIds(unwrap(response))
}

async function listMyFollowups (params = {}) {
  return normalizeFollowupResponse(await api.cdmsRequest(`/api/v1/followups/my${normalizeFollowupQuery(params)}`, 'GET', null, currentAccessToken()))
}

async function listPatientFollowups (patientId, params = {}) {
  const id = encodeURIComponent(String(patientId || ''))
  return normalizeFollowupResponse(await api.cdmsRequest(`/api/v1/patients/${id}/followups${normalizeFollowupQuery(params)}`, 'GET', null, currentAccessToken()))
}

async function getFollowup (id) {
  const followupId = encodeURIComponent(String(id || ''))
  return normalizeFollowupResponse(await api.cdmsRequest(`/api/v1/followups/${followupId}`, 'GET', null, currentAccessToken()))
}

async function saveFollowup (payload) {
  return normalizeFollowupResponse(await api.cdmsRequest('/api/v1/followups', 'POST', normalizeIds(payload || {}), currentAccessToken()))
}

async function saveFollowupDraft (payload) {
  return normalizeFollowupResponse(await api.cdmsRequest('/api/v1/followups/draft', 'POST', normalizeIds(payload || {}), currentAccessToken()))
}

async function updateFollowup (id, payload) {
  const followupId = encodeURIComponent(String(id || ''))
  return normalizeFollowupResponse(await api.cdmsRequest(`/api/v1/followups/${followupId}`, 'PUT', normalizeIds(payload || {}), currentAccessToken()))
}

async function deleteFollowup (id) {
  const followupId = encodeURIComponent(String(id || ''))
  await api.cdmsRequest(`/api/v1/followups/${followupId}`, 'DELETE', null, currentAccessToken())
}

function getFileExtension (filePath) {
  const text = String(filePath || '').split('?')[0].split('#')[0]
  const dotIndex = text.lastIndexOf('.')
  return dotIndex >= 0 ? text.slice(dotIndex + 1).toLowerCase() : ''
}

function getFileName (filePath) {
  const text = String(filePath || '').split('?')[0].split('#')[0]
  const parts = text.split(/[\\/]/)
  return parts[parts.length - 1] || ''
}

function readFileInfo (filePath) {
  return new Promise((resolve, reject) => {
    wx.getFileInfo({
      filePath,
      success: resolve,
      fail: reject
    })
  })
}

function uploadFile (options) {
  return new Promise((resolve, reject) => {
    wx.uploadFile(Object.assign({}, options, {
      success: resolve,
      fail: reject
    }))
  })
}

function parseUploadResult (result) {
  const raw = typeof result?.data === 'string'
    ? (() => {
        try {
          return JSON.parse(result.data)
        } catch (_) {
          return result.data
        }
      })()
    : result?.data
  const payload = raw && typeof raw === 'object' && Object.prototype.hasOwnProperty.call(raw, 'data')
    ? raw.data
    : raw
  return normalizeIds(payload)
}

function assertPhotoExtension (filePath) {
  const ext = getFileExtension(filePath)
  if (!ALLOWED_PHOTO_EXTENSIONS.has(ext)) {
    throw new Error('仅支持 jpg/jpeg/png 格式图片')
  }
}

async function uploadPhoto (filePath) {
  const uploadPath = String(filePath || '').trim()
  if (!uploadPath) throw new Error('请选择要上传的图片')
  assertPhotoExtension(uploadPath)
  const info = await readFileInfo(uploadPath)
  const size = Number(info?.size || 0)
  if (size > MAX_PHOTO_SIZE) {
    throw new Error('图片大小不能超过 5 MiB')
  }
  const baseUrl = cdmsBaseUrl()
  if (!baseUrl) throw new Error('未配置 CDMS 服务地址')
  const response = await uploadFile({
    url: `${baseUrl}/api/v1/upload/photo`,
    filePath: uploadPath,
    name: 'file',
    formData: { type: 'followup' },
    header: currentAccessToken() ? { Authorization: `Bearer ${currentAccessToken()}` } : {}
  })
  return parseUploadResult(response)
}

function validateFollowup (payload = {}) {
  const errors = {}
  const visitDate = String(payload.visitDate || '').trim()
  const catAnswers = Array.isArray(payload.catAnswers) ? payload.catAnswers : []
  if (!visitDate) {
    errors.visitDate = '随访日期必填'
  } else if (Number.isNaN(Date.parse(visitDate))) {
    errors.visitDate = '随访日期格式不正确'
  }
  const catValid = catAnswers.length === 8 && catAnswers.every(item => {
    const value = Number(item)
    return Number.isInteger(value) && value >= 0 && value <= 5
  })
  if (!catValid) {
    errors.catAnswers = 'CAT 8 项必须齐全且每项 0-5'
  }
  return {
    ok: Object.keys(errors).length === 0,
    errors
  }
}

function buildPayload (form = {}) {
  const payload = normalizeIds(form || {})
  ;['visitType', 'patientStatus', 'mmrcOption', 'medicationCompliance', 'needAdjustment', 'regularFollowup', 'hasAsthma', 'patientGroup', 'goldGrade', 'height', 'weight', 'smokingDaily', 'exerciseFreq', 'exerciseDuration', 'spo2'].forEach(key => {
    if (payload[key] !== undefined) payload[key] = toNumber(payload[key])
  })
  if (payload.catAnswers) {
    payload.catAnswers = Array.isArray(payload.catAnswers) ? payload.catAnswers.map(toNumber) : []
  }
  if (payload.chiefComplaintsText !== undefined && payload.chiefComplaints === undefined) {
    payload.chiefComplaints = splitList(payload.chiefComplaintsText)
  }
  if (payload.oralDrugsText !== undefined && payload.copdInfoUpdate === undefined) {
    payload.copdInfoUpdate = {
      symptom: payload.symptom || '',
      oralDrugs: splitList(payload.oralDrugsText),
      inhaledDrugs: splitList(payload.inhaledDrugsText),
      comorbidityList: splitList(payload.comorbidityListText),
      regularFollowup: toNumber(payload.regularFollowup),
      hasAsthma: toNumber(payload.hasAsthma),
      patientGroup: toNumber(payload.patientGroup),
      goldGrade: toNumber(payload.goldGrade)
    }
  }
  if (payload.height !== undefined || payload.weight !== undefined || payload.smokingDaily !== undefined || payload.exerciseFreq !== undefined || payload.exerciseDuration !== undefined || payload.psychology !== undefined || payload.compliance !== undefined || payload.vaccinesText !== undefined || payload.spo2 !== undefined) {
    payload.examLifestyleSnapshot = {
      physical: {
        height: toNumber(payload.height),
        weight: toNumber(payload.weight)
      },
      lifestyle: {
        smokingDaily: toNumber(payload.smokingDaily),
        exerciseFreq: toNumber(payload.exerciseFreq),
        exerciseDuration: toNumber(payload.exerciseDuration),
        psychology: payload.psychology || '',
        compliance: payload.compliance || '',
        vaccines: splitList(payload.vaccinesText)
      },
      exam: {
        spo2: toNumber(payload.spo2)
      }
    }
  }
  if (Array.isArray(payload.photos)) {
    payload.photos = payload.photos.map(photo => ({
      fileName: photo.fileName || getFileName(photo.filePath || ''),
      fileUrl: photo.fileUrl || photo.url || '',
      fileBase64: photo.fileBase64 || ''
    }))
  }
  return payload
}

module.exports = {
  buildPayload,
  deleteFollowup,
  getFollowup,
  listMyFollowups,
  listPatientFollowups,
  normalizeIds,
  saveFollowup,
  saveFollowupDraft,
  updateFollowup,
  uploadPhoto,
  validateFollowup
}
