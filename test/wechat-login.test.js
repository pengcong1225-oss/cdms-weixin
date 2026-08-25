const assert = require('assert')

const requests = []
global.getApp = () => ({
  globalData: { cdmsBaseUrl: 'https://cdms.example.com' }
})
global.wx = {
  login ({ success }) {
    success({ code: 'wx-code-1' })
  },
  request (options) {
    requests.push(options)
    options.success({ statusCode: 200, data: { data: { token: 'token-1' } } })
  }
}

const api = require('../miniprogram/utils/api')

async function run () {
  const result = await api.loginWithWechat({
    phone: '13900000000',
    baseUrl: 'https://cdms.example.com'
  })

  assert.deepStrictEqual(result, { data: { token: 'token-1' } })
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].url, 'https://cdms.example.com/api/v1/miniapp/auth/login')
  assert.deepStrictEqual(requests[0].data, { phone: '13900000000', wxCode: 'wx-code-1' })
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
