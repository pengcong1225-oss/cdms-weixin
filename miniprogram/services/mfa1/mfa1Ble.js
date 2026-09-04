/* MFA-1 血糖仪专用 BLE 通道（《MFA-1 BLE 蓝牙通讯协议》）。不得与 services/scale/scaleBle.js（体脂秤）或 bleManager（指环）共用状态。 */
const SERVICE_UUID = '0000FFF0-0000-1000-8000-00805F9B34FB'   // 广播服务 FFF0
const WRITE_UUID = '0000FFF6-0000-1000-8000-00805F9B34FB'     // TX：手机 → 设备（16 字节/包）
const NOTIFY_UUID = '0000FFF7-0000-1000-8000-00805F9B34FB'    // RX：设备 → 手机通知（16 字节/包）
const FRAME_SIZE = 16                                          // 协议固定 16 字节帧

const CMD_SET_TIME = 0x01      // 设置时间（应答回显）
const CMD_READ_BATTERY = 0x13  // 读取电量（应答字节1 = 0..100 百分比）
const CMD_READ_MAC = 0x22      // 读取 MAC（应答字节1..6 = MAC0..5）
const CMD_READ_TIME = 0x41     // 读取时间
const CMD_TEST_RESULT = 0x78   // 测试结果：测试完成后设备主动推送，无需轮询

const RESULT_TYPE_GLUCOSE = 1
const RESULT_TYPE_URIC_ACID = 2
const RESULT_TYPE_LIPID = 3
const RESULT_TYPE_BLOOD_PRESSURE = 4

function normalizeUuid (value) {
  const text = String(value || '').toLowerCase()
  if (/^[0-9a-f]{4}$/.test(text)) return `0000${text}-0000-1000-8000-00805f9b34fb`
  return text
}

function crc (bytes) {
  // CRC = 前 15 字节求和 & 0xFF（字节 15 为校验位）
  let sum = 0
  for (let i = 0; i < FRAME_SIZE - 1; i++) sum = (sum + (bytes[i] & 0xff)) & 0xff
  return sum
}

function toBcd (value) {
  const n = Number(value) & 0xff
  return ((Math.floor(n / 10) << 4) | (n % 10)) & 0xff
}

function fromBcd (value) {
  const b = value & 0xff
  return ((b >>> 4) & 0x0f) * 10 + (b & 0x0f)
}

/** 通用 16 字节帧构造：字节0=命令，字节1..14=载荷（不足补 00），字节15=CRC。 */
function buildFrame (command, payload = []) {
  const bytes = new Uint8Array(FRAME_SIZE)
  bytes[0] = command & 0x7f
  payload.slice(0, 14).forEach((value, index) => { bytes[index + 1] = Number(value) & 0xff })
  bytes[FRAME_SIZE - 1] = crc(bytes)
  return bytes
}

/** 0x01 设置时间：载荷 AA(年BCD) BB(月) CC(日) DD(时) EE(分) FF(秒)，其余 00。 */
function buildSetTimeFrame (date = new Date()) {
  const year = date.getFullYear() % 100
  return buildFrame(CMD_SET_TIME, [toBcd(year), date.getMonth() + 1, date.getDate(), date.getHours(), date.getMinutes(), date.getSeconds()])
}

function buildReadTimeFrame () { return buildFrame(CMD_READ_TIME) }
function buildReadBatteryFrame () { return buildFrame(CMD_READ_BATTERY) }
function buildReadMacFrame () { return buildFrame(CMD_READ_MAC) }

/** 大端 IEEE754 单精度浮点（D1..D4），DataView 保证小程序 ArrayBuffer 与 Node 双端兼容。 */
function readFloat32BE (bytes, offset) {
  const view = new DataView(new ArrayBuffer(4))
  for (let i = 0; i < 4; i++) view.setUint8(i, bytes[offset + i] & 0xff)
  const value = view.getFloat32(0, false)
  if (!Number.isFinite(value)) throw new Error('MFA1_FRAME_FLOAT')
  // 血糖/血尿酸保留 3 位小数即可，消除浮点尾噪（如 5.5 → 5.5 而非 5.500000059…）。
  return Math.round(value * 1000) / 1000
}

function fastStateText (code) {
  const n = code & 0xff
  if (n === 1) return '空腹'
  if (n === 2) return '餐后'
  return ''
}

