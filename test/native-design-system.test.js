const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.resolve(__dirname, '..')
const choiceTilePath = path.join(root, 'miniprogram/components/choice-tile/choice-tile.js')

function read (relativePath) {
  return fs.readFileSync(path.join(root, relativePath), 'utf8')
}

function readJson (relativePath) {
  return JSON.parse(read(relativePath))
}

function assertComponentContract (name, properties, events) {
  const dir = `miniprogram/components/${name}`
  const js = read(`${dir}/${name}.js`)
  const wxml = read(`${dir}/${name}.wxml`)
  const json = readJson(`${dir}/${name}.json`)
  assert.equal(json.component, true, `${name} must be a component`)
  properties.forEach(property => {
    assert.match(js, new RegExp(`${property}\\s*:`), `${name} must declare ${property}`)
  })
  events.forEach(eventName => {
    assert.match(js, new RegExp(`triggerEvent\\(['"]${eventName}['"]`), `${name} must emit ${eventName}`)
    assert.match(wxml, new RegExp(`bindtap="${eventName}|catchtap="${eventName}|data-event="${eventName}`), `${name} should expose ${eventName} interaction`)
  })
  assert.doesNotMatch(js, /h5|web-view|handoff|targetPath/i, `${name} must not accept H5 destinations`)
}

test('app visual tokens preserve current patient workbench values', () => {
  const wxss = read('miniprogram/app.wxss')
  const requiredTokens = [
    '--cdms-primary: #0c9b6c',
    '--cdms-primary-soft: #e5f6ee',
    '--cdms-background: #f3f7f5',
    '--cdms-surface: #ffffff',
    '--cdms-text: #20352e',
    '--cdms-muted: #8a9a93',
    '--cdms-radius-card: 28rpx',
    '--cdms-shadow-card:',
    '--cdms-status-success:',
    '--cdms-status-warning:',
    '--cdms-status-danger:',
    '--cdms-status-neutral:'
  ]
  requiredTokens.forEach(token => assert.ok(wxss.includes(token), `missing ${token}`))
})

test('shared native components declare serializable properties and named events', () => {
  assertComponentContract('app-header', ['title', 'subtitle', 'showBack', 'showLogout'], ['back', 'logout'])
  assertComponentContract('workspace-card', ['title', 'subtitle', 'icon', 'disabled'], ['select'])
  assertComponentContract('patient-card', ['patient', 'masked'], ['select'])
  assertComponentContract('stat-card', ['title', 'value', 'caption', 'tone'], [])
  assertComponentContract('status-tag', ['text', 'tone'], [])
  assertComponentContract('form-section', ['title', 'caption'], [])
  assertComponentContract('choice-tile', ['options', 'value', 'multiple', 'disabled'], ['change'])
  assertComponentContract('state-panel', ['state', 'title', 'message', 'actionText'], ['action'])
  assertComponentContract('bottom-action-bar', ['primaryText', 'secondaryText', 'loading'], ['primary', 'secondary'])
})

test('choice-tile ignores taps while disabled', () => {
  const previousComponent = global.Component
  let captured
  global.Component = config => {
    captured = config
    captured.data = {}
    captured.triggerEvent = (name, detail) => {
      captured.events.push({ name, detail })
    }
    captured.events = []
  }
  delete require.cache[choiceTilePath]
  try {
    require(choiceTilePath)
    captured.data = { value: '0', multiple: false, disabled: true }
    captured.methods.change.call(captured, { currentTarget: { dataset: { value: '1' } } })
    assert.deepStrictEqual(captured.events, [])
  } finally {
    global.Component = previousComponent
    delete require.cache[choiceTilePath]
  }
})

test('choice-tile exposes the selected state needed by native filters', () => {
  const wxml = read('miniprogram/components/choice-tile/choice-tile.wxml')
  const wxss = read('miniprogram/components/choice-tile/choice-tile.wxss')
  assert.match(wxml, /selectedMap\[item\.value\]/)
  assert.match(wxss, /choice-tile--selected/)
})

test('doctor and patient workspace pages share native visual components', () => {
  const doctor = readJson('miniprogram/pages/doctor/workspace/index.json')
  const patient = readJson('miniprogram/pages/patient/workspace/index.json')
  ;['app-header', 'workspace-card', 'stat-card', 'state-panel'].forEach(name => {
    assert.ok(doctor.usingComponents[name], `doctor workspace uses ${name}`)
  })
  ;['app-header', 'workspace-card', 'stat-card', 'state-panel'].forEach(name => {
    assert.ok(patient.usingComponents[name], `patient workspace uses ${name}`)
  })
})
