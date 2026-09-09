// 健康档案：本人档案信息（患者 360）+ 随访记录列表/详情（原生页面，不走 handoff/web-view）
const healthRecordApi = require('../../utils/health-record-api')

const PAGE_SIZE = 10

// gender：0 未知 1 男 2 女；visitType：1 门诊 2 电话 3 上门 4 视频
const GENDER_TEXT = { 0: '未知', 1: '男', 2: '女' }
const VISIT_TYPE_TEXT = { 1: '门诊', 2: '电话', 3: '上门', 4: '视频' }
const NEED_ADJUST_TEXT = { 0: '不需要', 1: '需要' }
// 标准 CAT 八问维度顺序（与 utils/assess-rules.js 题目顺序一致）
const CAT_DIMENSIONS = ['咳嗽', '咳痰', '胸闷', '气促', '活动受限', '外出信心', '睡眠', '精力']

function display (value) {
  if (value === null || value === undefined || value === '') return '-'
  return String(value)
}

function pad (value) { return String(value).padStart(2, '0') }

// 后端 LocalDate/LocalDateTime 均为 ISO 字符串：2026-01-02 / 2026-01-02T10:30:00
function formatDate (value) {
  if (!value) return '-'
  const match = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})/)
  return match ? match[1] + '-' + pad(match[2]) + '-' + pad(match[3]) : String(value)
}

function formatDateTime (value) {
  if (!value) return '-'
  const match = String(value).match(/^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2}))?/)
  if (!match) return String(value)
  const date = match[1] + '-' + pad(match[2]) + '-' + pad(match[3])
  return match[4] ? date + ' ' + pad(match[4]) + ':' + pad(match[5]) : date
}

function genderTextOf (basicInfo) {
  if (!basicInfo) return '-'
  if (basicInfo.genderText) return String(basicInfo.genderText)
  return GENDER_TEXT[basicInfo.gender] || '-'
}

function countText (value, unit) {
  if (value === null || value === undefined || value === '') return '-'
  return String(value) + unit
}

function percentText (value) {
  if (value === null || value === undefined || value === '') return '-'
  return String(value) + '%'
}

// patientId 优先取页面参数（首页健康档案入口通过 url 传入），兜底读取页面栈里缓存的 _healthRecordPatientId
function resolvePatientId (options) {
  const fromQuery = options && options.patientId ? String(options.patientId) : ''
  if (fromQuery) return fromQuery
  try {
    const pages = typeof getCurrentPages === 'function' ? getCurrentPages() : []
    for (let i = pages.length - 1; i >= 0; i -= 1) {
      const cached = pages[i] && pages[i]._healthRecordPatientId
      if (cached) return String(cached)
    }
  } catch (_) { /* 页面栈不可用时忽略 */ }
  return ''
}

function hasMoreOf (loadedCount, total, lastPageCount) {
  const totalNum = Number(total) || 0
  return totalNum > 0 ? loadedCount < totalNum : lastPageCount >= PAGE_SIZE
}

// 360 detail -> 基本档案各分区；lungFunction/copdInfo/orgInfo 等可能为 null，逐项容错
function buildProfile (payload) {
  const detail = (payload && payload.detail) || {}
  const basicInfo = detail.basicInfo || {}
  const lungFunction = detail.lungFunction || {}
  const copdInfo = detail.copdInfo || {}
  const orgInfo = detail.orgInfo || {}
  const riskInfo = detail.riskInfo || {}
  const followupSummary = detail.followupSummary || {}

  const inhaled = Array.isArray(copdInfo.inhaledDrugs) ? copdInfo.inhaledDrugs.filter(Boolean) : []
  const oral = Array.isArray(copdInfo.oralDrugs) ? copdInfo.oralDrugs.filter(Boolean) : []
  if (copdInfo.inhaledDrugsOther) inhaled.push('其他：' + copdInfo.inhaledDrugsOther)
  if (copdInfo.oralDrugsOther) oral.push('其他：' + copdInfo.oralDrugsOther)
  const drugGroups = []
  if (inhaled.length) drugGroups.push({ label: '吸入药物', tags: inhaled })
  if (oral.length) drugGroups.push({ label: '口服药物', tags: oral })

  return {
    basicRows: [
      { label: '姓名', value: display(basicInfo.name) },
      { label: '性别', value: genderTextOf(basicInfo) },
      { label: '年龄', value: countText(basicInfo.age, '岁') },
      { label: '手机号', value: display(basicInfo.phone) },
      { label: '建档机构', value: display(orgInfo.orgName) },
      { label: '建档医生', value: display(orgInfo.doctorName) },
      { label: '建档日期', value: formatDate(orgInfo.buildDate) }
    ],
    lungRows: [
      { label: 'GOLD 分级', value: display(lungFunction.goldGradeText) },
      { label: 'FEV1', value: percentText(lungFunction.fev1Percent) },
      { label: 'CAT 评分', value: display(lungFunction.catScore) },
      { label: 'mMRC 分级', value: display(lungFunction.mmrcGradeText) }
    ],
    drugGroups,
    hasDrugs: drugGroups.length > 0,
    summaryRows: [
      { label: '随访次数', value: countText(followupSummary.visitCount, '次') },
      { label: '上次随访', value: formatDate(followupSummary.lastVisitDate) },
      { label: '下次随访', value: formatDate(followupSummary.nextVisitDate) }
    ],
    riskRows: [
      { label: '风险等级', value: display(riskInfo.riskLevelText) },
      { label: '患者分组', value: display(riskInfo.patientGroupText) },
      { label: '病情状态', value: display(riskInfo.diseaseStatusText) }
    ]
  }
}

