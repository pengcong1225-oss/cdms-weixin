const api = require('../../utils/api')
const { ScaleBle } = require('../../services/scale/scaleBle')

const labels = {
  weight: '体重', bodyFat: '体脂率', subcutaneousFat: '皮下脂肪', visceralFat: '内脏脂肪', muscleRate: '肌肉率',
  basalMetabolism: '基础代谢', bodyAge: '身体年龄', boneMass: '骨量', water: '水分', protein: '蛋白质', bmi: 'BMI', heartRate: '心率', obesityLevel: '肥胖等级'
}

Page({
  data: { patients: [], patientNames: [], patientIndex: -1, selectedPatient: null, patientProfile: null, keyword: '', searching: false, patientPage: 1, patientHasMore: true, devices: [], deviceNames: [], deviceIndex: -1, connected: false, scanning: false, connecting: false, measuring: false, metrics: [], gender: '', age: '', height: '', canConfirm: false, statusText: '待设备匹配', errorText: '' },
  onLoad (query) {
    this.initialPatientId = Number(query?.patientId || 0)
    this.scale = new ScaleBle({ onState: state => this.onScaleState(state), onResult: result => this.onScaleResult(result) })
    const app = getApp()
    if (!app.globalData.accessToken || app.globalData.activeRole !== 'DOCTOR') { this.setData({ errorText: '请先使用医生账号登录' }); return }
    this.loadPatients()
  },
  goBack () { wx.navigateBack({ delta: 1 }) },
  onUnload () { if (this.scale) { this.scale.disconnect().catch(() => {}); this.scale.destroy() } },
  async loadPatients (reset = true) {
    if (this.data.searching) return
    const nextPage = reset ? 1 : this.data.patientPage + 1
    this.setData({ searching: true, errorText: '', patientPage: nextPage })
    try {
      const response = await api.listDoctorPatients({ page: nextPage, pageSize: 20, keyword: this.data.keyword })
      const page = response?.data || response || {}
      const incoming = (page.list || []).filter(item => item?.id != null)
      const patients = reset ? incoming : this.data.patients.concat(incoming)
      // 去重（按 id）
      const seen = new Set()
      const deduped = patients.filter(item => { const k = String(item.id); if (seen.has(k)) return false; seen.add(k); return true })
      const hasMore = incoming.length === 20
      let index = deduped.findIndex(item => Number(item.id) === this.initialPatientId)
      if (index < 0 && deduped.length) index = reset ? 0 : -1
      const patch = { patients: deduped, patientNames: deduped.map(item => item.name || `患者${item.id}`), patientHasMore: hasMore }
      if (index >= 0) patch.patientIndex = index
      this.setData(patch, () => {
        if (index >= 0 && reset) this.selectPatient(index)
      })
    } catch (error) { this.setData({ errorText: error.message || '患者列表加载失败' }) } finally { this.setData({ searching: false }) }
  },

  onKeyword (event) { this.setData({ keyword: String(event.detail.value || '') }) },

  searchPatients () {
    this.initialPatientId = 0
    this.setData({ patientHasMore: true })
    this.loadPatients(true)
  },

  loadMorePatients () {
    if (this.data.patientHasMore && !this.data.searching) this.loadPatients(false)
  },
  async selectPatient (event) {
    const index = typeof event === 'number' ? event : Number(event.detail.value)
    const patient = this.data.patients[index]
    if (!patient) return
    this.setData({ patientIndex: index, selectedPatient: patient, patientProfile: null, gender: patient.gender == null ? '' : String(patient.gender), age: patient.age == null ? '' : String(patient.age), height: patient.height == null ? '' : String(patient.height), metrics: [], canConfirm: false })
    try {
      const detailResponse = await api.getDoctorPatient(patient.id)
      const detail = detailResponse?.data || detailResponse
      const basic = detail?.data?.basicInfo || detail?.basicInfo || detail?.data || detail
      if (basic) {
        this.setData({ gender: basic.gender == null ? this.data.gender : String(basic.gender), age: basic.age == null ? this.data.age : String(basic.age), height: basic.height == null ? this.data.height : String(basic.height) })
        // 带出基本档案条（防重名误选）：姓名/性别/年龄/手机号/身份证；已切换患者则丢弃过期响应
        if (basic.name && String(this.data.selectedPatient?.id || '') === String(patient.id)) {
          this.setData({
            patientProfile: {
              name: basic.name || '',
              genderText: basic.genderText || (basic.gender === 1 ? '男' : basic.gender === 0 ? '女' : ''),
              age: basic.age == null ? '' : String(basic.age),
              phone: basic.phone || '',
              idCard: basic.idCard || ''
            }
          })
        }
      }
    } catch (_) { /* 列表数据足够时允许现场继续填写 */ }
  },
  async scan () {
    if (this.data.scanning) return
    this.setData({ scanning: true, statusText: '正在扫描体脂秤…', errorText: '' })
    try { const devices = await this.scale.startScan({ timeoutMs: 8000 }); this.setData({ devices, deviceNames: devices.map(item => item.name || item.localName || item.deviceId), deviceIndex: devices.length ? 0 : -1, statusText: devices.length ? '请选择体脂秤并连接' : '未发现体脂秤' }) } catch (error) { this.setData({ errorText: error.message || '蓝牙扫描失败', statusText: '待设备匹配' }) } finally { this.setData({ scanning: false }) }
  },
  async connect () {
    const device = this.data.devices[this.data.deviceIndex]
    if (!device) { wx.showToast({ title: '请先扫描并选择体脂秤', icon: 'none' }); return }
    this.setData({ connecting: true, errorText: '' })
    try { await this.scale.connect(device); this.setData({ connected: true, statusText: '已连接，选择患者后开始测量' }) } catch (error) { this.setData({ errorText: error.message || '体脂秤连接失败', statusText: '待设备匹配' }) } finally { this.setData({ connecting: false }) }
  },
  onDeviceChange (event) { this.setData({ deviceIndex: Number(event.detail.value) }) },
  onGender (event) { this.onField('gender', event) },
  onAge (event) { this.onField('age', event) },
  onHeight (event) { this.onField('height', event) },
  onField (field, event) { this.setData({ [field]: String(event.detail.value || '').trim() }) },
  async startMeasure () {
    const patient = this.data.selectedPatient
    if (!patient || !this.data.connected) { wx.showToast({ title: '请先选择患者并连接体脂秤', icon: 'none' }); return }
    const age = Number(this.data.age); const height = Number(this.data.height); const gender = Number(this.data.gender)
    if (![0, 1].includes(gender) || !Number.isInteger(age) || age < 0 || !height) { wx.showToast({ title: '请补充有效性别、年龄和身高', icon: 'none' }); return }
    this.setData({ measuring: true, metrics: [], canConfirm: false, statusText: '等待体脂秤测量…' })
    try { await this.scale.configurePatient({ gender, age, height }); wx.showToast({ title: '请站上体脂秤', icon: 'none' }) } catch (error) { this.setData({ errorText: error.message || '参数下发失败', measuring: false }) }
  },
  onScaleState (state) { if (state.state === 'connected') this.setData({ connected: true, statusText: '已连接' }); if (state.state === 'reconnecting') this.setData({ statusText: '体脂秤重连中…' }); if (state.state === 'error') this.setData({ connected: false, errorText: state.detail || '体脂秤连接失败' }) },
  onScaleResult (result) {
    const values = {}; (this.data.metrics || []).forEach(item => { values[item.name] = item })
    ;(result.metrics || []).forEach(item => { values[item.name] = item })
    const metrics = Object.keys(values).map(name => ({ ...values[name], label: labels[name] || name }))
    this.setData({ metrics, canConfirm: metrics.length > 0, measuring: !result.complete, statusText: result.complete ? '测量完成，请确认后绑定' : '已收到测量数据' })
  },
  confirmSave () {
    if (!this.data.canConfirm || !this.data.selectedPatient) return
    wx.showModal({ title: '确认绑定测量结果', content: '确认后将写入该患者档案和设备测量记录。', confirmColor: '#0c9b6c', success: result => { if (result.confirm) this.saveMeasurement() } })
  },
  async saveMeasurement () {
    try {
      await api.submitScaleMeasurement({ patientId: this.data.selectedPatient.id, deviceId: this.scale.deviceId, confirmed: true, gender: Number(this.data.gender), age: Number(this.data.age), height: Number(this.data.height), measuredAt: new Date().toISOString().slice(0, 19), metrics: this.data.metrics.map(item => ({ type: item.name, value: item.value, unit: item.unit })) })
      wx.showToast({ title: '已绑定，可继续下一位', icon: 'success' }); this.setData({ metrics: [], canConfirm: false, measuring: false, statusText: '已保存，连接保持中' })
    } catch (error) { wx.showToast({ title: error.message || '绑定失败', icon: 'none' }) }
  }
})