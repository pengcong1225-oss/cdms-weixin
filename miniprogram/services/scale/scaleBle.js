/* 花潮 AiLink 身高体脂秤专用 BLE 通道。不要与 services/bleManager.js（指环）共享状态。 */
const SERVICE_UUID = '0000FFE0-0000-1000-8000-00805F9B34FB'
const WRITE_UUID = '0000FFE1-0000-1000-8000-00805F9B34FB'
const NOTIFY_UUID = '0000FFE2-0000-1000-8000-00805F9B34FB'
const ALT_NOTIFY_UUID = '0000FFE3-0000-1000-8000-00805F9B34FB'
const HEADER = 0xA9
const TAIL = 0x9A

function normalizeUuid (value) {
  const text = String(value || '').toLowerCase()
  if (/^[0-9a-f]{4}$/.test(text)) return `0000${text}-0000-1000-8000-00805f9b34fb`
  return text
}

function frame (type, payload = []) {
  const body = [type & 0xff, ...payload.map(value => Number(value) & 0xff)]
  const result = new Uint8Array(body.length + 6)
  result[0] = HEADER
  result[1] = 0x00
  result[2] = 0x26
  result[3] = body.length
  result.set(body, 4)
  let sum = 0
  for (let i = 1; i < result.length - 2; i++) sum = (sum + result[i]) & 0xff
  result[result.length - 2] = sum
  result[result.length - 1] = TAIL
  return result
}

function buildUserInfoFrame ({ gender = 0, age, height }) {
  if (!Number.isInteger(age) || age < 0 || age > 255) throw new RangeError('age must be 0..255')
  if (!Number.isFinite(Number(height)) || Number(height) <= 0 || Number(height) > 255) throw new RangeError('height must be 1..255 cm')
  return frame(0x01, [Number(gender) === 1 ? 1 : 0, age, Math.round(Number(height))])
}

function buildUnitFrame ({ heightUnit = 0, weightUnit = 0 } = {}) {
  return frame(0x04, [heightUnit, weightUnit])
}

function buildWorkModeFrame (mode = 1) {
  if (![1, 2, 3].includes(Number(mode))) throw new RangeError('mode must be 1, 2 or 3')
  return frame(0x06, [mode])
}

function buildCompletionAckFrame () { return frame(0x31, [0x00]) }

function uint16 (bytes, offset) { return ((bytes[offset] & 0xff) << 8) | (bytes[offset + 1] & 0xff) }
function unmeasured (value) { return value === 0xffff || value === 0xff }
function metric (name, value, unit) { return { name, value, unit } }

function parseScaleFrame (input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || [])
  if (bytes.length < 6 || bytes[0] !== HEADER || bytes[bytes.length - 1] !== TAIL) throw new Error('SCALE_FRAME_INVALID')
  if (bytes.length !== (bytes[3] & 0xff) + 6) throw new Error('SCALE_FRAME_LENGTH')
  let sum = 0
  for (let i = 1; i < bytes.length - 2; i++) sum = (sum + bytes[i]) & 0xff
  if (bytes[bytes.length - 2] !== sum) throw new Error('SCALE_FRAME_CHECKSUM')
  const type = bytes[4] & 0xff
  if (type === 0x30) return { type, complete: true, metrics: [] }
  if (type === 0x10) {
    if (bytes.length < 13 || bytes[5] !== 0x02) return { type, status: 'realtime', metrics: [] }
    const raw = ((bytes[6] & 0xff) << 16) | ((bytes[7] & 0xff) << 8) | (bytes[8] & 0xff)
    const flags = bytes[9] & 0xff
    const decimals = flags >>> 4
    const unitCode = flags & 0x0f
    const units = { 0: 'kg', 1: 'jin', 4: 'st:lb', 6: 'lb' }
    return { type, status: 'stable', metrics: [metric('weight', raw / Math.pow(10, decimals), units[unitCode] || 'unknown')] }
  }
  if (type === 0x12) return { type, metrics: unmeasured(bytes[5]) ? [] : [metric('heartRate', bytes[5] & 0xff, 'bpm')] }
  if (type === 0x14) {
    if (bytes.length < 11) throw new Error('SCALE_FRAME_LAYOUT')
    const units = { 0: 'cm', 1: 'inch', 2: 'ft-in' }
    return { type, metrics: [metric('height', uint16(bytes, 5) / 10, units[bytes[7]] || 'unknown')] }
  }
  if (type !== 0x15 || bytes.length < 20) return { type, metrics: [] }
  const segment = bytes[5] & 0xff
  const metrics = []
  if (segment === 1) {
    const fat = uint16(bytes, 6); if (!unmeasured(fat)) metrics.push(metric('bodyFat', fat / 10, '%'))
    const subcutaneous = uint16(bytes, 8); if (!unmeasured(subcutaneous)) metrics.push(metric('subcutaneousFat', subcutaneous / 10, '%'))
    const visceral = uint16(bytes, 10); if (!unmeasured(visceral)) metrics.push(metric('visceralFat', visceral, ''))
    const muscle = uint16(bytes, 12); if (!unmeasured(muscle)) metrics.push(metric('muscleRate', muscle / 10, '%'))
    const basal = uint16(bytes, 14); if (!unmeasured(basal)) metrics.push(metric('basalMetabolism', basal, 'kcal'))
    if (!unmeasured(bytes[16])) metrics.push(metric('bodyAge', bytes[16] & 0xff, 'years'))
  } else if (segment === 2) {
    const bone = uint16(bytes, 6); if (!unmeasured(bone)) metrics.push(metric('boneMass', bone / 10, 'kg'))
    const water = uint16(bytes, 8); if (!unmeasured(water)) metrics.push(metric('water', water / 10, '%'))
    const protein = uint16(bytes, 10); if (!unmeasured(protein)) metrics.push(metric('protein', protein / 10, '%'))
    const bmi = uint16(bytes, 12); if (!unmeasured(bmi)) metrics.push(metric('bmi', bmi / 10, ''))
    if (!unmeasured(bytes[14])) metrics.push(metric('heartRate', bytes[14] & 0xff, 'bpm'))
    if (!unmeasured(bytes[15])) metrics.push(metric('obesityLevel', bytes[15] & 0xff, ''))
  } else throw new Error('SCALE_FRAME_SEGMENT')
  return { type, segment, metrics }
}

