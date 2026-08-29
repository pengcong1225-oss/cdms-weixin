const stationApi = require('../../../utils/station-api')
const { ensureSession } = require('../../../utils/auth-guard')
const { ScaleBle } = require('../../../services/scaleBle')

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function metricLabel (name) {
  const labels = {
    weight: '体重',
    bodyFat: '体脂率',
    bmi: 'BMI',
    heartRate: '心率'
  }
  return labels[name] || name
}

function metricText (metric) {
  return {
    name: valueText(metric?.name || metric?.type),
    value: metric?.value,
    unit: valueText(metric?.unit),
    label: metricLabel(metric?.name || metric?.type)
  }
}

function currentTimestamp () {
  return new Date().toISOString().slice(0, 19)
}

function patientProfile (item) {
  const summary = item?.patientSummary || {}
  return {
    maskedName: valueText(summary.maskedName, '待叫号患者'),
    gender: summary.gender === null || summary.gender === undefined || summary.gender === '' ? '' : Number(summary.gender),
    age: summary.age === null || summary.age === undefined || summary.age === '' ? '' : Number(summary.age),
    height: summary.height === null || summary.height === undefined || summary.height === '' ? '' : Number(summary.height),
    genderText: valueText(summary.genderText),
    heightText: valueText(summary.heightText)
  }
}

function createActionKey (prefix) {
  return stationApi.createIdempotencyKey(prefix)
}

function currentDraftFromQueueItem (item) {
  if (!item) return null
  if (!item.draftId) return null
  return {
    id: valueText(item.draftId),
    status: valueText(item.draftStatus, 'RESULT_PENDING')
  }
}

