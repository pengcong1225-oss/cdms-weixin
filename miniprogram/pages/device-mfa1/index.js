/* MFA-1 血糖仪工作站：复用体脂秤场次机制（deviceType=MFA1），扫码签到 → 叫号 → 采血 → 0x78 结果 → 草稿 → 确认。 */
const stationApi = require('../../utils/station-api')
const { ensureSession } = require('../../utils/auth-guard')
const { Mfa1Ble } = require('../../services/mfa1Ble')
const { buildQrMatrix, createCheckinPayload, drawQr } = require('../../utils/scale-qr')

function valueText (value, fallback = '') {
  return value === null || value === undefined || value === '' ? fallback : String(value)
}

function metricLabel (name) {
  const labels = {
    glucose: '血糖',
    uricAcid: '血尿酸',
    tc: '总胆固醇',
    battery: '电量'
  }
  return labels[name] || name
}

function metricText (metric) {
  return {
    name: valueText(metric?.name || metric?.type),
    value: metric?.value,
    unit: valueText(metric?.unit),
    state: valueText(metric?.state),
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
    genderText: valueText(summary.genderText, valueText(summary.gender)),
    ageText: valueText(summary.age)
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
    qrPayload: '',
    tokenExpiresAt: '',
    queue: [],
    currentQueueItem: null,
    currentDraft: null,
    metrics: [],
    devices: [],
    deviceNames: [],
    deviceIndex: -1,
    connected: false,
    batteryText: ''
  },

  async onLoad (query = {}) {
    try {
      const session = await ensureSession({ role: 'DOCTOR' })
      if (session.activeRole !== 'DOCTOR') {
        this.setData({ errorText: '请先使用医生账号登录' })
        return
      }
      this.mfa1 = new Mfa1Ble({
        onState: state => this.onMfa1State(state),
        onResult: result => this.onMfa1Result(result)
      })
      const stationId = valueText(query.stationId, '')
      this.setData({ errorText: '', stationId })
      if (stationId) {
        await this.loadStation(stationId)
        return
      }
      await this.createStation()
    } catch (error) {
      this.setData({ loading: false, creating: false, errorText: error?.statusCode === 401 ? '登录状态已失效，请重新登录' : 'MFA-1 工作站加载失败，请稍后重试' })
    }
  },

  onUnload () {
    if (this.mfa1) {
      this.mfa1.disconnect().catch(() => {})
      this.mfa1.destroy()
    }
  },

  async createStation () {
    this.setData({ creating: true, loading: true, errorText: '' })
    try {
      const station = await stationApi.createStation({
        stationName: 'MFA-1 血糖轮测场次',
        deviceType: 'MFA1',
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
    const nextStationId = valueText(station.id || station.stationId, this.data.stationId)
    const nextToken = valueText(station.checkinToken, this.data.checkinToken)
    this.setData({
      stationId: nextStationId,
      stationStatus: valueText(station.status, 'OPEN'),
      checkinToken: nextToken,
      qrPayload: createCheckinPayload(nextStationId, nextToken),
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
    }, () => this.drawCheckinQr())
  },

  drawCheckinQr () {
    if (!this.qrReady || !this.data.qrPayload || typeof wx.createCanvasContext !== 'function') return
    try {
      const matrix = buildQrMatrix(this.data.qrPayload)
      drawQr(wx.createCanvasContext('mfa1Qr', this), matrix, { size: 240, quiet: 4 })
    } catch (error) {
      this.setData({ errorText: error.message || '二维码生成失败' })
    }
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
      // MFA-1 无需 configurePatient：叫号后直接提示采血
      this.measurementIdempotencyKey = createActionKey('station-draft')
      this.setData({
        measuring: !!station.currentQueueItem,
        canConfirm: false,
        metrics: [],
        currentDraft: null,
        statusText: station.currentQueueItem
          ? `已叫号：${patientProfile(station.currentQueueItem || {}).maskedName}，请采血`
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

  async onMfa1Result (result) {
    if (result?.type === 'battery') {
      this.batteryLevel = Number(result.level)
      this.setData({ batteryText: `${Number(result.level)}%` })
      return
    }
    if (result?.type === 'timeSyncAck' || result?.type === 'time') {
      this.setData({ statusText: '设备时间已同步' })
      return
    }
    if (result?.type === 'error') {
      this.setData({ errorText: '设备返回错误应答，请重新测量' })
      return
    }
    if (result?.type !== 'result' || !result.metric) return
    if (result.metric.name === 'battery') {
      this.batteryLevel = Number(result.metric.value)
      this.setData({ batteryText: `${result.metric.value}%` })
      return
    }
    const metrics = [metricText(result.metric)]
    this.setData({
      metrics,
      measuring: false,
      canConfirm: true,
      statusText: `测量完成（${metrics[0].label}${metrics[0].state ? ' · ' + metrics[0].state : ''}），请确认后提交`
    })
    await this.saveMeasurementDraft(metrics)
  },

  onMfa1State (state) {
    if (state.state === 'connected') {
      this.setData({ connected: true, statusText: 'MFA-1 已连接' })
      return
    }
    if (state.state === 'reconnecting') {
      this.setData({ connected: false, statusText: 'MFA-1 重连中…' })
      return
    }
    if (state.state === 'error') {
      this.setData({ connected: false, errorText: state.detail || 'MFA-1 连接失败' })
    }
  },

  async scanDevice () {
    if (this.data.scanning) return
    this.setData({ scanning: true, errorText: '', statusText: '正在扫描 MFA-1…' })
    try {
      const devices = await this.mfa1.startScan({ timeoutMs: 8000 })
      this.setData({
        devices,
        deviceNames: devices.map(item => item.name || item.localName || item.deviceId),
        deviceIndex: devices.length ? 0 : -1,
        statusText: devices.length ? '请选择 MFA-1 并连接' : '未发现 MFA-1'
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
      wx.showToast({ title: '请先扫描并选择 MFA-1', icon: 'none' })
      return
    }
    this.setData({ connecting: true, errorText: '' })
    try {
      await this.mfa1.connect(device)
      // 连接成功后：同步设备时间并读取电量
      await this.mfa1.syncTime()
      await this.mfa1.getBattery()
      this.setData({ connected: true, statusText: '已连接 MFA-1，等待采血结果' })
    } catch (error) {
      this.setData({ errorText: error.message || 'MFA-1 连接失败', statusText: '待设备匹配' })
    } finally {
      this.setData({ connecting: false })
    }
  },

  async saveMeasurementDraft (metrics = this.data.metrics) {
    if (!this.data.stationId || !this.data.currentQueueItem) return
    this.setData({ saving: true, errorText: '' })
    try {
      const resultMetrics = metrics.filter(item => item.name && item.name !== 'battery')
      const payload = {
        idempotencyKey: this.measurementIdempotencyKey || createActionKey('station-draft'),
        deviceId: this.mfa1?.deviceId || '',
        measuredAt: currentTimestamp(),
        // MFA-1 草稿不要求性别/年龄/身高，服务端按 deviceType 分支校验
        metrics: resultMetrics.map(item => ({
          type: item.name,
          value: item.value,
          unit: item.unit
        }))
      }
      if (Number.isFinite(this.batteryLevel)) {
        payload.metrics.push({ type: 'battery', value: this.batteryLevel, unit: '%' })
      }
      const station = await stationApi.saveMeasurementDraft(this.data.stationId, this.data.currentQueueItem.id, payload)
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
    if (!this.data.qrPayload) return
    wx.setClipboardData({
      data: this.data.qrPayload,
      success: () => wx.showToast({ title: '签到信息已复制', icon: 'success' })
    })
  },

  async retry () {
    try {
      if (!this.data.stationId) {
        await this.createStation()
        return
      }
      await this.refreshStation(this.data.stationId)
      this.setData({ errorText: '' })
    } catch (error) {
      this.setData({ errorText: error.message || '场次加载失败' })
    }
  },

  onReady () {
    this.qrReady = true
    this.drawCheckinQr()
  },

  backWorkspace () {
    if (wx.navigateBack) {
      wx.navigateBack({ delta: 1 })
      return
    }
    wx.switchTab({ url: '/pages/home/home' })
  }
})