class FrameAssembler {
  constructor () { this.buffer = new Uint8Array(0) }
  push (input) {
    const incoming = input instanceof Uint8Array ? input : new Uint8Array(input || [])
    const combined = new Uint8Array(this.buffer.length + incoming.length)
    combined.set(this.buffer); combined.set(incoming, this.buffer.length); this.buffer = combined
    const output = []
    while (this.buffer.length >= 6) {
      let start = this.buffer.indexOf(HEADER)
      if (start < 0) { this.buffer = new Uint8Array(0); break }
      if (start > 0) this.buffer = this.buffer.slice(start)
      const expected = (this.buffer[3] & 0xff) + 6
      if (expected < 6 || expected > 64) { this.buffer = this.buffer.slice(1); continue }
      if (this.buffer.length < expected) break
      const candidate = this.buffer.slice(0, expected); this.buffer = this.buffer.slice(expected)
      try { output.push(parseScaleFrame(candidate)) } catch (_) { /* 丢弃坏帧，等待下一帧 */ }
    }
    return output
  }
}

function callWx (name, options) {
  return new Promise((resolve, reject) => {
    if (typeof wx?.[name] !== 'function') return reject(new Error(`BLE_API_UNAVAILABLE:${name}`))
    wx[name]({ ...options, success: resolve, fail: reject })
  })
}

function isScaleDevice (device) {
  const text = `${device?.name || ''} ${device?.localName || ''}`.toLowerCase()
  return /ailink|swan|花潮|体脂|身高|scale/.test(text) || Object.keys(device?.serviceData || {}).some(uuid => normalizeUuid(uuid) === SERVICE_UUID.toLowerCase())
}

