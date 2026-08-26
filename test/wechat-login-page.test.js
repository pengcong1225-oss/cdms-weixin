const assert = require('assert')
const fs = require('fs')

const wxml = fs.readFileSync('miniprogram/pages/auth/login.wxml', 'utf8')
const js = fs.readFileSync('miniprogram/pages/auth/login.js', 'utf8')

assert.ok(wxml.includes('医生登录'))
assert.ok(wxml.includes('患者登录'))
assert.ok(wxml.includes('password'))
assert.ok(js.includes('loginDoctor'))
assert.ok(js.includes('loginWithWechat'))
