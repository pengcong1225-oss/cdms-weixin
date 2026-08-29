const assert = require('assert')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const apiPath = path.join(root, 'miniprogram/utils/api.js')
const followupApiPath = path.join(root, 'miniprogram/utils/followup-api.js')

function createRequestSpy (responses = []) {
  const calls = []
  const queue = Array.isArray(responses) ? responses.slice() : [responses]
  return {
    calls,
    get last () { return calls[calls.length - 1] },
    async cdmsRequest (url, method, data, token) {
      calls.push({ url, method, data, token })
      const response = queue.length ? queue.shift() : { data: null }
      if (response instanceof Error) throw response
      return response
    }
  }
}

function loadFollowupApi (spy, wxOverrides = {}) {
  delete require.cache[apiPath]
  delete require.cache[followupApiPath]
  require.cache[apiPath] = {
    id: apiPath,
    filename: apiPath,
    loaded: true,
    exports: { cdmsRequest: spy.cdmsRequest.bind(spy) }
  }
  global.getApp = () => ({
    globalData: {
      accessToken: 'access-1',
      cdmsBaseUrl: 'https://cdms.example'
    }
  })
  global.wx = Object.assign({
    getFileInfo: options => options.fail && options.fail(new Error('not mocked')),
    uploadFile: options => options.fail && options.fail(new Error('not mocked'))
  }, wxOverrides)
  return require(followupApiPath)
}

test('validateFollowup requires eight CAT answers and a visit date', () => {
  const { validateFollowup } = loadFollowupApi(createRequestSpy())

  const result = validateFollowup({
    patientId: '1',
    visitType: 0,
    visitDate: '',
    catAnswers: [0, 1]
  })

  assert.strictEqual(result.ok, false)
  assert.deepStrictEqual(result.errors, {
    visitDate: '随访日期必填',
    catAnswers: 'CAT 8 项必须齐全且每项 0-5'
  })
})

test('validateFollowup accepts a complete form snapshot', () => {
  const { validateFollowup } = loadFollowupApi(createRequestSpy())

  const result = validateFollowup({
    patientId: '768495013408443',
    visitType: 1,
    patientStatus: 1,
    visitDate: '2026-08-28T09:30:00',
    catAnswers: [0, 1, 2, 3, 4, 5, 0, 1]
  })

  assert.strictEqual(result.ok, true)
  assert.deepStrictEqual(result.errors, {})
})

test('followup list APIs keep patient scope and string ids', async () => {
  const spy = createRequestSpy([
    { data: { list: [{ id: 9001, patientId: 768495013408443, visitType: 1 }], page: 1, pageSize: 20, total: 1 } },
    { data: { list: [{ id: 9002, patientId: 768495013408445, visitType: 2 }], page: 1, pageSize: 10, total: 1 } },
    { data: { id: 9001, patientId: 768495013408443, visitType: 1 } },
    { data: null },
    { data: null },
    { data: null }
  ])
  const { listMyFollowups, listPatientFollowups, getFollowup, saveFollowup, saveFollowupDraft, updateFollowup, deleteFollowup } = loadFollowupApi(spy)

  const myList = await listMyFollowups({ page: 1, pageSize: 20, visitType: 1, startDate: '2026-08-01', endDate: '2026-08-28' })
  const patientList = await listPatientFollowups('768495013408443', { page: 1, pageSize: 10, visitType: 2 })
  const detail = await getFollowup('9001')
  await saveFollowup({
    patientId: '768495013408443',
    visitDate: '2026-08-28T09:30:00',
    visitType: 1,
    patientStatus: 1,
    catAnswers: [0, 1, 2, 3, 4, 5, 0, 1]
  })
  await saveFollowupDraft({
    patientId: '768495013408443',
    visitType: 1,
    patientStatus: 1,
    visitDate: '2026-08-28T09:30:00'
  })
  await updateFollowup('9001', {
    patientId: '768495013408443',
    visitDate: '2026-08-28T09:30:00',
    visitType: 1,
    patientStatus: 1,
    catAnswers: [0, 1, 2, 3, 4, 5, 0, 1]
  })
  await deleteFollowup('9001')

  assert.strictEqual(spy.calls[0].url, '/api/v1/followups/my?page=1&page_size=20&visit_type=1&start_date=2026-08-01&end_date=2026-08-28')
  assert.strictEqual(spy.calls[1].url, '/api/v1/patients/768495013408443/followups?page=1&page_size=10&visit_type=2')
  assert.strictEqual(spy.calls[2].url, '/api/v1/followups/9001')
  assert.strictEqual(spy.calls[3].url, '/api/v1/followups')
  assert.strictEqual(spy.calls[4].url, '/api/v1/followups/draft')
  assert.strictEqual(spy.calls[5].url, '/api/v1/followups/9001')
  assert.strictEqual(spy.calls[6].url, '/api/v1/followups/9001')
  assert.strictEqual(myList.list[0].id, '9001')
  assert.strictEqual(myList.list[0].patientId, '768495013408443')
  assert.strictEqual(patientList.list[0].id, '9002')
  assert.strictEqual(detail.id, '9001')
})

test('uploadPhoto rejects unsupported formats and files larger than 5 MiB', async () => {
  let getFileInfoCalls = 0
  let uploadFileCalls = 0
  const spy = createRequestSpy()
  const { uploadPhoto } = loadFollowupApi(spy, {
    getFileInfo: options => {
      getFileInfoCalls += 1
      options.success({ size: 6 * 1024 * 1024 })
    },
    uploadFile: options => {
      uploadFileCalls += 1
      options.success({ statusCode: 200, data: JSON.stringify({ code: 0, data: { url: 'https://cdn.example/photo.jpg' } }) })
    }
  })

  await assert.rejects(() => uploadPhoto('/tmp/picture.gif'), /仅支持 jpg\/jpeg\/png/)
  await assert.rejects(() => uploadPhoto('/tmp/big.jpg'), /不能超过 5 MiB/)

  assert.strictEqual(getFileInfoCalls, 1)
  assert.strictEqual(uploadFileCalls, 0)
})

test('uploadPhoto uses the existing upload endpoint and returns the uploaded url', async () => {
  const spy = createRequestSpy()
  const { uploadPhoto } = loadFollowupApi(spy, {
    getFileInfo: options => options.success({ size: 1024 }),
    uploadFile: options => {
      assert.strictEqual(options.url, 'https://cdms.example/api/v1/upload/photo')
      assert.strictEqual(options.name, 'file')
      assert.strictEqual(options.filePath, '/tmp/photo.jpg')
      assert.deepStrictEqual(options.formData, { type: 'followup' })
      assert.deepStrictEqual(options.header, { Authorization: 'Bearer access-1' })
      options.success({ statusCode: 200, data: JSON.stringify({ code: 0, data: { url: 'https://cdn.example/photo.jpg', fileName: 'photo.jpg', fileSize: 1024 } }) })
    }
  })

  const result = await uploadPhoto('/tmp/photo.jpg')

  assert.deepStrictEqual(result, {
    url: 'https://cdn.example/photo.jpg',
    fileName: 'photo.jpg',
    fileSize: 1024
  })
})