class ScaleBle {
  constructor ({ onState, onResult } = {}) {
    this.onState = onState || (() => {})
    this.onResult = onResult || (() => {})
    this.devices = new Map(); this.deviceId = ''; this.writeId = ''; this.notifyId = ''
    this.assembler = new FrameAssembler(); this.manualClose = false; this.reconnectPromise = null; this.reconnectAttempts = 0
    this.deviceFoundListener = null; this.connectionListener = null; this.valueListener = null
  }
  state (value, detail) { try { this.onState({ state: value, deviceId: this.deviceId, detail }) } catch (_) {} }
  /** 切换患者/重新叫号时调用：丢弃解析缓冲里的残留半帧并新建 FrameAssembler，旧连接周期的延迟帧不再进入新会话。 */
  reset () { if (this.assembler) { this.assembler.buffer = new Uint8Array(0); this.assembler = new FrameAssembler() } }
  async startScan ({ timeoutMs = 10000 } = {}) {
    await callWx('openBluetoothAdapter', {})
    this.devices.clear(); this.stopScanListeners()
    this.deviceFoundListener = result => (result?.devices || []).filter(isScaleDevice).forEach(device => this.devices.set(device.deviceId, device))
    wx.onBluetoothDeviceFound(this.deviceFoundListener)
    await callWx('startBluetoothDevicesDiscovery', { allowDuplicatesKey: false })
    this.state('scanning')
    await new Promise(resolve => { this.scanTimer = setTimeout(resolve, timeoutMs) })
    await this.stopScan()
    return Array.from(this.devices.values())
  }
  async stopScan () {
    if (this.scanTimer) clearTimeout(this.scanTimer); this.scanTimer = null
    if (typeof wx.stopBluetoothDevicesDiscovery === 'function') await new Promise(resolve => wx.stopBluetoothDevicesDiscovery({ complete: resolve }))
    this.stopScanListeners(); if (!this.deviceId) this.state('disconnected')
  }
  stopScanListeners () { if (this.deviceFoundListener && typeof wx.offBluetoothDeviceFound === 'function') wx.offBluetoothDeviceFound(this.deviceFoundListener); this.deviceFoundListener = null }
  async connect (device) {
    const deviceId = typeof device === 'string' ? device : device?.deviceId
    if (!deviceId) throw new Error('请选择体脂秤')
    this.manualClose = false; this.reconnectAttempts = 0; this.lastDevice = typeof device === 'string' ? { deviceId } : device
    return this.connectInternal(deviceId)
  }
  async connectInternal (deviceId) {
    await this.stopScan(); this.state('connecting')
    await callWx('createBLEConnection', { deviceId, timeout: 10000 })
    const services = await callWx('getBLEDeviceServices', { deviceId })
    const service = (services.services || []).find(item => normalizeUuid(item.uuid) === SERVICE_UUID.toLowerCase())
    if (!service) throw new Error('体脂秤 BLE 服务 FFE0 未找到')
    const characteristics = await callWx('getBLEDeviceCharacteristics', { deviceId, serviceId: service.uuid })
    const list = characteristics.characteristics || []
    const write = list.find(item => normalizeUuid(item.uuid) === WRITE_UUID.toLowerCase() && (item.properties?.write || item.properties?.writeNoResponse))
    const notify = list.find(item => normalizeUuid(item.uuid) === NOTIFY_UUID.toLowerCase() && (item.properties?.notify || item.properties?.indicate))
      || list.find(item => normalizeUuid(item.uuid) === ALT_NOTIFY_UUID.toLowerCase() && (item.properties?.notify || item.properties?.indicate))
    if (!write || !notify) throw new Error('体脂秤 BLE 特征 FFE1/FFE2 未找到')
    this.deviceId = deviceId; this.serviceId = service.uuid; this.writeId = write.uuid; this.notifyId = notify.uuid; this.assembler = new FrameAssembler()
    this.installListeners()
    await callWx('notifyBLECharacteristicValueChange', { state: true, deviceId, serviceId: this.serviceId, characteristicId: this.notifyId })
    this.state('connected'); return this.lastDevice
  }
  installListeners () {
    if (!this.valueListener) {
      this.valueListener = event => {
        if (event.deviceId !== this.deviceId || normalizeUuid(event.characteristicId) !== normalizeUuid(this.notifyId)) return
        this.assembler.push(new Uint8Array(event.value || [])).forEach(result => {
          try { if (result.complete) this.write(buildCompletionAckFrame()).catch(() => {}); this.onResult(result) } catch (_) {}
        })
      }
      wx.onBLECharacteristicValueChange(this.valueListener)
    }
    if (!this.connectionListener && typeof wx.onBLEConnectionStateChange === 'function') {
      this.connectionListener = event => { if (event.deviceId === this.deviceId && !event.connected && !this.manualClose) this.scheduleReconnect() }
      wx.onBLEConnectionStateChange(this.connectionListener)
    }
  }
  async write (bytes) {
    if (!this.deviceId || !this.serviceId || !this.writeId) throw new Error('体脂秤未连接')
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
    for (let offset = 0; offset < data.length; offset += 20) {
      await callWx('writeBLECharacteristicValue', { deviceId: this.deviceId, serviceId: this.serviceId, characteristicId: this.writeId, value: data.slice(offset, offset + 20).buffer })
    }
  }
  async configurePatient (patient) {
    await this.write(buildUnitFrame({ heightUnit: 0, weightUnit: 0 }))
    await this.write(buildUserInfo(patient))
    await this.write(buildWorkModeFrame(1))
  }
  scheduleReconnect () {
    if (this.reconnectPromise || this.manualClose || !this.lastDevice?.deviceId) return
    this.reconnectPromise = (async () => {
      this.state('reconnecting')
      for (let attempt = 1; attempt <= 3 && !this.manualClose; attempt++) {
        this.reconnectAttempts = attempt
        await new Promise(resolve => setTimeout(resolve, attempt * 700))
        try { await this.connectInternal(this.lastDevice.deviceId); this.reconnectPromise = null; return } catch (_) {}
      }
      this.reconnectPromise = null; this.state('error', '体脂秤断线，自动重连失败，请重新扫描')
    })()
  }
  async disconnect () {
    this.manualClose = true; this.reconnectPromise = null
    if (this.deviceId && typeof wx.closeBLEConnection === 'function') await new Promise(resolve => wx.closeBLEConnection({ deviceId: this.deviceId, complete: resolve }))
    this.deviceId = ''; this.serviceId = ''; this.writeId = ''; this.notifyId = ''; this.state('disconnected')
  }
  destroy () { this.manualClose = true; this.stopScanListeners(); if (this.valueListener && wx.offBLECharacteristicValueChange) wx.offBLECharacteristicValueChange(this.valueListener); if (this.connectionListener && wx.offBLEConnectionStateChange) wx.offBLEConnectionStateChange(this.connectionListener); this.valueListener = null; this.connectionListener = null }
}

module.exports = { SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, ALT_NOTIFY_UUID, FrameAssembler, ScaleBle, buildUserInfoFrame, buildUnitFrame, buildWorkModeFrame, buildCompletionAckFrame, parseScaleFrame, isScaleDevice }