// FollowUpListVO -> 列表行（diseaseStatusText 缺失时回落 patientStatusText，后端两者同源 DISEASE_STATUS 枚举）
function mapFollowUpRow (item) {
  return {
    id: item.id,
    visitDateText: formatDateTime(item.visitDate),
    visitTypeText: item.visitTypeText || VISIT_TYPE_TEXT[item.visitType] || '-',
    catScoreText: display(item.catScore),
    diseaseStatusText: item.diseaseStatusText || item.patientStatusText || '-',
    nextVisitDateText: formatDate(item.nextVisitDate)
  }
}

// FollowUpDetailVO -> 弹层分区；空值统一显示 -
function buildDetailSections (detail) {
  const vo = detail || {}
  const answers = Array.isArray(vo.catAnswers) ? vo.catAnswers : []
  const answerRows = answers.map((value, index) => ({
    label: CAT_DIMENSIONS[index] || ('维度' + (index + 1)),
    value: value === null || value === undefined || value === '' ? '-' : value + ' 分'
  }))
  const complaints = Array.isArray(vo.chiefComplaints)
    ? vo.chiefComplaints.filter(Boolean).join('、')
    : (vo.chiefComplaints || '')
  const complaintText = [complaints, vo.chiefComplaintsOther].filter(Boolean).join('；')
  return [
    {
      title: '随访信息',
      rows: [
        { label: '随访日期', value: formatDateTime(vo.visitDate) },
        { label: '随访方式', value: display(vo.visitTypeText || VISIT_TYPE_TEXT[vo.visitType]) },
        { label: '随访医生', value: display(vo.operator) },
        { label: '病情状态', value: display(vo.patientStatusText) }
      ]
    },
    {
      title: '症状与 CAT 评估',
      rows: [
        { label: '主要症状', value: complaintText || '-' },
        { label: 'CAT 总分', value: vo.catScore === null || vo.catScore === undefined || vo.catScore === '' ? '-' : vo.catScore + ' 分' }
      ].concat(answerRows)
    },
    {
      title: '呼吸评估与用药',
      rows: [
        { label: 'mMRC 分级', value: display(vo.mmrcGradeText) },
        { label: '用药依从性', value: display(vo.medicationComplianceText) },
        { label: '不良反应', value: display(vo.adverseReaction) }
      ]
    },
    {
      title: '结论与建议',
      rows: [
        { label: '是否需要调整用药', value: vo.needAdjustment === null || vo.needAdjustment === undefined || vo.needAdjustment === '' ? '-' : (NEED_ADJUST_TEXT[vo.needAdjustment] || String(vo.needAdjustment)) },
        { label: '调整建议', value: display(vo.adjustmentSuggestion) },
        { label: '下次随访日期', value: formatDate(vo.nextVisitDate) },
        { label: '备注', value: display(vo.remark) }
      ]
    }
  ]
}

