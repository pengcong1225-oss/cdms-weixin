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

/**
 * 0x78 结果帧真实字节数（真机实证 2026-09-10 血压抓包 + 协议 §6 字面布局）：
 * 命令/应答帧 = 16 字节；结果帧 = 变长 —— 非血脂 20 字节，血脂（D1..D17 全量）31 字节。
 * 布局：0x78 T1 D1..D5 00 00 00 TT YY MM DD HH mm SS 00 [d6..d17] CRC（CRC=前面所有字节求和）。
 * 旧「结果帧也是 16 字节」的假设是真机「设备连上了但数据不返回」的根因：20 字节被硬切
 * 16+4，前 16 字节 CRC 必错整帧被丢，设备明明推了结果、页面永远收不到。
 */
const RESULT_FRAME_BYTES = 20
const RESULT_FRAME_LIPID_BYTES = 31
/** 血脂数据段 D1..D17 的字节数（0x78 T1=3 帧：字节 2..18）。 */
const LIPID_DATA_BYTES = 17

/** 调试辅助（真机定位帧格式用）：字节数组 → 空格分隔 hex。 */
function hexOf (bytes) {
  return Array.from(bytes || []).map(v => (v & 0xff).toString(16).padStart(2, '0')).join(' ')
}

function normalizeUuid (value) {
  const text = String(value || '').toLowerCase()
  if (/^[0-9a-f]{4}$/.test(text)) return `0000${text}-0000-1000-8000-00805f9b34fb`
  return text
}

