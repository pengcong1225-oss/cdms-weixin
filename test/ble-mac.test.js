const assert = require('assert')
const path = require('path')

const bleMacPath = path.resolve(__dirname, '../miniprogram/utils/ble-mac.js')
const bleMac = require(bleMacPath)

async function run () {
  // ---- normalizeMac ----
  assert.strictEqual(bleMac.normalizeMac('34:20:00:02:06:ce'), '34:20:00:02:06:CE')
  assert.strictEqual(bleMac.normalizeMac('34-20-00-02-06-CE'), '34:20:00:02:06:CE')
  assert.strictEqual(bleMac.normalizeMac('13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69'), '', 'iOS UUID 不是 MAC')
  assert.strictEqual(bleMac.normalizeMac(''), '')

  // ---- reverseMac ----
  assert.strictEqual(bleMac.reverseMac('34:20:00:02:06:CE'), 'CE:06:02:00:20:34')
  assert.strictEqual(bleMac.reverseMac('not-a-mac'), '')

  // ---- resolveScanMacAddress ----
  // Android：deviceId 即真实 MAC，权威；即使广播解析（反序）存在也以 deviceId 为准
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '34:20:00:02:06:ce',
    macAddress: 'CE:06:02:00:20:34'
  }), '34:20:00:02:06:CE', 'Android deviceId 应优先')

  // iOS 首次扫描：广播反序 MAC 反转后命中厂商 OUI -> 采用反转结果
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: 'CE:06:02:00:20:34',
    cachedAddress: ''
  }), '34:20:00:02:06:CE', 'iOS 首扫应反转小端广播 MAC')

  // iOS 有缓存（此前 readBleAddress 上报过）：缓存优先
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: 'CE:06:02:00:20:34',
    cachedAddress: '34:20:00:02:06:CE'
  }), '34:20:00:02:06:CE', '缓存的设备上报 MAC 应优先')

  // 非厂商 OUI：不盲目反转，保留原解析，避免误伤其他设备
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: 'AA:BB:CC:DD:EE:FF',
    cachedAddress: ''
  }), 'AA:BB:CC:DD:EE:FF', '非厂商 OUI 不反转')

  // 广播缺失且无缓存：返回空
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '',
    cachedAddress: ''
  }), '')

  console.log('BLE MAC resolution tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