Page({
  data: {
    loading: true,
    patientId: '',
    profileReady: false,
    profileError: '',
    basicRows: [],
    lungRows: [],
    drugGroups: [],
    hasDrugs: false,
    summaryRows: [],
    riskRows: [],
    followups: [],
    listTotal: 0,
    page: 0,
    hasMore: false,
    listLoading: false,
    listLoadingMore: false,
    listError: '',
    detailShow: false,
    detailLoading: false,
    detailError: '',
    detailSections: []
  },

  onLoad (options) {
    this.patientId = resolvePatientId(options)
    this.setData({ patientId: this.patientId })
  },

  // 首次进入并行加载：患者 360 档案 + 随访记录第 1 页
  onShow () {
    if (this._loadedOnce) return
    this._loadedOnce = true
    this.initialLoad()
  },

  async initialLoad () {
    if (!this.patientId) {
      const message = '缺少患者档案标识，请从首页「健康档案」重新进入'
      this.setData({ loading: false, profileReady: false, profileError: message, listError: message })
      return
    }
    this.setData({ loading: true, profileError: '', listError: '' })
    await Promise.all([this.reloadProfile(), this.reloadFollowUps()])
    this.setData({ loading: false })
  },

  async reloadProfile () {
    if (!this.patientId) return
    try {
      const payload = await healthRecordApi.getPatient360(this.patientId)
      this.setData(Object.assign({ profileReady: true, profileError: '' }, buildProfile(payload)))
    } catch (error) {
      this.setData({ profileReady: false, profileError: (error && error.message) || '档案加载失败' })
    }
  },

  async reloadFollowUps () {
    if (!this.patientId) return
    this.setData({ listLoading: true, listError: '' })
    try {
      const data = await healthRecordApi.getMyFollowUps(1, PAGE_SIZE)
      this.setFollowUpPage(data, true)
    } catch (error) {
      this.setData({ listError: (error && error.message) || '随访记录加载失败', hasMore: false })
    } finally {
      this.setData({ listLoading: false })
    }
  },

  setFollowUpPage (data, reset) {
    const rows = ((data && data.list) || []).map(mapFollowUpRow)
    const nextList = reset ? rows : this.data.followups.concat(rows)
    this.setData({
      followups: nextList,
      listTotal: Number(data && data.total) || 0,
      page: reset ? 1 : this.data.page + 1,
      hasMore: hasMoreOf(nextList.length, data && data.total, rows.length)
    })
  },

  // 底部"加载更多"：page+1 追加；失败时保留已加载内容并提示重试
  async loadMoreFollowUps () {
    if (!this.data.hasMore || this.data.listLoadingMore || !this.patientId) return
    this.setData({ listLoadingMore: true, listError: '' })
    try {
      const data = await healthRecordApi.getMyFollowUps(this.data.page + 1, PAGE_SIZE)
      this.setFollowUpPage(data, false)
    } catch (error) {
      this.setData({ listError: (error && error.message) || '随访记录加载失败' })
    } finally {
      this.setData({ listLoadingMore: false })
    }
  },

  retryProfile () {
    this.reloadProfile()
  },

  retryList () {
    this.reloadFollowUps()
  },

  // 下拉刷新：档案 + 随访记录第 1 页
  async onPullDownRefresh () {
    try {
      if (this.patientId) {
        await Promise.all([this.reloadProfile(), this.reloadFollowUps()])
      }
    } finally {
      wx.stopPullDownRefresh()
    }
  },

  // 点击随访行：页内弹层展示详情
  openFollowUpDetail (event) {
    const id = event.currentTarget.dataset.id
    if (id === null || id === undefined || id === '') return
    this._detailId = id
    this.setData({ detailShow: true })
    this.loadFollowUpDetail(id)
  },

  async loadFollowUpDetail (id) {
    this.setData({ detailLoading: true, detailError: '' })
    try {
      const detail = await healthRecordApi.getFollowUpDetail(id)
      this.setData({ detailLoading: false, detailSections: buildDetailSections(detail) })
    } catch (error) {
      this.setData({ detailLoading: false, detailError: (error && error.message) || '随访详情加载失败' })
    }
  },

  retryDetail () {
    if (this._detailId === undefined || this._detailId === null) return
    this.loadFollowUpDetail(this._detailId)
  },

  closeFollowUpDetail () {
    this.setData({ detailShow: false, detailLoading: false, detailError: '' })
    this._detailId = null
  },

  // 阻止弹层内容点击冒泡到遮罩
  noop () {}
})
