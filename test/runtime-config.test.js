const assert = require('assert')
const config = require('../miniprogram/config/runtime')

assert.strictEqual(config.cdmsBaseUrl, 'https://mzf.jiaqiaokeji.com/cdmsapi')
assert.strictEqual(config.managerBaseUrl, 'https://mzf.jiaqiaokeji.com/cdmsmanagerapi/api/v1')
assert.strictEqual(config.iotBaseUrl, 'https://mzf.jiaqiaokeji.com/cdmsiotapi')

console.log('runtime config tests passed')
