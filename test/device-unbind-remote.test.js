// 解除绑定：先服务端、后本地。服务端释放失败必须暴露且不清本地绑定（修复静默失败）。
const assert = require('assert')
const path = require('path')

const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const apiPath = path.resolve(__dirname, '../miniprogram/utils/api.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

function completeContext () {
  return {
    cdmsBaseUrl: 'https://cdms',
    accessToken: 'access-a',
    activeRole: 'PATIENT',
    patientRef: 'patient-a',
    iotBaseUrl: 'https://iot',
    wearableToken: 'token-a',
    wearableSessionId: 'session-a',
    wearableDeviceRef: 'device-a'
  }
}

function makeEnv (globalData, requestHandler) {
  const values = new Map()
  const requests = []
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete(),
    request: options => {
      requests.push(options)
      if (requestHandler) requestHandler(options)
      else options.success({ statusCode: 200, data: { code: 200, released: 1 } })
    }
  }
  ;[storagePath, apiPath, bridgePath, bleManagerPath].forEach(file => { delete require.cache[file] })
  const storage = require(storagePath)
  const bridge = require(bridgePath)
  const bleManager = require(bleManagerPath)
  return { values, requests, storage, bridge, bleManager }
}

function seedBinding (storage, bleManager) {
  const boundDevice = { deviceId: 'device-a', name: 'SY01' }
  storage.saveBoundDevice(boundDevice)
  bleManager.state = Object.assign({}, bleManager.state, { boundDevice })
  return boundDevice
}

async function run () {
  // a) 服务端释放成功：真实走 releasePatientWearableSession（DELETE），本地绑定被清。
  {
    const globalData = completeContext()
    const { storage, bridge, bleManager, requests } = makeEnv(globalData)
    const boundDevice = seedBinding(storage, bleManager)

    const released = await bridge.releaseWearableSession('device-a')
    assert.strictEqual(requests.length, 1, 'bridge 必须发出服务端释放请求')
    assert.strictEqual(requests[0].method, 'DELETE')
    assert.ok(requests[0].url.includes('/api/v1/miniapp/iot/wearable-session?deviceRef=device-a'),
      '释放请求必须指向患者设备会话端点')
    assert.strictEqual(requests[0].header.Authorization, 'Bearer access-a')
    assert.strictEqual(released && released.released, 1, 'bridge 必须返回后端释放结果')

    // unbind 默认路径：同样先服务端、成功后清本地绑定。
    storage.saveBoundDevice(boundDevice)
    bleManager.state = Object.assign({}, bleManager.state, { boundDevice })
    await bleManager.unbind('device-a')
    assert.strictEqual(requests.length, 2, 'unbind 默认路径必须再次调用服务端释放')
    assert.strictEqual(storage.getBoundDevice(), null, '服务端释放成功后必须清除本地绑定')
    assert.strictEqual(bleManager.state.boundDevice, null, '服务端释放成功后必须清空内存绑定')
  }

  // b) 服务端释放失败：不清本地绑定、不改 boundDevice，错误向上抛出。
  {
    const globalData = completeContext()
    const { storage, bleManager, requests } = makeEnv(globalData, options => {
      options.success({ statusCode: 500, data: { message: '服务异常，请稍后重试' } })
    })
    const boundDevice = seedBinding(storage, bleManager)

    await assert.rejects(() => bleManager.unbind(), /服务异常/, '服务端释放失败必须抛给调用方')
    assert.strictEqual(requests.length, 1, '默认路径必须先尝试服务端释放')
    assert.deepStrictEqual(storage.getBoundDevice(), boundDevice, '服务端释放失败时不得清除本地绑定')
    assert.strictEqual(bleManager.state.boundDevice, boundDevice, '服务端释放失败时不得改 boundDevice')
  }

  // c) localOnly: true：完全跳过服务端调用（仅供页面绑定失败回滚使用）。
  {
    const globalData = completeContext()
    const { storage, bleManager, requests } = makeEnv(globalData)
    const boundDevice = seedBinding(storage, bleManager)

    await bleManager.unbind({ localOnly: true })
    assert.strictEqual(requests.length, 0, 'localOnly 不得调用服务端释放接口')
    assert.strictEqual(storage.getBoundDevice(), null, 'localOnly 仍应清除本地绑定')
    assert.strictEqual(bleManager.state.boundDevice, null, 'localOnly 仍应清空内存绑定')
    assert.strictEqual(boundDevice.deviceId, 'device-a')
  }

  // d) 上下文不完整（缺 accessToken）：抛错而不是静默返回，本地绑定保持不变。
  {
    const globalData = completeContext()
    delete globalData.accessToken
    const { storage, bridge, bleManager, requests } = makeEnv(globalData)
    const boundDevice = seedBinding(storage, bleManager)

    await assert.rejects(() => bridge.releaseWearableSession('device-a'),
      /患者登录状态不完整/, 'bridge 在上下文不完整时必须拒绝而不是静默返回')
    await assert.rejects(() => bleManager.unbind(),
      /患者登录状态不完整/, 'unbind 必须把上下文不完整的错误抛给页面')
    assert.strictEqual(requests.length, 0, '上下文不完整时不得发出服务端请求')
    assert.deepStrictEqual(storage.getBoundDevice(), boundDevice, '上下文不完整时不得清除本地绑定')
    assert.strictEqual(bleManager.state.boundDevice, boundDevice, '上下文不完整时不得改 boundDevice')
  }

  // d) 上下文不完整（缺 patientRef）：同样必须抛错，不得清本地绑定。
  {
    const globalData = completeContext()
    delete globalData.patientRef
    const { bleManager, requests } = makeEnv(globalData)
    const boundDevice = { deviceId: 'device-a', name: 'SY01' }
    bleManager.state = Object.assign({}, bleManager.state, { boundDevice })

    await assert.rejects(() => bleManager.unbind(), /患者登录状态不完整/,
      '缺少 patientRef 时必须抛错而不是静默返回')
    assert.strictEqual(requests.length, 0, '缺少 patientRef 时不得发出服务端请求')
    assert.strictEqual(bleManager.state.boundDevice, boundDevice, '缺少 patientRef 时不得改 boundDevice')
  }

  console.log('Device unbind remote release tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
