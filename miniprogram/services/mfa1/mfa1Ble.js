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
const LIPID_FIELDS = [['tc', 0], ['hdl', 5], ['tg', 9], ['ldl', 13]]
/** 凑满四指标所需的最小拼接流长度（LDL 尾字节流位置 +1）。 */
const LIPID_DATA_BYTES = 17
/** 续帧槽位：第 k 笔落在流偏移 SLOT_FIRST + SLOT_STEP*(k-1)。 */
const LIPID_SLOT_FIRST = 5
const LIPID_SLOT_STEP = 8
/** 达到该续帧数即认为传输结束（LDL@13..16 已在第二笔内）。 */
const LIPID_MAX_CHUNKS = 2
/** 血脂续帧等待超时（毫秒）：超时后以已收到的前缀降级出结果（partial），防止挂起。 */
const LIPID_ASSEMBLY_TIMEOUT_MS = 5000

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
    // 协议原文血脂字段 D1..D4=TC、D6..D9=HDL、D10..D13=TG、D14..D17=LDL（FLOAT 大端），
    // D14..D17 落在字节 14..17，超出 16 字节定长帧（字节 15=CRC）——文档歧义。
    // 假设（详见 FrameAssembler 类注释与 LIPID_FIELDS 常量注释）：设备以 0x78 T1=3
    // 起始帧 + 若干续帧传输，各帧 data 段按「D 域对齐」写入槽位流；起始帧承载 TC/D5/HDL，
    // 续帧补齐 TG、LDL。FrameAssembler 挂起凑帧并广播 { type:'lipidPending' } 供 UI 提示；
    // 无法凑满（超时/断线/新测量混入）时降级为仅上报完整解析出的指标并置 partial:true。
    // 兼容一期行为：单帧同时给出 name:'tc' 的降级 metric（旧直调 parseMfa1Frame 的
    // 消费者不变）；FrameAssembler 走多帧聚合路径时忽略该降级值、改用拼接流。
    const fastCode = bytes[6] & 0xff
    const data = bytes.slice(2, FRAME_SIZE - 1) // data 段 = 字节 2..14（13 字节）
    let degraded = null
    try {
      degraded = { name: 'tc', value: readFloat32BE(bytes, 2), unit: 'mmol/L', state: fastStateText(fastCode), fastState: fastCode }
    } catch (_) { /* TC 解析失败则无降级值 */ }
    // parseMfa1Frame 是纯函数（无状态）：是否续帧由 FrameAssembler 依挂起态判定，
    // 这里统一输出原始材料（data 全段 + fastState），聚合语义见 FrameAssembler.consume。
    return {
      command: CMD_TEST_RESULT, type: 'result',
      lipidKind: true, kind, fastState: fastCode, data,
      metric: degraded, metrics: degraded ? [degraded] : []
    }
  }
  if (kind === RESULT_TYPE_BLOOD_PRESSURE) {
    // 血压 T1=4：D2(byte2)=心率 bpm、D3(byte3)=舒张压 mmHg、D4(byte4)=收缩压 mmHg。
    // device-mfa1 页面与草稿提交按「简单数值 metric」消费（name/value/unit），
    // 故拆为 systolic/diastolic/heartRate 三个 metric 而非复合对象。
    const heartRate = bytes[2] & 0xff
    const diastolic = bytes[3] & 0xff
    const systolic = bytes[4] & 0xff
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
 * BLE 通知可能粘包/分包：协议 16 字节定长，直接按 16 字节切帧，坏帧丢弃。
 *
 * 血脂多帧聚合（二期新增）：
 * - 起始帧 = 0x78 且 T1(byte1)=3；只取其前缀 D1..D5（TC float + 餐前餐后标记）。
 * - 续帧格式协议未明确 —— 这是记录在案的歧义与假设：任何紧随其后、CRC 校验通过且
 *   data 段非空的 0x78 结果帧都按「纯增量」当作续帧，data 段依序拼接，只取到刚好
 *   凑满 16 字节浮点流；凑满即出完整结果，凑不满（超时/断线/新一笔起始帧）则以已收
 *   前缀降级出结果并置 partial:true。
 * - 超时（LIPID_ASSEMBLY_TIMEOUT_MS）或连接重建（新建 assembler）同样触发降级输出。
 * - 拼接流按 LIPID_FIELDS 偏移取 float32 大端（TC@0/HDL@5/TG@9/LDL@13，流偏移 4=D5），
 *   能完整解析几个就上报几个。
 */
class FrameAssembler {
  constructor ({ now = () => Date.now(), setTimeoutFn = null, clearTimeoutFn = null } = {}) {
    this.buffer = new Uint8Array(0)
    this.lipid = null // { kind:3, fastCode, data:Uint8Array, timer }
    this.now = now
    this.setTimeoutFn = setTimeoutFn || (typeof setTimeout === 'function' ? setTimeout : null)
    this.clearTimeoutFn = clearTimeoutFn || (typeof clearTimeout === 'function' ? clearTimeout : null)
  }
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
      let parsed = null
      try { parsed = parseMfa1Frame(candidate) } catch (_) { /* 丢弃坏帧，等待下一帧 */ }
      if (parsed) output.push(...this.consume(parsed))
    }
    this.buffer = offset < combined.length ? combined.slice(offset) : new Uint8Array(0)
    if (this.buffer.length > FRAME_SIZE * 8) this.buffer = new Uint8Array(0)
    return output
  }
  /** 血脂挂起帧的超时降级：由 Mfa1Ble 在断线/销毁时调用。 */
  flush () {
    if (!this.lipid) return []
    return this.finishLipid(false)
  }
  consume (result) {
    if (result.command !== CMD_TEST_RESULT) return [result]
    // 挂起中任何 T1=3 结果帧都按序当作本笔续帧（协议未定义续帧格式；连续到达 +
    // 类型一致即聚合 —— 稳妥策略，回显/空洞由 D 域对齐吸收）。非血脂帧或第二笔同型
    // 但已被上一轮凑满出结果的帧走下方新起始分支。
    if (result.lipidKind && this.lipid) return this.appendLipid(result)
    if (result.lipidKind) {
      // 新的起始帧到来：上一笔血脂仍未凑满 → 先降级输出旧前缀，再开新挂起。
      const out = this.lipid ? this.finishLipid(false) : []
      this.startLipid(result)
      out.push({ command: CMD_TEST_RESULT, type: 'lipidPending', count: this.lipid.data.length })
      return out
    }
    if (this.lipid) {
      // 挂起中收到非血脂结果帧（GLU/UA/BP）：无法确定它是「混入的独立测量」还是新
      // 一轮开始 —— 稳妥策略：先以已收前缀降级收尾血脂（partial 语义由 parseLipid 决定），
      // 再原样放行该帧。错误应答等非结果帧透传，等待超时降级。
      if (result.type === 'result' && result.metric) {
        const out = this.finishLipid(false)
        out.push(result)
        return out
      }
      return [result]
    }
    // 无挂起时收到的其他 0x78 结果帧（含 unknownKind 等）：直接透传。
    return [result]
  }
  startLipid (startResult) {
    // 槽位流：起始帧写偏移 0（其 data 段原样铺入，含 TC/D5/HDL…），第 k 笔续帧写偏移
    // 5+13(k-1) —— 每帧 data 段的偏移 4 都是 D5 槽（帧 byte6 ↔ D5），故续帧整段覆盖时
    // HDL 恰落 @5、TG @9、LDL @13。未触及槽位保持 0，parseLipid 把全零 float 视为缺失。
    const stream = new Uint8Array(LIPID_DATA_BYTES + FRAME_SIZE)
    // 起始帧只取前缀 D1..D9（TC@0、D5@4、HDL@5）；TG/LDL 由续帧按槽位覆盖。
    stream.set(startResult.data.subarray(0, Math.min(startResult.data.length, 9)))
    this.lipid = { fastCode: startResult.fastState & 0xff, data: stream, chunks: 0 }
    if (this.setTimeoutFn) {
      this.lipid.timer = this.setTimeoutFn(() => {
        if (!this.lipid) return
        const drained = this.flush()
        if (this.onDrain) { try { this.onDrain(drained) } catch (_) {} }
      }, LIPID_ASSEMBLY_TIMEOUT_MS)
      if (this.lipid.timer && typeof this.lipid.timer.unref === 'function') this.lipid.timer.unref()
    }
  }
  appendLipid (result) {
    const current = this.lipid
    if (!current) return []
    // 续帧 data 段 = 其字节 2..14（整段追加）；歧义假设见类注释。
    const incoming = result.data instanceof Uint8Array && result.data.length
      ? result.data
      : (result.bytes && result.bytes.slice ? result.bytes.slice(2, FRAME_SIZE - 1) : new Uint8Array(0))
    // D 域对齐槽位写入：cont1→@5、cont2→@13（见类注释）；0 字节视为空洞不覆盖。
    // 防御：异常设备狂发续帧 → 超过 4 笔仍不齐就降级收尾，释放挂起。
    if (current.chunks >= 4) return this.finishLipid(false)
    const slot = LIPID_SLOT_FIRST + LIPID_SLOT_STEP * current.chunks
    current.chunks += 1
    incoming.forEach((value, index) => { if (value !== 0 && slot + index < current.data.length) current.data[slot + index] = value })
    const { metrics } = parseLipid(current.data, current.fastCode)
    if (metrics.length === LIPID_FIELDS.length) return this.finishLipid(true)
    return [{ command: CMD_TEST_RESULT, type: 'lipidPending', count: current.chunks }]
  }
  finishLipid (complete) {
    const current = this.lipid
    this.lipid = null
    if (!current) return []
    if (current.timer && this.clearTimeoutFn) this.clearTimeoutFn(current.timer)
    const { metrics } = parseLipid(current.data, current.fastCode)
    if (!metrics.length) return []
    return [{ command: CMD_TEST_RESULT, type: 'result', metric: metrics[0], metrics, complete: !!complete }]
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
    // 超时降级的血脂帧经此回调补发给 onResult（push 同步路径与定时器路径共用）。
    this.assembler.onDrain = drained => drained.forEach(item => { try { this.onResult(Object.assign({}, item, { receivedAt: Date.now() })) } catch (_) {} })
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
    if (this.assembler) this.assembler.flush().forEach(item => { try { this.onResult(item) } catch (_) {} })
    this.deviceId = deviceId; this.serviceId = service.uuid; this.writeId = write.uuid; this.notifyId = notify.uuid; this.assembler = new FrameAssembler()
    this.assembler.onDrain = drained => drained.forEach(item => { try { this.onResult(Object.assign({}, item, { receivedAt: Date.now() })) } catch (_) {} })
    this.installListeners()
    await callWx('notifyBLECharacteristicValueChange', { state: true, deviceId, serviceId: this.serviceId, characteristicId: this.notifyId })
    this.state('connected'); return this.lastDevice
  }
  installListeners () {
    if (!this.valueListener) {
      this.valueListener = event => {
        if (event.deviceId !== this.deviceId || normalizeUuid(event.characteristicId) !== normalizeUuid(this.notifyId)) return
        // 与 scaleBle 对齐：为成帧结果盖 receivedAt（设备通知到达时刻），页面据此执行
        // 「只收晚于新会话启动时间的数据」窗口过滤（设计 §8 第 6 步）。不改解析语义。
        const receivedAt = Date.now()
        this.assembler.push(new Uint8Array(event.value || [])).forEach(result => {
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
    if (this.assembler) this.assembler.flush().forEach(item => { try { this.onResult(item) } catch (_) {} })
    if (this.deviceId && typeof wx.closeBLEConnection === 'function') await new Promise(resolve => wx.closeBLEConnection({ deviceId: this.deviceId, complete: resolve }))
    this.deviceId = ''; this.serviceId = ''; this.writeId = ''; this.notifyId = ''; this.state('disconnected')
  }
  destroy () { this.manualClose = true; if (this.assembler) this.assembler.flush().forEach(item => { try { this.onResult(item) } catch (_) {} }); this.stopScanListeners(); if (this.valueListener && wx.offBLECharacteristicValueChange) wx.offBLECharacteristicValueChange(this.valueListener); if (this.connectionListener && wx.offBLEConnectionStateChange) wx.offBLEConnectionStateChange(this.connectionListener); this.valueListener = null; this.connectionListener = null }
}

module.exports = {
  SERVICE_UUID, WRITE_UUID, NOTIFY_UUID, FRAME_SIZE,
  CMD_SET_TIME, CMD_READ_BATTERY, CMD_READ_MAC, CMD_READ_TIME, CMD_TEST_RESULT,
  FrameAssembler, Mfa1Ble, buildFrame, buildSetTimeFrame, buildReadTimeFrame,
  buildReadBatteryFrame, buildReadMacFrame, parseMfa1Frame, isMfa1Device, readFloat32BE,
  parseLipid, LIPID_FIELDS, LIPID_DATA_BYTES, LIPID_ASSEMBLY_TIMEOUT_MS,
  RESULT_TYPE_GLUCOSE, RESULT_TYPE_URIC_ACID, RESULT_TYPE_LIPID, RESULT_TYPE_BLOOD_PRESSURE
}