/** 解析 16 字节帧；Bit7 为应答错误位（设备错误应答 = 命令|0x80）。 */
function parseMfa1Frame (input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || [])
  if (bytes.length !== FRAME_SIZE) throw new Error('MFA1_FRAME_LENGTH')
  if (bytes[FRAME_SIZE - 1] !== crc(bytes)) throw new Error('MFA1_FRAME_CHECKSUM')
  const raw = bytes[0] & 0xff
  const command = raw & 0x7f
  if (raw & 0x80) return { command, type: 'error', error: true }

  if (command === CMD_SET_TIME) return { command, type: 'timeSyncAck' }
  if (command === CMD_READ_TIME) {
    return {
      command, type: 'time',
      year: 2000 + fromBcd(bytes[1]), month: bytes[2], day: bytes[3],
      hour: bytes[4], minute: bytes[5], second: bytes[6]
    }
  }
  if (command === CMD_READ_BATTERY) return { command, type: 'battery', level: bytes[1] & 0xff }
  if (command === CMD_READ_MAC) {
    const mac = Array.from(bytes.slice(1, 7)).map(value => value.toString(16).padStart(2, '0').toUpperCase()).join(':')
    return { command, type: 'mac', mac }
  }
  if (command === CMD_TEST_RESULT) return parseTestResult(bytes)
  return { command, type: 'unknown' }
}

function parseTestResult (bytes) {
  const kind = bytes[1] & 0xff
  if (kind === RESULT_TYPE_GLUCOSE || kind === RESULT_TYPE_URIC_ACID) {
    // GLU/UA：字节2..5(D1..D4)=FLOAT 大端，字节6(D5)=1 空腹 / 2 餐后
    const name = kind === RESULT_TYPE_GLUCOSE ? 'glucose' : 'uricAcid'
    const value = readFloat32BE(bytes, 2)
    const fastCode = bytes[6] & 0xff
    return {
      command: CMD_TEST_RESULT, type: 'result',
      metric: { name, value, unit: 'mmol/L', state: fastStateText(fastCode), fastState: fastCode }
    }
  }
  if (kind === RESULT_TYPE_LIPID) {
    // 协议原文血脂帧字段 D1..D4=TC、D6..D9=HDL、D10..D13=TG、D14..D17=LDL，
    // 已超出 16 字节定长帧（字节15 为 CRC），存在文档歧义。第一期按 16 字节帧仅取
    // TC（D1..D4）与 D5 空腹/餐后标记，指标 type 用 'tc'；HDL/TG/LDL 留 TODO。
    const value = readFloat32BE(bytes, 2)
    const fastCode = bytes[6] & 0xff
    return {
      command: CMD_TEST_RESULT, type: 'result',
      metric: { name: 'tc', value, unit: 'mmol/L', state: fastStateText(fastCode), fastState: fastCode }
    }
  }
  if (kind === RESULT_TYPE_BLOOD_PRESSURE) {
    // TODO 第二期：血压帧（D2=高压 D3=低压 等）原文字段含义模糊，暂不解析。
    return { command: CMD_TEST_RESULT, type: 'result', metric: null, unsupported: 'bloodPressure' }
  }
  return { command: CMD_TEST_RESULT, type: 'result', metric: null, unknownKind: kind }
}

/** BLE 通知可能粘包/分包：协议 16 字节定长，直接按 16 字节切帧，坏帧丢弃。 */
class FrameAssembler {
  constructor () { this.buffer = new Uint8Array(0) }
  push (input) {
    const incoming = input instanceof Uint8Array ? input : new Uint8Array(input || [])
    const combined = new Uint8Array(this.buffer.length + incoming.length)
    combined.set(this.buffer); combined.set(incoming, this.buffer.length)
    const output = []
    let offset = 0
    // 防脏数据无限堆积：丢弃无法成帧的残留（保留不足 16 字节尾部）。
    while (combined.length - offset >= FRAME_SIZE) {
      const candidate = combined.slice(offset, offset + FRAME_SIZE)
      offset += FRAME_SIZE
      try { output.push(parseMfa1Frame(candidate)) } catch (_) { /* 丢弃坏帧，等待下一帧 */ }
    }
    this.buffer = offset < combined.length ? combined.slice(offset) : new Uint8Array(0)
    if (this.buffer.length > FRAME_SIZE * 8) this.buffer = new Uint8Array(0)
    return output
  }
}

function callWx (name, options) {
  return new Promise((resolve, reject) => {
    if (typeof wx?.[name] !== 'function') return reject(new Error(`BLE_API_UNAVAILABLE:${name}`))
    wx[name]({ ...options, success: resolve, fail: reject })
  })
}

/** 广播设备名形如 "MFA-1 M XXXX"（XXXX 为 MAC 后 4 位）：按名字 /mfa/i 或服务 UUID FFF0 匹配。 */
function isMfa1Device (device) {
  const text = `${device?.name || ''} ${device?.localName || ''}`.toLowerCase()
  return /mfa/.test(text) || Object.keys(device?.serviceData || {}).some(uuid => normalizeUuid(uuid) === normalizeUuid(SERVICE_UUID))
}

