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

  // ---- payloadMac：设备下发字节按协议是小端序，无条件反转（真实生产值） ----
  // 09-17 10:14 绑定落库值
  assert.strictEqual(bleMac.payloadMac('25:30:01:00:20:34'), '34:20:00:01:30:25')
  // 09-18 10:36 绑定落库值（上一版“质量比较”在此打平 -> 未反转，故失效）
  assert.strictEqual(bleMac.payloadMac('60:A6:00:00:20:34'), '34:20:00:00:A6:60')
  // 09-18 11:05 绑定落库值（同上，首字节 0x98 也是“单播+全球唯一”，打平）
  assert.strictEqual(bleMac.payloadMac('98:3D:01:00:20:34'), '34:20:00:01:3D:98')
  // 手环广播值
  assert.strictEqual(bleMac.payloadMac('CE:06:02:00:20:34'), '34:20:00:02:06:CE')
  assert.strictEqual(bleMac.payloadMac(''), '')
  assert.strictEqual(bleMac.payloadMac('not-a-mac'), '')

  // ---- resolveScanMacAddress ----
  // Android：deviceId 即操作系统给出的真实 MAC，原样优先，不做反转
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '34:20:00:02:06:ce', macAddress: 'CE:06:02:00:20:34'
  }), '34:20:00:02:06:CE', 'Android deviceId 应原样优先')

  // iOS 首扫：deviceId 是 UUID，用反转后的广播值
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '60:A6:00:00:20:34',
    cachedAddress: ''
  }), '34:20:00:00:A6:60', 'iOS 首扫应反转广播 MAC')

  // iOS：缓存不得覆盖本次扫描结果（广播仍是当次权威来源）
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '98:3D:01:00:20:34',
    cachedAddress: '60:A6:00:00:20:34'
  }), '34:20:00:01:3D:98', '缓存不得覆盖本次扫描')

  // 广播缺失时才回退缓存；缓存存的是已解析的真实 MAC，必须原样返回。
  // 回归锁：a44c77e 曾对缓存值再反转一次，导致无广播时绑定/展示反序 MAC。
  assert.strictEqual(bleMac.resolveScanMacAddress({
    deviceId: '13214DCA-7F7C-4CE1-6B90-7F0C1F1C5F69',
    macAddress: '',
    cachedAddress: '34:20:00:02:06:CE'
  }), '34:20:00:02:06:CE', '无广播时回退缓存且不得二次反转')

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
