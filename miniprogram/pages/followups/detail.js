const followupApi = require('../../utils/followup-api')
const { ensureSession } = require('../../utils/auth-guard')

const CAT_QUESTIONS = [
  '咳嗽',
  '咳痰',
  '胸闷',
  '上楼梯气短',
  '居家活动受限',
  '离家外出信心',
  '睡眠影响',
  '精力下降'
]

const CAT_OPTIONS = [
  { label: '0', value: 0 },
  { label: '1', value: 1 },
  { label: '2', value: 2 },
  { label: '3', value: 3 },
  { label: '4', value: 4 },
  { label: '5', value: 5 }
]

const MMRC_OPTIONS = [
  { label: '1', value: 1, caption: '仅剧烈运动时气短' },
  { label: '2', value: 2, caption: '平地快走或爬坡时气短' },
  { label: '3', value: 3, caption: '平地慢走时需停下喘气' },
  { label: '4', value: 4, caption: '步行约 100 米即气短' },
  { label: '5', value: 5, caption: '穿衣、说话、离床即气短' }
]

const VISIT_TYPE_OPTIONS = [
  { label: '门诊', value: 0 },
  { label: '电话', value: 1 },
  { label: '上门', value: 2 }
]

const PATIENT_STATUS_OPTIONS = [
  { label: '稳定', value: 0 },
  { label: '改善', value: 1 },
  { label: '加重', value: 2 }
]

