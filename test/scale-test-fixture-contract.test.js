const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const runbookPath = path.join(__dirname, '..', 'docs/superpowers/runbooks/2026-08-28-scale-test-data.md')

function readRunbook () {
  return fs.readFileSync(runbookPath, 'utf8')
}

test('scale fixture runbook locks patient identities and target organization', () => {
  const text = readRunbook()
  assert.match(text, /429004199102162952/)
  assert.match(text, /18696144935/)
  assert.match(text, /768495013408443/)
  assert.match(text, /18671457982/)
  assert.match(text, /1972545374712086529/)
  assert.match(text, /沌阳街沌阳社区卫生服务中心/)
})

test('scale fixture runbook forbids fabricated identity and wearable data', () => {
  const text = readRunbook()
  assert.match(text, /不创建 `cdms_patient_account`/)
  assert.match(text, /不伪造微信身份/)
  assert.match(text, /不写 `cdms_device_binding`/)
  assert.match(text, /不自动释放、抢占或覆盖/)
  assert.match(text, /可恢复备份/)
})

test('scale fixture runbook requires before-and-after preservation evidence', () => {
  const text = readRunbook()
  assert.match(text, /手环记录主键集合、设备绑定主键集合和关键指标内容摘要/)
  assert.match(text, /执行记录模板/)
  assert.match(text, /回滚核对结果/)
})
