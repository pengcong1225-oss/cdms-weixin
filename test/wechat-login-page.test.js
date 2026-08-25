const assert = require('assert')
const fs = require('fs')

const wxml = fs.readFileSync('miniprogram/pages/auth/login.wxml', 'utf8')
const js = fs.readFileSync('miniprogram/pages/auth/login.js', 'utf8')

assert.ok(wxml.includes('微信授权登录'))
assert.ok(!wxml.includes('password'))
assert.ok(!js.includes('onPassword'))
assert.ok(js.includes('loginWithWechat'))
