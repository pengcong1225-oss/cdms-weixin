const assert = require('assert')

const requests = []
global.getApp = () => ({
  globalData: { cdmsBaseUrl: 'https://cdms.example.com' }
})
global.wx = {
  request (options) {
    requests.push(options)
    options.success({ statusCode: 200, data: { data: { token: 'doctor-token', activeRole: 'DOCTOR' } } })
  }
}

const api = require('../miniprogram/utils/api')

async function run () {
  const result = await api.loginDoctor({ username: 'doctor-1', password: 'secret' })

  assert.deepStrictEqual(result, { data: { token: 'doctor-token', activeRole: 'DOCTOR' } })
  assert.strictEqual(requests.length, 1)
  assert.strictEqual(requests[0].url, 'https://cdms.example.com/api/v1/miniapp/auth/doctor-login')
  assert.deepStrictEqual(requests[0].data, { username: 'doctor-1', password: 'secret' })
}

run().catch(error => {
  console.error(error)
  process.exit(1)
})