function crc (bytes) {
  // CRC = 前面所有字节求和 & 0xFF（最后一字节为校验位；16 字节命令帧=前 15 字节，
  // 20/31 字节结果帧=前 19/30 字节 —— 真机抓包验证：BP 结果帧前 19 字节和=0x230→0x30 ✓）
  let sum = 0
  for (let i = 0; i < bytes.length - 1; i++) sum = (sum + (bytes[i] & 0xff)) & 0xff
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

/**
 * 0x01 设置时间：载荷 AA(年) BB(月) CC(日) DD(时) EE(分) FF(秒)，其余 00。
 * 协议 §3.1 原文：「AA年；BB月；CC日；DD小时；EE分钟；FF秒。格式为BCD格式，如12年，AA = 0x12」
 * —— 六个字段全部 BCD，不是只有年。
 * 真机实证（2026-09-10 抓包）：只把年转 BCD、时分秒用二进制时，设备对 CRC 正确的帧回
 * 0x81（协议定义为「校验错误或执行 Fail」），即字段非法被拒。时 0x0C / 分 0x1D 都不是合法 BCD。
 */
function buildSetTimeFrame (date = new Date()) {
  const year = date.getFullYear() % 100
  return buildFrame(CMD_SET_TIME, [
    toBcd(year), toBcd(date.getMonth() + 1), toBcd(date.getDate()),
    toBcd(date.getHours()), toBcd(date.getMinutes()), toBcd(date.getSeconds())
  ])
}

function buildReadTimeFrame () { return buildFrame(CMD_READ_TIME) }
/**
 * 0x13 读取电量：协议 §4 要求载荷首字节 AA = 0x99（「现在进行一次电量检测」），
 * 其余 14 字节 0。发 AA=0x00 时设备不返回电量包 —— 真机实测只回 0x01 的 0x81，电量包始终缺席。
 */
function buildReadBatteryFrame () { return buildFrame(CMD_READ_BATTERY, [0x99]) }
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

/**
 * 血脂 D1..D17 拼接流约定（歧义假设，记录在案）：
 * - 起始帧承载其 data 段前 9 字节 = D1..D9：TC(float@0)、D5 餐前餐后标记(@4)、HDL(@5)。
 * - 续帧 = 挂起中紧随其后到达的 T1=3 结果帧（协议未定义续帧格式，这是「连续到达且
 *   类型一致的多帧按序拼接」策略的实现；不同固件可能带 D5 回显或空洞，一律容忍）。
 * - 各帧 data 段按「D 域对齐」写入槽位流：起始帧写偏移 0（TC/D5/HDL），第 k 笔续帧写
 *   偏移 5+8(k-1)：cont1@5 回显 HDL（同值覆盖无害）并补齐 TG@9，cont2@13 补齐 LDL@13..16。
 *   两笔续帧后四指标齐备；凑不满则降级 partial:true。零值字节不覆盖已有数据。
 * - CRC 挤占 LDL 高字节正是文档歧义根源，槽位值允许被后续帧回显覆盖；真机抓包后收紧。
 */
/** 血脂 D 域偏移（17 字节 D1..D17 数据段内）：TC@0(D1..D4)、HDL@5(D6..D9)、TG@9(D10..D13)、LDL@13(D14..D17)。 */
const LIPID_FIELDS = [['tc', 0], ['hdl', 5], ['tg', 9], ['ldl', 13]]

function fastStateText (code) {
  const n = code & 0xff
  if (n === 1) return '空腹'
  if (n === 2) return '餐后'
  return ''
}

/** 解析 16 字节帧；Bit7 为应答错误位（设备错误应答 = 命令|0x80）。 */
function parseMfa1Frame (input) {
  const bytes = input instanceof Uint8Array ? input : new Uint8Array(input || [])
  if (bytes.length !== FRAME_SIZE && bytes.length !== RESULT_FRAME_BYTES && bytes.length !== RESULT_FRAME_LIPID_BYTES) throw new Error('MFA1_FRAME_LENGTH')
  if (bytes[bytes.length - 1] !== crc(bytes)) throw new Error('MFA1_FRAME_CHECKSUM')
  const raw = bytes[0] & 0xff
  const command = raw & 0x7f
  if (raw & 0x80) return { command, type: 'error', error: true }

  if (command === CMD_SET_TIME) return { command, type: 'timeSyncAck' }
  if (command === CMD_READ_TIME) {
    // 协议 §2：应答 AA BB CC DD EE FF 为年月日时分秒，格式与 0x01 同为 BCD。
    return {
      command, type: 'time',
      year: 2000 + fromBcd(bytes[1]), month: fromBcd(bytes[2]), day: fromBcd(bytes[3]),
      hour: fromBcd(bytes[4]), minute: fromBcd(bytes[5]), second: fromBcd(bytes[6])
    }
  }
  if (command === CMD_READ_BATTERY) {
    // 真机实证（2026-09-10 两台次抓包）：应答 byte1 为 BCD 电量 —— 0x83→83%、0x94→94%。
    // 直读字节会显示「131%/148%」这类 >100 的怪值；非 BCD 位（半字节 >9）时兜底直读原值。
    const raw = bytes[1] & 0xff
    const isBcd = ((raw >> 4) & 0x0f) <= 9 && (raw & 0x0f) <= 9
    const level = isBcd ? fromBcd(raw) : raw
    return { command, type: 'battery', level }
  }
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
    // 31 字节结果帧：D1..D17 完整落在字节 2..18，TC/HDL/TG/LDL 一次拿全（FLOAT 大端，
    // D 域偏移见 LIPID_FIELDS）。旧「16 字节起始帧+续帧拼接、CRC 挤占 LDL」是错误假设 ——
    // 那是拿 16 字节定长去套变长帧的产物，已随挂起聚合机制一并删除。
    // 某字段 4 字节全 0 视为缺失（parseLipid 跳过），缺哪项整批标 partial:true 由页面提示。
    const fastCode = bytes[6] & 0xff
    const data = bytes.slice(2, 2 + LIPID_DATA_BYTES)
    const { metrics, complete } = parseLipid(data, fastCode)
    return {
      command: CMD_TEST_RESULT, type: 'result',
      lipidKind: true, kind, fastState: fastCode, data,
      metric: metrics[0] || null, metrics, complete
    }
  }
  if (kind === RESULT_TYPE_BLOOD_PRESSURE) {
    // 血压 T1=4（20 字节帧）：D1=byte2（恒 0），D2=byte3 心率 bpm、D3=byte4 舒张压 mmHg、
    // D4=byte5 收缩压 mmHg。真机抓包 78 04 00 4E 3C 6C …：心率 78 / 舒张压 60 / 收缩压 108。
    // device-mfa1 页面与草稿提交按「简单数值 metric」消费（name/value/unit），
    // 故拆为 systolic/diastolic/heartRate 三个 metric 而非复合对象。
    const heartRate = bytes[3] & 0xff
    const diastolic = bytes[4] & 0xff
    const systolic = bytes[5] & 0xff
    const metrics = [
      { name: 'systolic', value: systolic, unit: 'mmHg' },
      { name: 'diastolic', value: diastolic, unit: 'mmHg' },
      { name: 'heartRate', value: heartRate, unit: 'bpm' }
    ]
    return { command: CMD_TEST_RESULT, type: 'result', metric: metrics[0], metrics }
  }
  return { command: CMD_TEST_RESULT, type: 'result', metric: null, unknownKind: kind }
}

