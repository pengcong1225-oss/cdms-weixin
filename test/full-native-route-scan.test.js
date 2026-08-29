const assert = require('assert')
const fs = require('fs')
const path = require('path')
const test = require('node:test')

const root = path.join(__dirname, '..', 'miniprogram')

function readAllMiniprogramFiles () {
  const files = []
  function visit (directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else files.push(fullPath)
    })
  }
  visit(root)
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
}

test('full miniapp source has no business webview or H5 handoff entry', () => {
  const source = readAllMiniprogramFiles()
  assert.equal(source.includes('<web-view'), false)
  assert.equal(source.includes('/pages/h5/'), false)
  assert.equal(source.includes('createHandoff('), false)
})

module.exports = { readAllMiniprogramFiles }
