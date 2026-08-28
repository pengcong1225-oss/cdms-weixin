const patientApi = require('../../utils/patient-api')
const { ensureSession } = require('../../utils/auth-guard')

function emptyForm () {
  return {
    basicInfo: {
      name: '',
      gender: '',
      age: '',
      birthday: '',
      height: '',
      weight: '',
      phone: '',
      phoneDuplicateReason: '',
      contactName: '',
      workUnit: '',
      idCardType: '',
      idCard: '',
      education: '',
      isMobile: '',
      contactRelation: '',
      contactPhone: '',
      residenceType: '',
      address: '',
      bloodType: '',
      occupation: '',
      maritalStatus: '',
      medicalPayment: '',
      orgId: '',
      serveOrgId: '',
      createOrgId: '',
      buildDate: '',
      doctorName: ''
    },
    smokeInfo: { smokeStatus: '', smokeDetail: '' },
    lungFunction: {
      lungFunctionChecked: '',
      copdConfirmed: '',
      goldGrade: '',
      catScore: '',
      mmrcGrade: '',
      fev1Percent: ''
    },
    copdInfo: {
      hasComorbidity: '',
      oxygenTherapy: '',
      ventilator: '',
      oralDrugs: [],
      oralDrugsOther: '',
      inhaledDrugs: [],
      inhaledDrugsOther: '',
      hasAcuteExacerbation: '',
      comorbidityList: [],
      regularFollowup: '',
      hasAsthma: '',
      symptom: '',
      otherRemark: '',
      patientGroup: '',
      goldGrade: ''
    },
    allergies: [],
    dustExposures: []
  }
}

function maskPhone (value) {
  const text = String(value || '')
  return /^1\d{10}$/.test(text) ? `${text.slice(0, 3)}****${text.slice(7)}` : (text ? '手机号已脱敏' : '-')
}

function maskIdCard (value) {
  const text = String(value || '')
  return text.length >= 8 ? `${text.slice(0, 6)}********${text.slice(-4)}` : (text ? '证件号已脱敏' : '-')
}

function maskOrgName (value) {
  const text = String(value || '')
  if (!text) return '-'
  return text.length <= 4 ? `${text.slice(0, 1)}***` : `${text.slice(0, 4)}***`
}

function statusLabel () {
  return '状态已脱敏'
}

function buildSummary (detail) {
  const basic = detail?.basicInfo || {}
  const org = detail?.orgInfo || {}
  return {
    name: basic.name || '未命名患者',
    genderAge: `${basic.genderText || '性别未填'} · ${basic.age || '--'}岁`,
    phoneMasked: maskPhone(basic.phone),
    idCardMasked: maskIdCard(basic.idCard),
    orgMasked: maskOrgName(org.serveOrgName || org.orgName || org.createOrgName),
    statusMasked: statusLabel(detail),
    gold: detail?.lungFunction?.goldGradeText || '-',
    cat: detail?.lungFunction?.catScore == null ? '-' : String(detail.lungFunction.catScore),
    lastVisitDate: detail?.followupSummary?.lastVisitDate || '-',
    nextVisitDate: detail?.followupSummary?.nextVisitDate || '-'
  }
}

function mergeForm (detail) {
  const form = emptyForm()
  const basic = detail?.basicInfo || {}
  const org = detail?.orgInfo || {}
  Object.assign(form.basicInfo, basic, {
    orgId: org.orgId || basic.orgId || '',
    serveOrgId: org.serveOrgId || basic.serveOrgId || '',
    createOrgId: org.createOrgId || basic.createOrgId || '',
    buildDate: org.buildDate || basic.buildDate || '',
    doctorName: org.doctorName || basic.doctorName || ''
  })
  Object.assign(form.smokeInfo, detail?.smokeInfo || {})
  Object.assign(form.lungFunction, detail?.lungFunction || {})
  Object.assign(form.copdInfo, detail?.copdInfo || {})
  form.allergies = (detail?.allergies || []).map(item => typeof item === 'string' ? { allergyName: item, remark: '' } : item)
  form.dustExposures = detail?.dustExposures || []
  return form
}

function clone (value) {
  return JSON.parse(JSON.stringify(value))
}