function nowInputValue () {
  const now = new Date()
  const pad = value => String(value).padStart(2, '0')
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}T${pad(now.getHours())}:${pad(now.getMinutes())}`
}

function valueText (value, fallback = '') {
  return value === null || value === undefined ? fallback : String(value)
}

function splitText (value) {
  return String(value || '')
    .split(/[，,;；\n\r]+/)
    .map(item => item.trim())
    .filter(Boolean)
}

function joinText (value) {
  return Array.isArray(value) ? value.filter(Boolean).join('，') : valueText(value)
}

function normalizePhoto (photo) {
  if (!photo || typeof photo !== 'object') return null
  const fileUrl = photo.fileUrl || photo.url || ''
  return {
    fileName: photo.fileName || photo.name || '随访照片',
    fileUrl,
    url: fileUrl,
    fileBase64: photo.fileBase64 || ''
  }
}

function buildFormFromDetail (detail, patientId) {
  const catAnswers = Array.isArray(detail?.catAnswers) && detail.catAnswers.length
    ? detail.catAnswers.slice(0, 8)
    : Array(8).fill('')
  while (catAnswers.length < 8) catAnswers.push('')
  return {
    patientId: String(detail?.patientId || patientId || ''),
    visitDate: valueText(detail?.visitDate, nowInputValue()).replace(' ', 'T').slice(0, 16),
    visitType: detail?.visitType === null || detail?.visitType === undefined ? 0 : Number(detail.visitType),
    patientStatus: detail?.patientStatus === null || detail?.patientStatus === undefined ? 0 : Number(detail.patientStatus),
    chiefComplaintsText: joinText(detail?.chiefComplaints || []),
    chiefComplaintsOther: valueText(detail?.chiefComplaintsOther),
    catAnswers,
    mmrcOption: detail?.mmrcOption === null || detail?.mmrcOption === undefined ? '' : Number(detail.mmrcOption),
    medicationCompliance: detail?.medicationCompliance === null || detail?.medicationCompliance === undefined ? '' : Number(detail.medicationCompliance),
    adverseReaction: valueText(detail?.adverseReaction),
    needAdjustment: detail?.needAdjustment === null || detail?.needAdjustment === undefined ? '' : Number(detail.needAdjustment),
    adjustmentSuggestion: valueText(detail?.adjustmentSuggestion),
    nextVisitDate: valueText(detail?.nextVisitDate).replace(' ', 'T').slice(0, 10),
    remark: valueText(detail?.remark),
    symptom: valueText(detail?.copdInfoSnapshot?.symptom || detail?.symptom),
    oralDrugsText: joinText(detail?.copdInfoSnapshot?.oralDrugs || detail?.oralDrugs || []),
    inhaledDrugsText: joinText(detail?.copdInfoSnapshot?.inhaledDrugs || detail?.inhaledDrugs || []),
    comorbidityListText: joinText(detail?.copdInfoSnapshot?.comorbidityList || detail?.comorbidityList || []),
    regularFollowup: detail?.copdInfoSnapshot?.regularFollowup === null || detail?.copdInfoSnapshot?.regularFollowup === undefined ? '' : Number(detail.copdInfoSnapshot.regularFollowup),
    hasAsthma: detail?.copdInfoSnapshot?.hasAsthma === null || detail?.copdInfoSnapshot?.hasAsthma === undefined ? '' : Number(detail.copdInfoSnapshot.hasAsthma),
    patientGroup: detail?.copdInfoSnapshot?.patientGroup === null || detail?.copdInfoSnapshot?.patientGroup === undefined ? '' : Number(detail.copdInfoSnapshot.patientGroup),
    goldGrade: detail?.copdInfoSnapshot?.goldGrade === null || detail?.copdInfoSnapshot?.goldGrade === undefined ? '' : Number(detail.copdInfoSnapshot.goldGrade),
    otherRemark: valueText(detail?.otherRemark || detail?.copdInfoSnapshot?.otherRemark),
    height: detail?.examLifestyleSnapshot?.physical?.height === null || detail?.examLifestyleSnapshot?.physical?.height === undefined ? '' : Number(detail.examLifestyleSnapshot.physical.height),
    weight: detail?.examLifestyleSnapshot?.physical?.weight === null || detail?.examLifestyleSnapshot?.physical?.weight === undefined ? '' : Number(detail.examLifestyleSnapshot.physical.weight),
    smokingDaily: detail?.examLifestyleSnapshot?.lifestyle?.smokingDaily === null || detail?.examLifestyleSnapshot?.lifestyle?.smokingDaily === undefined ? '' : Number(detail.examLifestyleSnapshot.lifestyle.smokingDaily),
    exerciseFreq: detail?.examLifestyleSnapshot?.lifestyle?.exerciseFreq === null || detail?.examLifestyleSnapshot?.lifestyle?.exerciseFreq === undefined ? '' : Number(detail.examLifestyleSnapshot.lifestyle.exerciseFreq),
    exerciseDuration: detail?.examLifestyleSnapshot?.lifestyle?.exerciseDuration === null || detail?.examLifestyleSnapshot?.lifestyle?.exerciseDuration === undefined ? '' : Number(detail.examLifestyleSnapshot.lifestyle.exerciseDuration),
    psychology: valueText(detail?.examLifestyleSnapshot?.lifestyle?.psychology),
    compliance: valueText(detail?.examLifestyleSnapshot?.lifestyle?.compliance),
    vaccinesText: joinText(detail?.examLifestyleSnapshot?.lifestyle?.vaccines || []),
    spo2: detail?.examLifestyleSnapshot?.exam?.spo2 === null || detail?.examLifestyleSnapshot?.exam?.spo2 === undefined ? '' : Number(detail.examLifestyleSnapshot.exam.spo2),
    photos: Array.isArray(detail?.photos) ? detail.photos.map(normalizePhoto).filter(Boolean) : []
  }
}

function buildEmptyForm (patientId) {
  return buildFormFromDetail({ patientId, visitDate: nowInputValue(), catAnswers: Array(8).fill(''), photos: [] }, patientId)
}

function friendlyError (error) {
  if (error?.statusCode === 403) return '无权操作随访'
  if (error?.statusCode === 404) return '随访记录不存在'
  return '随访保存失败，请稍后重试'
}

function consumePatientId (query = {}, session = {}) {
  const app = typeof getApp === 'function' ? getApp() : null
  const transientPatientId = String(app?.globalData?.currentPatientId || '').trim()
  if (app?.globalData) {
    delete app.globalData.currentPatientId
  }
  if (session.activeRole === 'DOCTOR') return transientPatientId
  return String(session.patientId || session.patientRef || '').trim()
}

function asTimeText (value) {
  const text = String(value || '').trim()
  if (!text) return '-'
  return text.replace('T', ' ').slice(0, 16)
}

Page({
  data: {
    canEdit: false,
    loading: false,
    saving: false,
    draftSaving: false,
    error: '',
    patientId: '',
    followupId: '',
    detail: null,
    form: buildEmptyForm(''),
    catQuestions: CAT_QUESTIONS,
    catOptions: CAT_OPTIONS,
    mmrcOptions: MMRC_OPTIONS,
    visitTypeOptions: VISIT_TYPE_OPTIONS,
    patientStatusOptions: PATIENT_STATUS_OPTIONS
  },

  async onLoad (query = {}) {
    const session = await ensureSession({ role: getApp()?.globalData?.activeRole || 'PATIENT' })
    const canEdit = session.activeRole === 'DOCTOR'
    const patientId = consumePatientId(query, session)
    this.setData({
      canEdit,
      patientId,
      followupId: String(query.id || ''),
      form: patientId ? buildEmptyForm(patientId) : buildEmptyForm('')
    })
    if (query.id) {
      await this.loadFollowup(query.id)
      return
    }
    if (!patientId) {
      this.setData({ error: '缺少患者 ID' })
      return
    }
    this.setData({ loading: false, error: '' })
  },

  async loadFollowup (id) {
    this.setData({ loading: true, error: '' })
    try {
      const detail = await followupApi.getFollowup(id)
      this.setData({
        detail,
        followupId: String(detail?.id || id || ''),
        patientId: String(detail?.patientId || this.data.patientId || ''),
        form: buildFormFromDetail(detail, this.data.patientId || detail?.patientId || ''),
        loading: false
      })
    } catch (error) {
      this.setData({ loading: false, error: friendlyError(error) })
    }
  },

  updateField (event) {
    const field = event.currentTarget.dataset.field
    const form = JSON.parse(JSON.stringify(this.data.form))
    form[field] = event.detail.value
    this.setData({ form })
  },

  onChoiceChange (event) {
    const field = event.currentTarget.dataset.field
    const form = JSON.parse(JSON.stringify(this.data.form))
    form[field] = Number(event.detail.value)
    this.setData({ form })
  },

  onCatChange (event) {
    const index = Number(event.currentTarget.dataset.index)
    const form = JSON.parse(JSON.stringify(this.data.form))
    form.catAnswers[index] = Number(event.detail.value)
    this.setData({ form })
  },

  async addPhoto () {
    if (!this.data.canEdit) return
    const chooseResult = await new Promise((resolve, reject) => {
      wx.chooseMedia({
        count: 3,
        mediaType: ['image'],
        sourceType: ['album', 'camera'],
        success: resolve,
        fail: reject
      })
    })
    const tempFiles = Array.isArray(chooseResult?.tempFiles) ? chooseResult.tempFiles : []
    if (!tempFiles.length) return
    const nextPhotos = this.data.form.photos.slice()
    for (const file of tempFiles) {
      const uploaded = await followupApi.uploadPhoto(file.tempFilePath)
      nextPhotos.push({
        fileName: uploaded.fileName || file.fileName || '随访照片',
        fileUrl: uploaded.url || uploaded.fileUrl || '',
        url: uploaded.url || uploaded.fileUrl || '',
        fileSize: uploaded.fileSize || file.size || 0
      })
    }
    const form = JSON.parse(JSON.stringify(this.data.form))
    form.photos = nextPhotos
    this.setData({ form })
    wx.showToast({ title: '照片已添加', icon: 'success' })
  },

  removePhoto (event) {
    const index = Number(event.currentTarget.dataset.index)
    const form = JSON.parse(JSON.stringify(this.data.form))
    form.photos.splice(index, 1)
    this.setData({ form })
  },

  buildPayload () {
    const payload = followupApi.buildPayload(this.data.form)
    payload.patientId = payload.patientId || this.data.patientId
    payload.visitDate = payload.visitDate || this.data.form.visitDate
    payload.visitType = payload.visitType === undefined ? this.data.form.visitType : payload.visitType
    payload.patientStatus = payload.patientStatus === undefined ? this.data.form.patientStatus : payload.patientStatus
    return payload
  },

  async saveDraft () {
    if (!this.data.canEdit) return
    const payload = this.buildPayload()
    this.setData({ draftSaving: true, error: '' })
    try {
      const result = await followupApi.saveFollowupDraft(payload)
      this.setData({
        draftSaving: false,
        followupId: String(result?.id || this.data.followupId || ''),
        detail: result || this.data.detail
      })
      wx.showToast({ title: '草稿已保存', icon: 'success' })
    } catch (error) {
      this.setData({ draftSaving: false, error: friendlyError(error) })
    }
  },

  async submit () {
    if (!this.data.canEdit) return
    const payload = this.buildPayload()
    const validation = followupApi.validateFollowup(payload)
    if (!validation.ok) {
      const firstError = Object.values(validation.errors)[0] || '随访信息不完整'
      this.setData({ error: firstError })
      return
    }
    this.setData({ saving: true, error: '' })
    try {
      const result = this.data.followupId
        ? await followupApi.updateFollowup(this.data.followupId, payload)
        : await followupApi.saveFollowup(payload)
      this.setData({
        saving: false,
        followupId: String(result?.id || this.data.followupId || ''),
        detail: result || this.data.detail
      })
      wx.showToast({ title: '随访已提交', icon: 'success' })
      if (wx.navigateBack) wx.navigateBack({ delta: 1 })
    } catch (error) {
      this.setData({ saving: false, error: friendlyError(error) })
    }
  },

  backList () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.navigateTo({ url: '/pages/followups/index' })
  }
})

module.exports = { buildEmptyForm, buildFormFromDetail, CAT_QUESTIONS, CAT_OPTIONS, MMRC_OPTIONS, VISIT_TYPE_OPTIONS, PATIENT_STATUS_OPTIONS }
