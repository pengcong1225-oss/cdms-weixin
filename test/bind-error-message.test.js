// Task C（绑定错误友好提示）：409 / 消息含"已被" -> 可读文案
const assert = require('assert')
const { friendlyBindErrorMessage } = require('../miniprogram/utils/bind-error')

const EXPECTED = '该设备已被其他患者绑定，无法绑定'

function run () {
  assert.strictEqual(
    friendlyBindErrorMessage({ statusCode: 409 }),
    EXPECTED,
    'statusCode 409 应给出友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage({ statusCode: 409, message: 'HTTP 409', response: { code: 'DEVICE_ALREADY_BOUND' } }),
    EXPECTED,
    '409 + 业务体仍应给出友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage({ statusCode: 500, message: 'HTTP 500', response: { message: '设备已被其他患者绑定' } }),
    EXPECTED,
    'message 含"已被"（即使非 409）应给出友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage({ statusCode: 500, response: { msg: '该设备已被其他患者绑定' } }),
    EXPECTED,
    'response.msg 含"已被"应给出友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage({ message: '设备已被其他患者绑定' }),
    EXPECTED,
    '顶层 message 含"已被"应给出友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage({ statusCode: 500, message: 'HTTP 500', response: { message: '服务内部错误' } }),
    '',
    '普通错误不应命中友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage({ statusCode: 401, message: 'HTTP 401' }),
    '',
    '401 不应命中友好提示'
  )
  assert.strictEqual(
    friendlyBindErrorMessage(new Error('网络错误: request:fail')),
    '',
    '网络错误不应命中友好提示'
  )
  assert.strictEqual(friendlyBindErrorMessage(null), '', 'null 不应命中')
  console.log('Bind error message tests passed')
}

try {
  run()
} catch (error) {
  console.error(error)
  process.exit(1)
}
