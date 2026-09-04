const assert = require('assert')

const captured = []
global.getApp = () => ({ globalData: { cdmsBaseUrl: 'https://cdms.example', accessToken: 'jwt-token' } })
global.wx = {
  request: options => {
    captured.push(options)
    options.success({ statusCode: 200, data: { code: 200, data: { list: [], total: 0 } } })
  }
}

const api = require('../miniprogram/utils/api')

async function run () {
  captured.length = 0
  await api.listDoctorPatients({ page: 1, pageSize: 20 })
  assert.strictEqual(captured[0].url, 'https://cdms.example/api/v1/patients?page=1&pageSize=20')

  captured.length = 0
  await api.listDoctorPatients({ page: 2, pageSize: 20, keyword: '张三' })
  assert.strictEqual(captured[0].url, 'https://cdms.example/api/v1/patients?page=2&pageSize=20&keyword=%E5%BC%A0%E4%B8%89')
  assert.strictEqual(captured[0].method, 'GET')
  assert.strictEqual(captured[0].header.Authorization, 'Bearer jwt-token')

  captured.length = 0
  await api.listDoctorPatients({ page: 1, pageSize: 20, keyword: '   ' })
  assert.strictEqual(captured[0].url, 'https://cdms.example/api/v1/patients?page=1&pageSize=20')

  console.log('patient search tests passed')
}

run().catch(error => { console.error(error); process.exit(1) })
