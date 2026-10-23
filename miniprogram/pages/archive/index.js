const screeningApi = require('../../utils/screening-api')
const { parseIdentityCard, normalizeIdCard } = require('../../utils/identity')

// 建档问卷（原生实现，不再用 web-view）：复用 cdmsManager 既有 COPD-SQ 7 题筛查问卷契约，
// 提交走 /screening/h5/submit —— 服务端 matchOrCreate 患者档案，提交即建档。
const PHONE_RE = /^1[3-9]\d{9}$/

function text (value) {
  return String(value == null ? '' : value).trim()
}

function numberOrNull (value) {
  const raw = text(value)
  if (!raw) return null
  const num = Number(raw)
  return Number.isFinite(num) ? num : null
}

function todayText () {
  const now = new Date()
  const pad = n => String(n).padStart(2, '0')
  return now.getFullYear() + '-' + pad(now.getMonth() + 1) + '-' + pad(now.getDate())
}

Page({
  data: {
    loading: true,
    loadError: '',
    submitting: false,
    organizations: [],
    organizationIndex: 0,
    organizationName: '',
    questions: [],
    answers: {},
    form: {
      name: '',
      gender: 0,
      birthday: '',
      heightCm: '',
      weightKg: '',
      idCard: '',
      phone: '',
      address: ''
    },
    errors: {},
    errorSummary: '',
    today: todayText(),
    result: null
  },

  onLoad () {
    this.screeningToken = ''
    this.loadBootstrap()
  },

  async loadBootstrap () {
    this.setData({ loading: true, loadError: '' })
    try {
      const [orgResponse, questionResponse] = await Promise.all([
        screeningApi.listOrganizations(),
        screeningApi.listQuestions()
      ])
      const organizations = (orgResponse && orgResponse.data) || []
      const questions = (questionResponse && questionResponse.data) || []
      if (!organizations.length) throw new Error('暂无可用机构，请联系管理员')
      this.setData({ organizations, questions, loading: false })
      // 只有一个机构时直接选中，省一次操作。
      if (organizations.length === 1) await this.selectOrganization(0)
    } catch (error) {
      this.setData({ loading: false, loadError: (error && error.message) || '建档问卷加载失败，请稍后重试' })
    }
  },

  retryLoad () {
    this.loadBootstrap()
  },

  onOrganizationChange (event) {
    const index = Number(event.detail.value)
    if (!Number.isInteger(index) || index < 0) return
    this.selectOrganization(index)
  },

  // 选定机构后立刻签发一次性 token：提交时服务端据此派生机构，缺 token 直接拦在本地。
  async selectOrganization (index) {
    const org = this.data.organizations[index]
    if (!org) return
    this.setData({ organizationIndex: index, organizationName: org.name })
    try {
      const response = await screeningApi.issueToken(org.id)
      const context = (response && response.data) || {}
      this.screeningToken = text(context.token)
      if (!this.screeningToken) throw new Error('机构信息无效，请重新选择')
      this.setFieldError('organization', '')
    } catch (error) {
      this.screeningToken = ''
      this.setFieldError('organization', (error && error.message) || '机构加载失败，请重新选择')
    }
  },

  onNameInput (event) {
    this.setData({ 'form.name': event.detail.value })
    this.setFieldError('name', '')
  },

  onPhoneInput (event) {
    this.setData({ 'form.phone': event.detail.value })
    this.setFieldError('phone', '')
  },

  onAddressInput (event) {
    this.setData({ 'form.address': event.detail.value })
  },

  onHeightInput (event) {
    this.setData({ 'form.heightCm': event.detail.value })
    this.setFieldError('heightCm', '')
  },

  onWeightInput (event) {
    this.setData({ 'form.weightKg': event.detail.value })
    this.setFieldError('weightKg', '')
  },

  // 身份证输入即解析：能解析成功就回填性别与生日（与 H5 同口径，避免两处填错）。
  onIdCardInput (event) {
    const idCard = normalizeIdCard(event.detail.value)
    const patch = { 'form.idCard': idCard }
    const identity = parseIdentityCard(idCard)
    if (identity) {
      patch['form.gender'] = identity.gender
      patch['form.birthday'] = identity.birthday
    }
    this.setData(patch)
    this.setFieldError('idCard', '')
  },

  onBlurIdCard () {
    if (!text(this.data.form.idCard)) return
    if (!parseIdentityCard(this.data.form.idCard)) {
      this.setFieldError('idCard', '身份证号格式不正确')
    }
  },

  onGenderChange (event) {
    this.setData({ 'form.gender': Number(event.detail.value) })
    this.setFieldError('gender', '')
  },

  onBirthdayChange (event) {
    this.setData({ 'form.birthday': event.detail.value })
    this.setFieldError('birthday', '')
  },

  // 题目只有带选项的才选（q_bmi 由身高体重服务端计算）。
  selectAnswer (event) {
    const { code, option } = event.currentTarget.dataset
    if (!code || !option) return
    const answers = Object.assign({}, this.data.answers)
    answers[code] = option
    this.setData({ answers })
    this.setFieldError('question:' + code, '')
  },

  setFieldError (field, message) {
    const next = Object.assign({}, this.data.errors)
    if (message) next[field] = message
    else delete next[field]
    this.setData({ errors: next })
  },

  // 与 cdmsManager H5 的 validateScreening 同口径：必填、格式、性别/生日需与身份证一致、每题必答。
  validate () {
    const form = this.data.form
    const errors = {}
    if (!this.screeningToken) errors.organization = '请选择所属机构'
    if (!text(form.name)) errors.name = '请填写姓名'
    if (!form.gender) errors.gender = '请选择性别'
    if (!text(form.birthday)) errors.birthday = '请选择出生日期'
    const height = numberOrNull(form.heightCm)
    if (height == null || height < 60 || height > 250) errors.heightCm = '请填写正确身高（60-250cm）'
    const weight = numberOrNull(form.weightKg)
    if (weight == null || weight <= 0 || weight > 250) errors.weightKg = '请填写正确体重'
    const identity = parseIdentityCard(form.idCard)
    if (!identity) {
      errors.idCard = '身份证号格式不正确'
    } else {
      if (form.gender && form.gender !== identity.gender) errors.gender = '性别需与身份证一致'
      if (text(form.birthday) && text(form.birthday) !== identity.birthday) errors.birthday = '出生日期需与身份证一致'
    }
    if (!PHONE_RE.test(text(form.phone))) errors.phone = '手机号格式不正确'
    ;(this.data.questions || []).forEach(question => {
      const hasOptions = question.options && question.options.length
      if (hasOptions && !this.data.answers[question.code]) {
        errors['question:' + question.code] = '请完成「' + question.title + '」'
      }
    })
    this.setData({ errors, errorSummary: Object.keys(errors).length ? '请检查标红的必填项' : '' })
    return Object.keys(errors)
  },

  async submit () {
    if (this.data.submitting || this.data.result) return
    if (this.validate().length) return
    const form = this.data.form
    this.setData({ submitting: true, errorSummary: '' })
    try {
      const response = await screeningApi.submit({
        screeningToken: this.screeningToken,
        name: text(form.name),
        gender: Number(form.gender),
        birthday: text(form.birthday) || null,
        idCard: normalizeIdCard(form.idCard),
        phone: text(form.phone),
        address: text(form.address) || null,
        heightCm: numberOrNull(form.heightCm),
        weightKg: numberOrNull(form.weightKg),
        answers: Object.assign({}, this.data.answers)
      })
      const result = (response && response.data) || {}
      this.setData({ submitting: false, result })
    } catch (error) {
      // 一次性 token 用后即失效：失败后重新签发，避免用户重试时撞「token 已使用」。
      this.setData({ submitting: false, errorSummary: (error && error.message) || '提交失败，请稍后重试' })
      this.refreshTokenAfterFailure()
    }
  },

  async refreshTokenAfterFailure () {
    const org = this.data.organizations[this.data.organizationIndex]
    if (!org) return
    try {
      const response = await screeningApi.issueToken(org.id)
      const context = (response && response.data) || {}
      this.screeningToken = text(context.token)
    } catch (_) {
      this.screeningToken = ''
    }
  },

  backToLogin () {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    if (pages.length > 1) wx.navigateBack({ delta: 1 })
    else wx.reLaunch({ url: '/pages/auth/login' })
  }
})
