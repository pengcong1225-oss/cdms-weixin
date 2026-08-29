const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')
const { getRoleEntry } = require('../miniprogram/utils/role-entry')
const { getWorkspaceEntries, PUBLIC_SCREENING_URL } = require('../miniprogram/utils/workspace-entry')

const root = path.resolve(__dirname, '..')

function readAllMiniprogramFiles () {
  const files = []
  const stack = [path.join(root, 'miniprogram')]
  while (stack.length) {
    const current = stack.pop()
    const stat = fs.statSync(current)
    if (stat.isDirectory()) {
      fs.readdirSync(current).forEach(name => stack.push(path.join(current, name)))
    } else if (/\.(js|json|wxml|wxss)$/.test(current)) {
      files.push(current)
    }
  }
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
}

test('business role entries are native', () => {
  assert.equal(getRoleEntry('DOCTOR').type, 'NATIVE')
  assert.equal(getRoleEntry('DOCTOR').url, '/pages/doctor/workspace/index')
  assert.equal(getRoleEntry('PATIENT').type, 'NATIVE')
  assert.equal(getRoleEntry('PATIENT').url, '/pages/patient/workspace/index')
  assert.equal(getWorkspaceEntries('DOCTOR').some(item => item.type === 'H5'), false)
  assert.equal(getWorkspaceEntries('PATIENT').some(item => item.type === 'H5'), false)
})

test('native workspace routes are registered and h5 webview route is removed', () => {
  const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'miniprogram/app.json'), 'utf8'))
  assert.ok(appConfig.pages.includes('pages/doctor/workspace/index'))
  assert.ok(appConfig.pages.includes('pages/patient/workspace/index'))
  assert.ok(appConfig.pages.includes('pages/device-mfa1/index'))
  assert.ok(appConfig.pages.includes('pages/device-sunvou/index'))
  assert.equal(appConfig.pages.some(page => page.includes('pages/h5')), false)
})

test('public questionnaire is a fixed copy action without identity context', () => {
  assert.equal(PUBLIC_SCREENING_URL, 'https://jq.mockr.com.cn/mzf-sq/#/screen')
  const entries = getWorkspaceEntries('PATIENT')
  const questionnaire = entries.find(item => item.key === 'public-questionnaire')
  assert.deepStrictEqual(questionnaire, {
    key: 'public-questionnaire',
    title: '建档问卷',
    subtitle: '复制公开问卷地址',
    type: 'COPY',
    copyText: 'https://jq.mockr.com.cn/mzf-sq/#/screen'
  })
  assert.equal(/[?&](patient|patientId|org|orgId|token|code|session|openid|unionid)=/i.test(questionnaire.copyText), false)
})

test('miniprogram source has no webview business entry paths', () => {
  const source = readAllMiniprogramFiles()
  assert.equal(source.includes('<web-view'), false)
  assert.equal(source.includes('pages/h5'), false)
  assert.equal(source.includes('createHandoff'), false)
  assert.equal(/targetPath[^\n]*h5/i.test(source), false)
})
