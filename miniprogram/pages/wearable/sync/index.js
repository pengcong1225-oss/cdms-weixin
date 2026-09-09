const rwfit = require('../../../utils/rwfit-sdk')
const api = require('../../../utils/api')
const cdmsBridge = require('../../../utils/cdms-bridge')
const bleManager = require('../../../services/bleManager')

Page({
  data: { mode: 'PATIENT', status: '准备就绪', scanning: false, syncing: false, devices: [], queued: 0 },
  onLoad (query) {
    const app = getApp()
    this.baseUrl = app.globalData.iotBaseUrl
    this.token = app.globalData.wearableToken
    this.managerBaseUrl = query.managerBaseUrl || app.globalData.managerBaseUrl
    this.handoffCode = query.handoffCode || app.globalData.handoffCode
    this.patientRef = query.patientRef || app.globalData.patientRef
    this.sessionId = query.sessionId || app.globalData.wearableSessionId
    this.realtimeType = query.type || 'heartRate'
    cdmsBridge.updateContext({
      managerBaseUrl: this.managerBaseUrl,
      handoffCode: this.handoffCode,
      patientRef: this.patientRef,
      mode: query.mode || 'PATIENT',
      taskId: query.taskId || ''
    })
    this.setData({ mode: query.mode || 'PATIENT', queued: api.readQueue().length })
  },
  async scan () {
    if (this.data.scanning) return
    this.setData({ scanning: true, status: '正在搜索附近设备…', devices: [] })
    try {
      const scanner = await rwfit.scan(devices => this.setData({ devices }))
      this.scanner = scanner
      this.setData({ status: '请选择要同步的设备' })
    } catch (error) { this.setData({ status: error.message || '设备搜索失败' }) }
    finally { this.setData({ scanning: false }) }
  },
  selectDevice (event) {
    this.deviceId = event.currentTarget.dataset.id
    this.setData({ status: '已选择设备，可开始同步' })
    try { this.scanner?.stop() } catch (_) {}
  },
  async startSync () {
    if (this.data.syncing) return
    if (!this.deviceId) { this.setData({ status: '请先搜索并选择设备' }); return }
    this.setData({ syncing: true, status: '正在连接手环…' })
    let sdk
    try {
      const selectedDevice = (this.data.devices || []).find(device => device.deviceId === this.deviceId)
        || { deviceId: this.deviceId }
      await bleManager.connect(selectedDevice)
      sdk = typeof bleManager.getSdk === 'function' ? bleManager.getSdk() : null
      if (!sdk) throw new Error('设备连接尚未就绪')
      this.setData({ status: '设备已连接，正在申请安全采集会话…' })
      const session = await cdmsBridge.ensureIoTSession(this.deviceId)
      this.baseUrl = session.iotBaseUrl
      this.token = session.wearableToken
      this.sessionId = session.wearableSessionId
      this.patientRef = session.patientRef
      if (!this.token) throw new Error('未取得 IoT 采集令牌')
      const syncScope = Object.freeze({
        patientRef: session.patientRef,
        deviceRef: session.deviceRef,
        sessionId: session.wearableSessionId
      })
      let records
      let errors = {}
      if (this.data.mode === 'DOCTOR') {
        this.setData({ status: '正在进行实时测量，请保持设备连接…' })
        records = await rwfit.captureRealtime(sdk, this.realtimeType || 'heartRate')
      } else {
        const result = await sdk.syncAllHealthData({ onProgress: progress => this.setData({ status: `同步 ${progress.percent || 0}%` }) })
        records = rwfit.flattenRecords(result.records)
        errors = result.errors || {}
      }
      if (records.length) {
        await cdmsBridge.enqueueAndFlush({
          deviceRef: syncScope.deviceRef,
          records,
          syncScope,
          session
        })
      }
      this.setData({ status: Object.keys(errors).length ? '部分类型同步失败，已保存成功数据' : '同步完成，正在上传…' })
      this.setData({ status: '同步完成' })
    } catch (error) {
      this.setData({ status: error.message || '同步失败，数据已保存在本机待重试' })
    } finally {
      if (sdk && typeof bleManager.disconnect === 'function') {
        try { await bleManager.disconnect() } catch (_) {}
      }
      this.setData({ syncing: false, queued: api.readQueue().length })
    }
  },
  enqueue (records) {
    api.enqueue({ batchId: `wx-${Date.now()}`, sessionId: this.sessionId, patientRef: this.patientRef,
      deviceRef: this.deviceId, records, sdkVersion: 'RW_SDK_V2.0.0_20260807' })
    this.setData({ queued: api.readQueue().length })
  },
  async retry () {
    const app = getApp()
    const livePatientRef = String(app?.globalData?.patientRef || '').trim()
    const patientRef = livePatientRef || (
      app?.globalData?.activeRole === 'DOCTOR' ? String(this.patientRef || '').trim() : ''
    )
    if (!patientRef) throw new Error('无法确定当前患者作用域，请先登录')
    const queued = api.readQueue({ patientRef })
    const queuedDeviceRefs = Array.from(new Set(queued
      .map(batch => String(batch && batch.deviceRef || '').trim())
      .filter(Boolean)))
    const deviceRef = String(this.deviceId || '').trim() || (
      queuedDeviceRefs.length === 1 ? queuedDeviceRefs[0] : ''
    )
    if (!deviceRef) {
      throw new Error(queuedDeviceRefs.length > 1
        ? '待重试队列包含多个设备，请先选择设备'
        : '无法确定待重试设备，请先选择设备')
    }
    const context = await cdmsBridge.ensureIoTSession(deviceRef)
    if (String(context.patientRef || '').trim() !== patientRef ||
      String(context.deviceRef || '').trim() !== deviceRef) {
      throw new Error('待重试设备会话作用域不一致')
    }
    if (!context.iotBaseUrl || !context.wearableToken) throw new Error('缺少 IoT 会话配置')
    await api.flushQueue({
      baseUrl: context.iotBaseUrl,
      token: context.wearableToken,
      scope: {
        patientRef: context.patientRef,
        deviceRef: context.deviceRef,
        sessionId: context.wearableSessionId
      }
    })
    this.setData({ queued: api.readQueue().length })
  }
})
