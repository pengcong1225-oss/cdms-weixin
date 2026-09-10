const assert = require('assert')
const config = require('../miniprogram/config/runtime')
const privateConfig = require('../project.private.config.json')

assert.strictEqual(config.cdmsBaseUrl, 'https://jq.mockr.com.cn/cdmsapi')
assert.strictEqual(config.managerBaseUrl, 'https://jq.mockr.com.cn/cdmsmanagerapi/api/v1')
assert.strictEqual(config.iotBaseUrl, 'https://jq.mockr.com.cn/cdmsiotapi')

const launchProfiles = privateConfig.condition.miniprogram.list
assert.ok(launchProfiles.length > 0)
launchProfiles.forEach(profile => {
  assert.ok(profile.name.includes('jq.mockr.com.cn'))
  assert.ok(profile.query.includes('cdmsBaseUrl=https://jq.mockr.com.cn/cdmsapi'))
  assert.ok(profile.query.includes('managerBaseUrl=https://jq.mockr.com.cn/cdmsmanagerapi/api/v1'))
  assert.ok(profile.query.includes('iotBaseUrl=https://jq.mockr.com.cn/cdmsiotapi'))
  assert.ok(!profile.query.includes('mzf.jiaqiaokeji.com'))
})

console.log('runtime config tests passed')
