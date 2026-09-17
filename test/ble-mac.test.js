const assert = require('assert')
const path = require('path')

const bleMacPath = path.resolve(__dirname, '../miniprogram/utils/ble-mac.js')
const bleMac = require(bleMacPath)

async function run () {
  // ---- normalizeMac / reverseMac ----
  assert.strictEqual(bleMac.normalizeMac('34:20:00:02:06:ce'), '34:20:00:02:06:CE')
  assert.strictEqual(bleMac.normalizeMac('34-20-00-02-06-CE'), '34:20:00:02:06:CE')
  assert.strictEqual(bleMac.normalizeMac('13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69'), '', 'iOS UUID 不是 MAC')
  assert.strictEqual(bleMac.normalizeMac(''), '')
  assert.strictEqual(bleMac.reverseMac('34:20:00:02:06:CE'), 'CE:06:02:00:20:34')
  assert.strictEqual(bleMac.reverseMac('not-a-mac'), '')

  // ---- macQuality：单播且全球唯一=2 / 单播本地管理=1 / 组播=0 ----
  assert.strictEqual(bleMac.macQuality('34:20:00:01:7D:08'), 2, '34 首字节为单播+全球唯一')
  assert.strictEqual(bleMac.macQuality('CE:06:02:00:20:34'), 1, 'CE 是单播但本地管理')
  assert.strictEqual(bleMac.macQuality('25:30:01:00:20:34'), 0, '25 是组播地址，不可能是设备地址')
  assert.strictEqual(bleMac.macQuality('not-a-mac'), -1)

  // ---- correctMacByteOrder：真实生产用例 ----
  // iOS 实测反序值（17:14 绑定落库值），反转后才是合法单播+全球唯一地址
  assert.strictEqual(bleMac.correctMacByteOrder('25:30:01:00:20:34'), '34:20:00:01:30:25')
  // 广播解析出的本地管理地址，反转后才是全球唯一地址
  assert.strictEqual(bleMac.correctMacByteOrder('CE:06:02:00:20:34'), '34:20:00:02:06:CE')
  // 本来就正确的地址不得被反转（Android 正常路径）
  assert.strictEqual(bleMac.correctMacByteOrder('34:20:00:01:7D:08'), '34:20:00:01:7D:08')
  assert.strictEqual(bleMac.correctMacByteOrder('34:20:00:02:06:CE'), '34:20:00:02:06:CE')
  // 反转后质量不更高时保持原样（未知/本地管理设备不误伤）
  assert.strictEqual(bleMac.correctMacByteOrder('AA:BB:CC:DD:EE:FF'), 'AA:BB:CC:DD:EE:FF')
  assert.strictEqual(bleMac.correctMacByteOrder(''), '')

  // ---- resolveScanMacAddress ----
  // Android：deviceId 即真实 MAC，权威
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '34:20:00:02:06:ce', macAddress: 'CE:06:02:00:20:34'
  }), '34:20:00:02:06:CE', 'Android deviceId 应优先')

  // iOS 首扫：deviceId 是 UUID，用校正后的广播值
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '25:30:01:00:20:34',
    cachedAddress: ''
  }), '34:20:00:01:30:25', 'iOS 首扫应用校正后的广播 MAC')

  // iOS：修复前写入的缓存是反序值，不能覆盖本次扫描结果（本次扫描优先）
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '25:30:01:00:20:34',
    cachedAddress: '25:30:01:00:20:34'
  }), '34:20:00:01:30:25', '陈旧反序缓存不得覆盖本次扫描')

  // 广播缺失时才回退缓存，且缓存同样要校正
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '',
    cachedAddress: 'CE:06:02:00:20:34'
  }), '34:20:00:02:06:CE', '无广播时回退缓存并校正')

  // 广播缺失且无缓存：返回空（调用方必须拒绝绑定）
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '',
    cachedAddress: ''
  }), '', '解析不出 MAC 时返回空')

  console.log('BLE MAC resolution tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