/** 从拼接血脂流（LIPID_FIELDS 偏移，见常量注释）提取可完整解析的指标。 */
function parseLipid (data, fastCode) {
  const metrics = []
  for (const [name, offset] of LIPID_FIELDS) {
    if (data.length < offset + 4) continue // 槽位流固定长度，缺字节的字段跳过
    // 未写入的槽位保持 0x00；float32 全零不是合法测量值，视为缺失待补。
    let hole = true
    for (let i = 0; i < 4; i++) if (data[offset + i] !== 0) { hole = false; break }
    if (hole) continue
    try { metrics.push({ name, value: readFloat32BE(data, offset), unit: 'mmol/L' }) } catch (_) { /* 畸形 float 跳过 */ }
  }
  const complete = metrics.length === LIPID_FIELDS.length
  const state = fastStateText(fastCode)
  for (const item of metrics) {
    item.state = state
    item.fastState = fastCode
    if (!complete) item.partial = true
  }
  return { metrics, complete }
}

/**
 * BLE 通知切帧器（粘包/分包安全）。
 *
 * 帧长按命令结构判定（真机实证 2026-09-10，详见 RESULT_FRAME_BYTES 常量注释）：
 * - 0x78 结果帧：变长 —— T1=3 血脂 31 字节，其余（GLU/UA/血压）20 字节；
 *   MTU 分包时先滞留 buffer，凑满整帧再 CRC 验证出帧。
 * - 其余（0x01/0x13/0x22/0x41 等命令应答）：16 字节定长。
 * CRC 校验失败的帧按「丢一字节重新对齐」重同步（粘包错位/脏数据自愈），
 * 并打 [MFA1-BLE][DROP] 日志（真机定位帧格式用）。
 *
 * 历史：曾按 16 字节定长切帧 + 血脂「起始帧/续帧挂起聚合」——均是对变长结果帧的
 * 错误假设（真机上 20 字节结果被硬切 16+4 后 CRC 必错，整帧被静默丢弃，表现为
 * 「设备连上了但数据不返回」）。挂起聚合机制已随该假设一并删除，血脂为单帧直出。
 */
