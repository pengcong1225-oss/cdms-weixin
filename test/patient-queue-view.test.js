/**
 * 患者场次队列改用后端 my-queue 专用接口（MiniappScaleStationPatientQueueDTO）。
 * 风格对齐现有 *.test.js：require + assert，直接 node test/patient-queue-view.test.js 运行。
 *
 * 收紧要点复核：
 *  - normalizePatientQueue 产出【恰好】为患者可见字段集，绝无 token/queue/currentQueueItem/currentDraft/patientSummary/metrics；
 *  - createCheckin / getMyQueue 走患者 DTO，不再对 checkins 调 normalizeStation；
 *  - scale-checkin 页面只读 view.queueNo，checkedIn+STATION 时轮询 my-queue，onHide/onUnload 清定时器。
 */
const assert = require('assert')
const path = require('path')

const api = require('../miniprogram/utils/api')
const stationApi = require('../miniprogram/utils/station-api')

// ---- a) normalizePatientQueue：字段集与患者安全边界 ----

const PATIENT_KEYS = ['stationId', 'stationName', 'deviceType', 'status', 'queueItemId', 'queueNo', 'queueStatus', 'waitingAhead', 'message']

// 后端即使误传旧结构里那些敏感字段，也必须被丢弃（客户端不信任、不透出）
const dirty = {
  data: {
    stationId: '1972545374712086529',
    stationName: '体脂秤轮测台',
    deviceType: 'SCALE',
    status: 'OPEN',
    queueItemId: '551',
    queueNo: 7,
    queueStatus: 'WAITING',
    waitingAhead: 3,
    message: '已加入设备测量队列',
    // 以下均为医生端/旧结构字段，患者 DTO 不得出现：
    checkinToken: 'tok-secret',
    tokenExpiresAt: '2026-08-30T10:00:00',
    queue: [{ id: '552', patientSummary: { maskedName: '李*兰' } }],
    currentQueueItem: { id: '553' },
    currentDraft: { id: 'd1' },
    patientSummary: { maskedName: '张*生' },
    maskedName: '张*生',
    metrics: [{ type: 'weight', value: 71.5 }]
  }
}
const pv = stationApi.normalizePatientQueue(dirty)
assert.deepStrictEqual(Object.keys(pv).sort(), PATIENT_KEYS.slice().sort(), '患者 DTO 字段集必须恰好为患者可见字段')
assert.strictEqual(pv.stationId, '1972545374712086529', '雪花 ID 以字符串保留')
assert.strictEqual(String(Number(pv.stationId)) === pv.stationId, false, '超范围雪花 ID 不得数值化')
assert.strictEqual(pv.queueNo, 7)
assert.strictEqual(pv.waitingAhead, 3)
assert.strictEqual(pv.message, '已加入设备测量队列')
// 逐条确认敏感字段彻底不外泄
for (const forbidden of ['checkinToken', 'tokenExpiresAt', 'queue', 'currentQueueItem', 'currentDraft', 'patientSummary', 'maskedName', 'metrics']) {
  assert.ok(!(forbidden in pv), `患者 DTO 不得含 ${forbidden}`)
}

// 空响应回退：仅补 station/status/deviceType，其余保持空串
const emptyPv = stationApi.normalizePatientQueue({})
assert.strictEqual(emptyPv.status, 'OPEN')
assert.strictEqual(emptyPv.deviceType, 'SCALE')
assert.strictEqual(emptyPv.queueNo, '')
assert.strictEqual(emptyPv.waitingAhead, '')
assert.strictEqual(emptyPv.queueItemId, '')
assert.deepStrictEqual(Object.keys(stationApi.normalizePatientQueue({ data: null })).sort(), PATIENT_KEYS.slice().sort())

