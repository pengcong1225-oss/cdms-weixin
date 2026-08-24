const assert = require('assert')
const config = require('../miniprogram/config/runtime')

assert.strictEqual(config.cdmsBaseUrl, 'https://jq.mockr.com.cn/cdmsapi')
assert.strictEqual(config.managerBaseUrl, 'https://jq.mockr.com.cn/cdmsmanagerapi/api/v1')
assert.strictEqual(config.iotBaseUrl, 'https://jq.mockr.com.cn/cdmsiotapi')

console.log('runtime config tests passed')
