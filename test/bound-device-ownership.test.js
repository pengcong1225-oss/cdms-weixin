// Task A（缺口A）绑定归属隔离：ownerPatientRef 记录、异患者不复用、不删除绑定历史
const assert = require('assert')
const path = require('path')

const storagePath = path.resolve(__dirname, '../miniprogram/utils/storage.js')
const bridgePath = path.resolve(__dirname, '../miniprogram/utils/cdms-bridge.js')
const bleManagerPath = path.resolve(__dirname, '../miniprogram/services/bleManager.js')

function makeEnv (globalData) {
  const values = new Map()
  global.getApp = () => ({ globalData })
  global.wx = {
    getStorageSync: key => values.get(key),
    setStorageSync: (key, value) => values.set(key, value),
    removeStorageSync: key => values.delete(key),
    closeBLEConnection: ({ complete }) => complete && complete()
  }
  delete require.cache[storagePath]
  delete require.cache[bridgePath]
  delete require.cache[bleManagerPath]
  const storage = require(storagePath)
  const bleManager = require(bleManagerPath)
  return { values, storage, bleManager }
}

async function run () {
  // ---- storage.saveBoundDevice：自动补 ownerPatientRef（以当前登录患者为准）----
  {
    const { storage } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-A' })
    storage.saveBoundDevice({ deviceId: 'ring-1', name: 'SY01' })
    const saved = storage.getBoundDevice()
    assert.strictEqual(saved.ownerPatientRef, 'patient-A', '缺少归属记录时应自动补上当前 patientRef')
  }

  // ---- storage.saveBoundDevice：已有 ownerPatientRef 不被覆盖 ----
  {
    const { storage } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-B' })
    storage.saveBoundDevice({ deviceId: 'ring-1', ownerPatientRef: 'patient-A' })
    assert.strictEqual(storage.getBoundDevice().ownerPatientRef, 'patient-A', '已有归属记录不应被新登录患者覆盖')
  }

  // ---- storage.saveBoundDevice：非患者上下文（patientRef 为空）不写归属，也不清掉已有归属 ----
  {
    const { storage } = makeEnv({ activeRole: 'DOCTOR', patientRef: '' })
    storage.saveBoundDevice({ deviceId: 'ring-1' })
    assert.strictEqual(storage.getBoundDevice().ownerPatientRef, undefined, 'patientRef 为空时不写归属')
    storage.saveBoundDevice({ deviceId: 'ring-1', ownerPatientRef: 'patient-A' })
    assert.strictEqual(storage.getBoundDevice().ownerPatientRef, 'patient-A', '空 patientRef 不应清零已有归属')
  }

  // ---- storage.isBoundDeviceOwnedByPatient 纯判定 ----
  {
    const { storage } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-A' })
    assert.strictEqual(storage.isBoundDeviceOwnedByPatient({ ownerPatientRef: 'patient-A' }, 'patient-A'), true, '归属一致')
    assert.strictEqual(storage.isBoundDeviceOwnedByPatient({ ownerPatientRef: 'patient-A' }, 'patient-B'), false, '归属不一致')
    assert.strictEqual(storage.isBoundDeviceOwnedByPatient({ deviceId: 'ring-1' }, 'patient-B'), true, '旧数据无归属记录视为本人设备')
    assert.strictEqual(storage.isBoundDeviceOwnedByPatient(null, 'patient-B'), true, '无绑定视为本人（无异议）')
  }

  // ---- bleManager.isBoundDeviceForeignFor：只有 PATIENT + patientRef 才做隔离 ----
  {
    const { storage, bleManager } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-B' })
    storage.saveBoundDevice({ deviceId: 'ring-1', ownerPatientRef: 'patient-A' })
    assert.strictEqual(bleManager.isBoundDeviceForeign(), true, 'B 登录时 A 的绑定应判为异设备')
  }
  {
    const { storage, bleManager } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-A' })
    storage.saveBoundDevice({ deviceId: 'ring-1', ownerPatientRef: 'patient-A' })
    assert.strictEqual(bleManager.isBoundDeviceForeign(), false, '本人绑定不应判为异设备')
  }
  {
    const { storage, bleManager } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-B' })
    storage.saveBoundDevice({ deviceId: 'ring-1' })
    assert.strictEqual(bleManager.isBoundDeviceForeign(), false, '旧数据无归属不判异设备')
  }
  {
    const { storage, bleManager } = makeEnv({ activeRole: 'DOCTOR', patientRef: '' })
    storage.saveBoundDevice({ deviceId: 'ring-1', ownerPatientRef: 'patient-A' })
    assert.strictEqual(bleManager.isBoundDeviceForeign(), false, '医生端不适用归属隔离')
  }
  {
    const { storage, bleManager } = makeEnv({ activeRole: 'PATIENT', patientRef: '' })
    storage.saveBoundDevice({ deviceId: 'ring-1', ownerPatientRef: 'patient-A' })
    assert.strictEqual(bleManager.isBoundDeviceForeign(), false, '未登录（patientRef 空）保持现状')
  }

  // ---- refreshBoundDeviceOwnership：异患者隐藏（不删绑定），切回本人恢复 ----
  {
    const { storage, bleManager } = makeEnv({ activeRole: 'PATIENT', patientRef: 'patient-B' })
    const boundDevice = { deviceId: 'ring-1', name: 'SY01', ownerPatientRef: 'patient-A' }
    storage.saveBoundDevice(boundDevice)

    const foreign = await bleManager.refreshBoundDeviceOwnership()
    assert.strictEqual(foreign, true, 'refresh 应返回异设备判定')
    assert.strictEqual(bleManager.state.boundDevice, null, '异设备应以未绑定展示')
    assert.strictEqual(bleManager.state.foreignDevice, true, '异设备应带 foreignDevice 标记')
    assert.deepStrictEqual(storage.getBoundDevice(), boundDevice, '异设备不应删除本地绑定记录')

    // 切回本人登录：恢复展示
    global.getApp = () => ({ globalData: { activeRole: 'PATIENT', patientRef: 'patient-A' } })
    const restored = await bleManager.refreshBoundDeviceOwnership()
    assert.strictEqual(restored, false)
    assert.deepStrictEqual(bleManager.state.boundDevice, boundDevice, '切回本人后应恢复绑定展示')
    assert.strictEqual(bleManager.state.foreignDevice, false, '切回本人后 foreignDevice 应复位')
  }

  console.log('Bound device ownership tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