;(async () => {
  // ---- b/c) createCheckin 命中 /checkins、getMyQueue 命中 /my-queue，且都走患者 DTO ----

  const calls = []
  const originalCdmsRequest = api.cdmsRequest
  // 患者侧 v1 通道回归（签到/my-queue 端点后缀两版同名）；v2 断言见 test/device-station-phase2.test.js
  stationApi.setStationApiVersion('v1')
  api.cdmsRequest = async (reqPath, method, body) => {
    calls.push({ path: reqPath, method, body })
    return { data: { stationId: '197', status: 'OPEN', queueItemId: '551', queueNo: 9, queueStatus: 'WAITING', waitingAhead: 2, message: '排队成功' } }
  }

  try {
    const checkinView = await stationApi.createCheckin('197', 'tok-xyz')
    assert.strictEqual(calls[0].path, '/api/v1/miniapp/scale/stations/197/checkins')
    assert.strictEqual(calls[0].method, 'POST')
    assert.strictEqual(calls[0].body.checkinToken, 'tok-xyz')
    assert.strictEqual(calls[0].body.patientId, undefined, '签到载荷不得携带患者身份字段')
    // 归一化为患者 DTO：不再有 normalizeStation 的 queue/currentQueueItem 结构
    assert.ok(!('queue' in checkinView), 'createCheckin 结果不应含完整 queue')
    assert.ok(!('currentQueueItem' in checkinView), 'createCheckin 结果不应含 currentQueueItem')
    assert.deepStrictEqual(Object.keys(checkinView).sort(), PATIENT_KEYS.slice().sort(), 'createCheckin 必须返回患者 DTO')
    assert.strictEqual(checkinView.queueNo, 9)

    const myView = await stationApi.getMyQueue('197')
    assert.strictEqual(calls[1].path, '/api/v1/miniapp/scale/stations/197/my-queue')
    assert.strictEqual(calls[1].method, 'GET')
    assert.strictEqual(calls[1].body, null, 'my-queue 为 GET，无请求体')
    assert.deepStrictEqual(Object.keys(myView).sort(), PATIENT_KEYS.slice().sort(), 'getMyQueue 必须返回患者 DTO')
    assert.strictEqual(myView.queueNo, 9)
    assert.strictEqual(myView.waitingAhead, 2)

    // ---- d/e) scale-checkin 页面：submitCheckin 用 view.queueNo；轮询更新文案；onHide 停表 ----

    global.getApp = () => ({ globalData: { accessToken: 't', refreshToken: 'r', activeRole: 'PATIENT', cdmsBaseUrl: 'https://cdms.example.com' } })
    let timerCount = 0
    let cleared = 0
    global.setInterval = () => { timerCount++; return { __timer: timerCount } }
    global.clearInterval = () => { cleared++ }
    global.wx = { scanCode: () => undefined, navigateBack: () => undefined, reLaunch: () => undefined, showToast: () => undefined }

    const pagePath = path.resolve(__dirname, '../miniprogram/pages/scale-checkin/index.js')
    let cfg = null
    global.Page = c => { cfg = c }
    delete require.cache[pagePath]
    require(pagePath)
    const page = Object.assign({}, cfg)
    page.data = JSON.parse(JSON.stringify(cfg.data))
    page.setData = function (patch) {
      if (!patch) return
      Object.keys(patch).forEach(k => { if (k.indexOf('.') < 0 && k.indexOf('[') < 0) this.data[k] = patch[k] })
    }

    // 桩掉患者侧 API：记录调用、按脚本返回患者 DTO
    const pageCalls = []
    let myQueueScript = []
    stationApi.createCheckin = async (stationId, token) => {
      pageCalls.push({ fn: 'createCheckin', stationId, token })
      return { stationId: String(stationId), stationName: '', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 12, queueStatus: 'WAITING', waitingAhead: 4, message: '' }
    }
    let firstPoll = true
    stationApi.getMyQueue = async (stationId) => {
      pageCalls.push({ fn: 'getMyQueue', stationId })
      if (myQueueScript.length) return myQueueScript.shift()
      // 无脚本时回退为与签到一致的患者 DTO（waitingAhead 4），避免把默认值误当成轮询更新
      const ahead = firstPoll ? 4 : 0
      firstPoll = false
      return { stationId: String(stationId), stationName: '', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 12, queueStatus: 'WAITING', waitingAhead: ahead, message: '' }
    }

    await page.submitCheckin({ stationId: 'st-9', checkinToken: 'tok-9' })
    assert.strictEqual(pageCalls[0].fn, 'createCheckin')
    assert.strictEqual(page.data.checkedIn, true)
    assert.strictEqual(page.data.checkinKind, 'STATION')
    // d) queueNo 取自患者 DTO
    assert.strictEqual(page.data.queueNo, '12', 'data.queueNo 应来自 view.queueNo')
    assert.strictEqual(page.data.waitingAheadText, '前面还有 4 人')
    // §5.1 主状态行仍是"设备排队签到成功"
    assert.ok(page.data.statusText.indexOf('设备排队签到成功') === 0, 'success copy must be 设备排队签到成功')
    // 起轮询：startQueuePolling 会先立即刷新一次
    assert.ok(timerCount >= 1, 'STATION 签到后应启动轮询定时器')
    assert.strictEqual(pageCalls[1].fn, 'getMyQueue', '签到后立即拉取 my-queue')

    // e) 轮询更新 waitingAhead 文案（前方人数减少 → 文案随之变化）
    myQueueScript = [{ stationId: 'st-9', stationName: '', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 12, queueStatus: 'WAITING', waitingAhead: 1, message: '即将叫到您' }]
    await page.refreshMyQueue()
    assert.strictEqual(page.data.waitingAheadText, '前面还有 1 人', '轮询应刷新前方等待人数文案')
    assert.strictEqual(page.data.queueMessage, '即将叫到您', '轮询应刷新患者消息')

    // waitingAhead=0 的特殊文案
    myQueueScript = [{ stationId: 'st-9', stationName: '', deviceType: 'SCALE', status: 'OPEN', queueItemId: '551', queueNo: 12, queueStatus: 'CALLED', waitingAhead: 0, message: '' }]
    await page.refreshMyQueue()
    assert.strictEqual(page.data.waitingAheadText, '前面没有等待人数，请留意叫号')

    // onHide 停止定时器
    const beforeCleared = cleared
    page.onHide()
    assert.ok(cleared > beforeCleared, 'onHide 必须清理轮询定时器')
    assert.strictEqual(page.queueTimer, null, 'onHide 后定时器句柄应清空')

    // onUnload 同样清理；未签到时 refreshMyQueue 早退，不产生额外调用
    page.data.checkedIn = false
    const callsBefore = pageCalls.length
    await page.refreshMyQueue()
    assert.strictEqual(pageCalls.length, callsBefore, '非 STATION 状态不得轮询')
    page.onUnload()
  } finally {
    api.cdmsRequest = originalCdmsRequest
    stationApi.setStationApiVersion('v2')
  }

  console.log('patient queue view tests passed')
})().catch(error => {
  console.error(error)
  process.exit(1)
})