class FrameAssembler {
  constructor () {
    this.buffer = new Uint8Array(0)
  }
  push (input) {
    const incoming = input instanceof Uint8Array ? input : new Uint8Array(input || [])
    const combined = new Uint8Array(this.buffer.length + incoming.length)
    combined.set(this.buffer); combined.set(incoming, this.buffer.length)
    const output = []
    let offset = 0
    for (;;) {
      const remaining = combined.length - offset
      if (remaining < FRAME_SIZE) break // 最短帧 16 字节，不足则等后续通知
      // 按帧头判定本帧长度；0x78 结果帧需要比 16 更长时先滞留等凑满
      let frameLength = FRAME_SIZE
      if (combined[offset] === CMD_TEST_RESULT) {
        const t1 = combined[offset + 1] & 0xff
        frameLength = t1 === RESULT_TYPE_LIPID ? RESULT_FRAME_LIPID_BYTES : RESULT_FRAME_BYTES
        if (remaining < frameLength) break
      }
      const candidate = combined.slice(offset, offset + frameLength)
      let parsed = null
      try { parsed = parseMfa1Frame(candidate) } catch (error) {
        // 调试（真机定位帧格式用）：坏帧此前被静默丢弃，连「收到但校验失败」都不可见。
        try { console.log('[MFA1-BLE][DROP]', hexOf(candidate), error && error.message) } catch (_) {}
      }
      if (parsed) {
        output.push(parsed)
        offset += frameLength
      } else {
        offset += 1 // 字节级重同步：丢一字节再试，直到对齐下一个真实帧头
      }
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

/** 尽力释放某设备的连接句柄（无句柄/已断开时失败属预期，静默吞掉）。 */
async function closeQuietly (deviceId) {
  if (!deviceId || typeof wx?.closeBLEConnection !== 'function') return
  await new Promise(resolve => wx.closeBLEConnection({ deviceId, complete: resolve }))
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
    // 串行化：设备掉线触发的自动重连可能正在进行，此时手动 connect 若与之并发，
    // 两次 createBLEConnection 会被微信以 10012/already-connect 拒绝 —— 表现为「怎么点都连不上」。
    // 先等在途重连收敛（成功或 3 次耗尽，至多数秒），再走全新连接。
    if (this.reconnectPromise) { try { await this.reconnectPromise } catch (_) {} }
    this.manualClose = false; this.reconnectAttempts = 0; this.lastDevice = typeof device === 'string' ? { deviceId } : device
    return this.connectInternal(deviceId)
  }
  async connectInternal (deviceId) {
    await this.stopScan(); this.state('connecting')
    try {
      // 先释放同设备的残留句柄：异常断线后微信/系统侧常留半开 GATT 连接，
      // 不清理则 createBLEConnection 会持续 10012/already-connect 失败 —— 「掉了就连不上」的直接原因。
      await closeQuietly(deviceId)
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
    } catch (error) {
      // 连接半途失败：释放句柄并清空活动连接字段，状态机不残留半开连接（lastDevice 保留供重试）
      await closeQuietly(deviceId)
      if (this.deviceId === deviceId) { this.deviceId = ''; this.serviceId = ''; this.writeId = ''; this.notifyId = '' }
      throw error
    }
  }
  installListeners () {
    if (!this.valueListener) {
      this.valueListener = event => {
        if (event.deviceId !== this.deviceId || normalizeUuid(event.characteristicId) !== normalizeUuid(this.notifyId)) return
        // 与 scaleBle 对齐：为成帧结果盖 receivedAt（设备通知到达时刻），页面据此执行
        // 「只收晚于新会话启动时间的数据」窗口过滤（设计 §8 第 6 步）。不改解析语义。
        const receivedAt = Date.now()
        // 调试（真机定位帧格式用）：原始通知 hex。定位完成后可移除或降级。
        try {
          console.log('[MFA1-BLE][RX]', hexOf(new Uint8Array(event.value || [])))
        } catch (_) {}
        this.assembler.push(new Uint8Array(event.value || [])).forEach(result => {
          // 调试（真机定位帧格式用）：成帧后的解析结论（命令/类型/指标），区分「没收到帧」与「收到了但解析不出」。
          try {
            console.log('[MFA1-BLE][PARSE]', JSON.stringify({
              command: result.command,
              type: result.type,
              error: result.error === true,
              metrics: (result.metrics || [result.metric]).filter(Boolean).map(item => item.name + '=' + item.value + (item.partial ? '(partial)' : ''))
            }))
          } catch (_) {}
          try { this.onResult(Object.assign({}, result, { receivedAt })) } catch (_) {}
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
    // 调试（真机定位帧格式用）：下行帧 hex。定位完成后可移除或降级。
    try {
      console.log('[MFA1-BLE][TX]', hexOf(data))
    } catch (_) {}
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
        if (this.manualClose) break
        try { await this.connectInternal(this.lastDevice.deviceId); this.reconnectPromise = null; return } catch (_) {}
      }
      this.reconnectPromise = null
      // 重连耗尽：清空活动连接字段（保留 lastDevice 供手动重连），不留半开状态
      this.deviceId = ''; this.serviceId = ''; this.writeId = ''; this.notifyId = ''
      this.state('error', 'MFA-1 断线，自动重连失败，请重新连接')
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
  SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, FRAME_SIZE, RESULT_FRAME_BYTES, RESULT_FRAME_LIPID_BYTES,
  CMD_SET_TIME, CMD_READ_BATTERY, CMD_READ_MAC, CMD_READ_TIME, CMD_TEST_RESULT,
  FrameAssembler, Mfa1Ble, buildFrame, buildSetTimeFrame, buildReadTimeFrame,
  buildReadBatteryFrame, buildReadMacFrame, parseMfa1Frame, isMfa1Device, readFloat32BE,
  parseLipid, LIPID_FIELDS, LIPID_DATA_BYTES,
  RESULT_TYPE_GLUCOSE, RESULT_TYPE_URIC_ACID, RESULT_TYPE_LIPID, RESULT_TYPE_BLOOD_PRESSURE
}