class Mfa1Ble {
  constructor ({ onState, onResult } = {}) {
    this.onState = onState || (() => {})
    this.onResult = onResult || (() => {})
    this.devices = new Map(); this.deviceId = ''; this.writeId = ''; this.notifyId = ''
    this.assembler = new FrameAssembler(); this.manualClose = false; this.reconnectPromise = null; this.reconnectAttempts = 0
    this.deviceFoundListener = null; this.connectionListener = null; this.valueListener = null
  }
  state (value, detail) { try { this.onState({ state: value, deviceId: this.deviceId, detail }) } catch (_) {} }
  async startScan ({ timeoutMs = 10000 } = {}) {
    await callWx('openBluetoothAdapter', {})
    this.devices.clear(); this.stopScanListeners()
    this.deviceFoundListener = result => (result?.devices || []).filter(isMfa1Device).forEach(device => this.devices.set(device.deviceId, device))
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
    if (!deviceId) throw new Error('请选择 MFA-1 血糖仪')
    this.manualClose = false; this.reconnectAttempts = 0; this.lastDevice = typeof device === 'string' ? { deviceId } : device
    return this.connectInternal(deviceId)
  }
  async connectInternal (deviceId) {
    await this.stopScan(); this.state('connecting')
    await callWx('createBLEConnection', { deviceId, timeout: 10000 })
    const services = await callWx('getBLEDeviceServices', { deviceId })
    const service = (services.services || []).find(item => normalizeUuid(item.uuid) === normalizeUuid(SERVICE_UUID))
    if (!service) throw new Error('MFA-1 BLE 服务 FFF0 未找到')
    const characteristics = await callWx('getBLEDeviceCharacteristics', { deviceId, serviceId: service.uuid })
    const list = characteristics.characteristics || []
    const write = list.find(item => normalizeUuid(item.uuid) === normalizeUuid(WRITE_UUID) && (item.properties?.write || item.properties?.writeNoResponse))
    const notify = list.find(item => normalizeUuid(item.uuid) === normalizeUuid(NOTIFY_UUID) && (item.properties?.notify || item.properties?.indicate))
    if (!write || !notify) throw new Error('MFA-1 BLE 特征 FFF6/FFF7 未找到')
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
          try { this.onResult(result) } catch (_) {}
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
    if (!this.deviceId || !this.serviceId || !this.writeId) throw new Error('MFA-1 未连接')
    const data = bytes instanceof Uint8Array ? bytes : Uint8Array.from(bytes || [])
    // 协议规定 16 字节/包写入 TX 特征
    for (let offset = 0; offset < data.length; offset += FRAME_SIZE) {
      await callWx('writeBLECharacteristicValue', { deviceId: this.deviceId, serviceId: this.serviceId, characteristicId: this.writeId, value: data.slice(offset, offset + FRAME_SIZE).buffer })
    }
  }
  /** 连接成功后同步设备时间（0x01）。 */
  async syncTime (date = new Date()) { return this.write(buildSetTimeFrame(date)) }
  /** 主动读取电量（0x13），结果经 onResult 返回。 */
  async getBattery () { return this.write(buildReadBatteryFrame()) }
  scheduleReconnect () {
    if (this.reconnectPromise || this.manualClose || !this.lastDevice?.deviceId) return
    this.reconnectPromise = (async () => {
      this.state('reconnecting')
      for (let attempt = 1; attempt <= 3 && !this.manualClose; attempt++) {
        this.reconnectAttempts = attempt
        await new Promise(resolve => setTimeout(resolve, attempt * 700))
        try { await this.connectInternal(this.lastDevice.deviceId); this.reconnectPromise = null; return } catch (_) {}
      }
      this.reconnectPromise = null; this.state('error', 'MFA-1 断线，自动重连失败，请重新扫描')
    })()
  }
  async disconnect () {
    this.manualClose = true; this.reconnectPromise = null
    if (this.deviceId && typeof wx.closeBLEConnection === 'function') await new Promise(resolve => wx.closeBLEConnection({ deviceId: this.deviceId, complete: resolve }))
    this.deviceId = ''; this.serviceId = ''; this.writeId = ''; this.notifyId = ''; this.state('disconnected')
  }
  destroy () { this.manualClose = true; this.stopScanListeners(); if (this.valueListener && wx.offBLECharacteristicValueChange) wx.offBLECharacteristicValueChange(this.valueListener); if (this.connectionListener && wx.offBLEConnectionStateChange) wx.offBLEConnectionStateChange(this.connectionListener); this.valueListener = null; this.connectionListener = null }
}

module.exports = {
  SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, FRAME_SIZE,
  CMD_SET_TIME, CMD_READ_BATTERY, CMD_READ_MAC, CMD_READ_TIME, CMD_TEST_RESULT,
  FrameAssembler, Mfa1Ble, buildFrame, buildSetTimeFrame, buildReadTimeFrame,
  buildReadBatteryFrame, buildReadMacFrame, parseMfa1Frame, isMfa1Device, readFloat32BE
}