function normalizeIdFields (value) {
  if (Array.isArray(value)) return value.map(normalizeIdFields)
  if (!value || typeof value !== 'object') return value
  const next = {}
  Object.keys(value).forEach(key => {
    const item = value[key]
    next[key] = (key === 'id' || /Id$/.test(key)) && item !== null && item !== undefined && item !== ''
      ? String(item)
      : normalizeIdFields(item)
  })
  return next
}

function buildPatientSavePayload (form) {
  const payload = clone(form || emptyForm())
  return normalizeIdFields(payload)
}

function friendlyError (error) {
  if (error?.statusCode === 403) return '无权保存患者档案'
  if (error?.statusCode === 401) return '登录状态已失效，请重新登录'
  return '患者档案保存失败，请稍后重试'
}

Page({
  data: {
    patientId: '',
    loading: false,
    saving: false,
    editMode: true,
    detail: null,
    summary: buildSummary(null),
    form: emptyForm(),
    error: '',
    duplicate: null,
    actions: [
      { key: 'edit', text: '档案编辑', enabled: true },
      { key: 'followups', text: '随访', enabled: false },
      { key: 'monitoring', text: '监测', enabled: false },
      { key: 'reports', text: '报告', enabled: false },
      { key: 'patient360', text: '患者360', enabled: true }
    ]
  },

  async onLoad (query = {}) {
    await ensureSession({ role: 'DOCTOR' })
    const patientId = String(query.id || query.patientId || '')
    this.setData({ patientId, editMode: !patientId })
    if (patientId) await this.loadPatient(patientId)
  },

  async loadPatient (patientId) {
    this.setData({ loading: true, error: '' })
    try {
      const detail = await patientApi.getPatient(patientId)
      this.setData({
        detail,
        summary: buildSummary(detail),
        form: mergeForm(detail),
        loading: false
      })
    } catch (error) {
      this.setData({ loading: false, error: error?.statusCode === 403 ? '无权查看患者档案' : '患者档案加载失败' })
    }
  },

  edit () {
    this.setData({ editMode: true })
  },

  updateBasicField (event) {
    const field = event.currentTarget.dataset.field
    const form = clone(this.data.form)
    form.basicInfo[field] = event.detail.value
    this.setData({ form })
  },

  updateSmokeField (event) {
    const field = event.currentTarget.dataset.field
    const form = clone(this.data.form)
    form.smokeInfo[field] = event.detail.value
    this.setData({ form })
  },

  updateLungField (event) {
    const field = event.currentTarget.dataset.field
    const form = clone(this.data.form)
    form.lungFunction[field] = event.detail.value
    this.setData({ form })
  },

  updateCopdField (event) {
    const field = event.currentTarget.dataset.field
    const form = clone(this.data.form)
    form.copdInfo[field] = event.detail.value
    this.setData({ form })
  },

  async save () {
    const payload = buildPatientSavePayload(this.data.form)
    this.setData({ saving: true, error: '', duplicate: null })
    try {
      const duplicate = await patientApi.checkDuplicate(payload.basicInfo, this.data.patientId || undefined)
      if (duplicate?.idCardConflict || duplicate?.phoneConflict) {
        this.setData({ saving: false, duplicate, error: '发现重复档案，请核对后再保存' })
        return
      }
      const detail = this.data.patientId
        ? await patientApi.updatePatient(this.data.patientId, payload)
        : await patientApi.createPatient(payload)
      const nextId = String(detail?.id || this.data.patientId || '')
      this.setData({
        patientId: nextId,
        detail: detail || this.data.detail,
        summary: buildSummary(detail || this.data.detail),
        form: mergeForm(detail || payload),
        editMode: false,
        saving: false
      })
      wx.showToast({ title: '档案已保存', icon: 'success' })
    } catch (error) {
      this.setData({ saving: false, error: friendlyError(error) })
    }
  },

  onAction (event) {
    const key = event.currentTarget.dataset.key
    if (key === 'edit') {
      this.edit()
      return
    }
    if (key === 'patient360' && this.data.patientId) {
      wx.navigateTo({ url: `/pages/patient-360/index?patientId=${encodeURIComponent(this.data.patientId)}` })
      return
    }
    wx.showToast({ title: '后续任务接入', icon: 'none' })
  },

  backList () {
    wx.navigateBack ? wx.navigateBack() : wx.navigateTo({ url: '/pages/patient-list/index' })
  }
})

module.exports = { emptyForm, buildPatientSavePayload, maskPhone, maskIdCard, buildSummary }