Page({
  data: {
    loading: false,
    creating: false,
    scanning: false,
    connecting: false,
    measuring: false,
    saving: false,
    canConfirm: false,
    errorText: '',
    statusText: '待创建场次',
    stationId: '',
    stationStatus: 'OPEN',
    checkinToken: '',
    tokenExpiresAt: '',
    queue: [],
    currentQueueItem: null,
    currentDraft: null,
    metrics: [],
    devices: [],
    deviceNames: [],
    deviceIndex: -1,
    connected: false
  },

  async onLoad (query = {}) {
    const session = await ensureSession({ role: 'DOCTOR' })
    if (session.activeRole !== 'DOCTOR') {
      this.setData({ errorText: '请先使用医生账号登录' })
      return
    }
    this.scale = new ScaleBle({
      onState: state => this.onScaleState(state),
      onResult: result => this.onScaleResult(result)
    })
    const stationId = valueText(query.stationId, '')
    this.setData({ errorText: '', stationId })
    if (stationId) {
      await this.loadStation(stationId)
      return
    }
    await this.createStation()
  },

  onUnload () {
    if (this.scale) {
      this.scale.disconnect().catch(() => {})
      this.scale.destroy()
    }
  },

  async createStation () {
    this.setData({ creating: true, loading: true, errorText: '' })
    try {
      const station = await stationApi.createStation({
        stationName: '体脂秤轮测场次',
        idempotencyKey: createActionKey('station-create')
      })
      const stationId = valueText(station.id || station.stationId, '')
      if (stationId) {
        this.setData({ stationId })
      }
      this.applyStation(station)
      await this.refreshStation(stationId || station.id || station.stationId)
    } catch (error) {
      this.setData({ errorText: error.message || '场次创建失败' })
    } finally {
      this.setData({ creating: false, loading: false })
    }
  },

  async loadStation (stationId) {
    this.setData({ loading: true, errorText: '' })
    try {
      await this.refreshStation(stationId)
    } catch (error) {
      this.setData({ errorText: error.message || '场次加载失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async refreshStation (stationId = this.data.stationId) {
    if (!stationId) return
    const [station, queue] = await Promise.all([
      stationApi.getStation(stationId),
      stationApi.getTodayQueue(stationId)
    ])
    this.applyStation(Object.assign({}, station, {
      queue: queue.items || station.queue || []
    }))
  },

  applyStation (station = {}) {
    const queue = Array.isArray(station.queue) ? station.queue : []
    const currentQueueItem = station.currentQueueItem || queue.find(item => ['CALLED', 'MEASURING', 'RESULT_PENDING'].includes(String(item.status || ''))) || null
    const currentDraft = station.currentDraft || currentDraftFromQueueItem(currentQueueItem)
    this.setData({
      stationId: valueText(station.id || station.stationId, this.data.stationId),
      stationStatus: valueText(station.status, 'OPEN'),
      checkinToken: valueText(station.checkinToken, this.data.checkinToken),
      tokenExpiresAt: valueText(station.tokenExpiresAt),
      queue,
      currentQueueItem,
      currentDraft,
      metrics: currentQueueItem && currentQueueItem.metrics ? currentQueueItem.metrics.map(metricText) : this.data.metrics,
      canConfirm: valueText(currentDraft?.status || currentQueueItem?.draftStatus) === 'RESULT_PENDING',
      statusText: currentQueueItem
        ? `${patientProfile(currentQueueItem).maskedName} 已在队列中`
        : valueText(station.status, 'OPEN') === 'OPEN'
          ? '等待下一位患者'
          : '场次已关闭'
    })
  },

  async callNext () {
    if (!this.data.stationId) {
      wx.showToast({ title: '请先创建场次', icon: 'none' })
      return
    }
    this.setData({ loading: true, errorText: '' })
    try {
      const station = await stationApi.callNext(this.data.stationId, {
        idempotencyKey: createActionKey('station-next')
      })
      this.applyStation(station)
      const nextPatient = patientProfile(station.currentQueueItem || {})
      if (this.scale && station.currentQueueItem && station.currentQueueItem.patientSummary) {
        await this.scale.configurePatient({
          gender: Number(nextPatient.gender),
          age: Number(nextPatient.age),
          height: Number(nextPatient.height)
        })
      }
      this.measurementIdempotencyKey = createActionKey('station-draft')
      this.setData({
        measuring: !!station.currentQueueItem,
        canConfirm: false,
        metrics: [],
        currentDraft: null,
        statusText: station.currentQueueItem
          ? `已叫号：${nextPatient.maskedName}`
          : '暂无待测患者'
      })
    } catch (error) {
      this.setData({ errorText: error.message || '下一位失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  async skipCurrent () {
    if (!this.data.stationId || !this.data.currentQueueItem) return
    try {
      const station = await stationApi.skipQueueItem(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: createActionKey('station-skip')
      })
      this.applyStation(station)
    } catch (error) {
      this.setData({ errorText: error.message || '跳过失败' })
    }
  },

  async requeueCurrent () {
    if (!this.data.stationId || !this.data.currentQueueItem) return
    try {
      const station = await stationApi.requeueQueueItem(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: createActionKey('station-requeue')
      })
      this.applyStation(station)
    } catch (error) {
      this.setData({ errorText: error.message || '重排失败' })
    }
  },

  async onScaleResult (result) {
    const metrics = Array.isArray(result?.metrics) ? result.metrics.map(metricText).filter(item => item.name) : []
    this.setData({
      metrics,
      measuring: !result?.complete,
      canConfirm: !!result?.complete,
      statusText: result?.complete ? '测量完成，请确认后提交' : '体脂秤已返回结果'
    })
    if (result?.complete) {
      await this.saveMeasurementDraft(metrics)
    }
  },

  onScaleState (state) {
    if (state.state === 'connected') {
      this.setData({ connected: true, statusText: '体脂秤已连接' })
      return
    }
    if (state.state === 'reconnecting') {
      this.setData({ statusText: '体脂秤重连中…' })
      return
    }
    if (state.state === 'error') {
      this.setData({ connected: false, errorText: state.detail || '体脂秤连接失败' })
    }
  },

  async scanDevice () {
    if (this.data.scanning) return
    this.setData({ scanning: true, errorText: '', statusText: '正在扫描体脂秤…' })
    try {
      const devices = await this.scale.startScan({ timeoutMs: 8000 })
      this.setData({
        devices,
        deviceNames: devices.map(item => item.name || item.localName || item.deviceId),
        deviceIndex: devices.length ? 0 : -1,
        statusText: devices.length ? '请选择体脂秤并连接' : '未发现体脂秤'
      })
    } catch (error) {
      this.setData({ errorText: error.message || '蓝牙扫描失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ scanning: false })
    }
  },

  onDeviceChange (event) {
    this.setData({ deviceIndex: Number(event.detail.value) })
  },

  async connectDevice () {
    const device = this.data.devices[this.data.deviceIndex]
    if (!device) {
      wx.showToast({ title: '请先扫描并选择体脂秤', icon: 'none' })
      return
    }
    this.setData({ connecting: true, errorText: '' })
    try {
      await this.scale.connect(device)
      this.setData({ connected: true, statusText: '已连接体脂秤' })
    } catch (error) {
      this.setData({ errorText: error.message || '体脂秤连接失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  async saveMeasurementDraft (metrics = this.data.metrics) {
    if (!this.data.stationId || !this.data.currentQueueItem) return
    const profile = patientProfile(this.data.currentQueueItem)
    this.setData({ saving: true, errorText: '' })
    try {
      const station = await stationApi.saveMeasurementDraft(this.data.stationId, this.data.currentQueueItem.id, {
        idempotencyKey: this.measurementIdempotencyKey || createActionKey('station-draft'),
        deviceId: this.scale?.deviceId || '',
        measuredAt: currentTimestamp(),
        gender: profile.gender,
        age: profile.age,
        height: profile.height,
        metrics: metrics.map(item => ({
          type: item.name,
          value: item.value,
          unit: item.unit
        }))
      })
      this.applyStation(station)
      this.setData({
        currentDraft: station.currentDraft || currentDraftFromQueueItem(station.currentQueueItem || this.data.currentQueueItem),
        canConfirm: true,
        measuring: false,
        statusText: '草稿已保存，等待医生确认'
      })
    } catch (error) {
      this.setData({ errorText: error.message || '草稿保存失败' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async confirmMeasurement () {
    if (!this.data.stationId || !this.data.currentQueueItem || !this.data.currentDraft) return
    this.setData({ saving: true, errorText: '' })
    try {
      const station = await stationApi.confirmMeasurement(this.data.stationId, this.data.currentQueueItem.id, this.data.currentDraft.id, {
        idempotencyKey: createActionKey('station-confirm')
      })
      this.applyStation(station)
      this.setData({
        currentDraft: station.currentDraft || this.data.currentDraft,
        canConfirm: false,
        measuring: false,
        statusText: '测量已确认'
      })
    } catch (error) {
      this.setData({ errorText: error.message || '确认失败' })
    } finally {
      this.setData({ saving: false })
    }
  },

  async closeStation () {
    if (!this.data.stationId) return
    const discardDraftIds = this.data.currentDraft?.id ? [this.data.currentDraft.id] : []
    this.setData({ loading: true, errorText: '' })
    try {
      const station = await stationApi.closeStation(this.data.stationId, {
        idempotencyKey: createActionKey('station-close'),
        discardDraftIds
      })
      this.applyStation(station)
      this.setData({ statusText: '场次已关闭', canConfirm: false, measuring: false })
    } catch (error) {
      this.setData({ errorText: error.message || '关闭场次失败' })
    } finally {
      this.setData({ loading: false })
    }
  },

  copyToken () {
    if (!this.data.checkinToken) return
    wx.setClipboardData({
      data: this.data.checkinToken,
      success: () => wx.showToast({ title: '签到令牌已复制', icon: 'success' })
    })
  },

  retry () {
    if (!this.data.stationId) {
      return this.createStation()
    }
    return this.refreshStation(this.data.stationId)
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
