// 患者端登录已改为「姓名 + 已建档手机号」直登：
// POST /api/v1/miniapp/auth/login，body 为 { realName, phone }，全程不得调用 wx.login。
const assert = require('assert')

const requests = []
let wxLoginCalls = 0

global.getApp = () => ({
  globalData: { cdmsBaseUrl: 'https://cdms.example.com' }
})
global.wx = {
  login () {
    wxLoginCalls += 1
    throw new Error('wx.login 不应再被调用')
  },
  request (options) {
    requests.push(options)
    options.success({ statusCode: 200, data: { data: { token: 'token-1' } } })
  }
}

const api = require('../miniprogram/utils/api')

async function run () {
  assert.strictEqual(typeof api.loginWithWechat, 'undefined', '微信授权登录入口应已移除')

  const result = await api.loginPatient({
    realName: '张三',
    phone: '13900000000',
    baseUrl: 'https://cdms.example.com'
  })

  assert.deepStrictEqual(result, { data: { token: 'token-1' } })
  assert.strictEqual(wxLoginCalls, 0, '患者登录不得调用 wx.login')
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].url, 'https://cdms.example.com/api/v1/miniapp/auth/login')
  assert.strictEqual(requests[0].method, 'POST')
  assert.deepStrictEqual(requests[0].data, { realName: '张三', phone: '13900000000' })
  assert.ok(!('wxCode' in requests[0].data), '请求体不得再携带 wxCode')

  // 姓名为空 / 手机号非法：API 层直接拒绝，不发任何请求。
  requests.length = 0
  await assert.rejects(() => api.loginPatient({ realName: '', phone: '13900000000' }),
    /请输入患者姓名和已建档的 11 位手机号/)
  await assert.rejects(() => api.loginPatient({ realName: '   ', phone: '13900000000' }),
    /请输入患者姓名和已建档的 11 位手机号/)
  await assert.rejects(() => api.loginPatient({ realName: '张三', phone: '139000000' }),
    /请输入患者姓名和已建档的 11 位手机号/)
  await assert.rejects(() => api.loginPatient({ realName: '张三', phone: '2390000000' }),
    /请输入患者姓名和已建档的 11 位手机号/)
  assert.strictEqual(requests.length, 0, '非法入参不得发出请求')
  assert.strictEqual(wxLoginCalls, 0)

  // 姓名两侧空格会被 trim 后再提交。
  requests.length = 0
  await api.loginPatient({ realName: '  李四  ', phone: ' 13800000000 ' })
  assert.strictEqual(requests.length, 1)
  assert.deepStrictEqual(requests[0].data, { realName: '李四', phone: '13800000000' })

  console.log('wechat-login tests passed')
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
