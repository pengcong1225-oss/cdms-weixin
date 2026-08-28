const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const patientApiPath = path.join(root, 'miniprogram/utils/patient-api.js')

function createRequestSpy (responses = []) {
  const calls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  const spy = {
    get last () { return calls[calls.length - 1] },
    get calls () { return calls },
    async cdmsRequest (url, method, data, token) {
      calls.push({ url, method, data, token })
      const response = queue.length ? queue.shift() : { data: null }
      if (response instanceof Error) throw response
      return response
    }
  }
  return spy
}

function loadPatientApi (spy) {
  delete require.cache[apiPath]
  delete require.cache[patientApiPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: { cdmsRequest: spy.cdmsRequest.bind(spy) }
  }
  global.getApp = () => ({ globalData: { accessToken: 'access-1' } })
  return require(patientApiPath)
}

test('listPatients encodes query params and keeps org id as string', async () => {
  const spy = createRequestSpy({ data: { list: [], page: 1, pageSize: 20, total: 0 } })
  const { listPatients } = loadPatientApi(spy)

  await listPatients({ page: 1, pageSize: 20, keyword: '测试', orgId: '1972545374712086529' })

  assert.equal(spy.last.url, '/api/v1/patients?page=1&pageSize=20&keyword=%E6%B5%8B%E8%AF%95&orgId=1972545374712086529')
  assert.equal(typeof spy.last.url.match(/orgId=([^&]+)/)[1], 'string')
})

test('listPatients omits phone or id-card shaped keywords from URL queries', async () => {
  const spy = createRequestSpy({ data: { list: [], page: 1, pageSize: 20, total: 0 } })
  const { listPatients } = loadPatientApi(spy)

  await listPatients({ page: 1, pageSize: 20, keyword: '18696144935' })
  await listPatients({ page: 1, pageSize: 20, keyword: '429004199102162952' })

  assert.equal(spy.calls[0].url.includes('18696144935'), false)
  assert.equal(spy.calls[1].url.includes('429004199102162952'), false)
  assert.equal(spy.calls[0].url, '/api/v1/patients?page=1&pageSize=20')
  assert.equal(spy.calls[1].url, '/api/v1/patients?page=1&pageSize=20')
})

test('patient id path params are string encoded without numeric coercion', async () => {
  const spy = createRequestSpy([
    { data: { id: '768495013408443', basicInfo: {}, orgInfo: { orgId: '1972545374712086529' } } },
    { data: { patientId: '768495013408443', detail: { orgInfo: { orgId: '1972545374712086529' } } } },
    { data: null }
  ])
  const { getPatient, getPatient360, deletePatient } = loadPatientApi(spy)

  const detail = await getPatient('768495013408443')
  const patient360 = await getPatient360('768495013408443')
  await deletePatient('768495013408443')

  assert.equal(spy.calls[0].url, '/api/v1/patients/768495013408443')
  assert.equal(spy.calls[1].url, '/api/v1/patients/768495013408443/360')
  assert.equal(spy.calls[2].url, '/api/v1/patients/768495013408443')
  assert.equal(detail.id, '768495013408443')
  assert.equal(detail.orgInfo.orgId, '1972545374712086529')
  assert.equal(patient360.patientId, '768495013408443')
  assert.equal(patient360.detail.orgInfo.orgId, '1972545374712086529')
})

test('duplicate check and save keep identity values in POST body only', async () => {
  const spy = createRequestSpy([
    { data: { idCardConflict: false, phoneConflict: true } },
    { data: { id: 768495013408445, message: '患者创建成功' } },
    { data: { id: 768495013408445, basicInfo: { phone: '18696144935' } } }
  ])
  const { checkDuplicate, createPatient, updatePatient } = loadPatientApi(spy)
  const payload = {
    basicInfo: {
      name: '测试患者',
      phone: '18696144935',
      idCard: '429004199102162952',
      orgId: '1972545374712086529',
      serveOrgId: '1972545374712086529',
      createOrgId: '1972545374712086529'
    }
  }

  await checkDuplicate(payload.basicInfo, '768495013408445')
  const created = await createPatient(payload)
  const updated = await updatePatient('768495013408445', payload)

  assert.equal(spy.calls[0].url, '/api/v1/patients/duplicate-check?excludeId=768495013408445')
  assert.equal(spy.calls[0].method, 'POST')
  assert.equal(spy.calls[0].data.phone, '18696144935')
  assert.equal(spy.calls[0].url.includes('18696144935'), false)
  assert.equal(spy.calls[0].url.includes('429004199102162952'), false)
  assert.equal(spy.calls[1].url, '/api/v1/patients')
  assert.equal(spy.calls[2].url, '/api/v1/patients/768495013408445')
  assert.equal(spy.calls[2].method, 'PUT')
  assert.equal(created.id, '768495013408445')
  assert.equal(updated.id, '768495013408445')
})

test('listOrganizations uses protected org search and string ids', async () => {
  const spy = createRequestSpy({ data: [{ id: '1972545374712086529', name: '沌阳街' }] })
  const { listOrganizations } = loadPatientApi(spy)

  const result = await listOrganizations({ keyword: '沌阳' })

  assert.equal(spy.last.url, '/api/v1/org/search?keyword=%E6%B2%8C%E9%98%B3')
  assert.equal(result[0].id, '1972545374712086529')
})

module.exports = { createRequestSpy }
