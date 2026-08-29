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

function readPersistingSources () {
  const files = []
  function visit (directory) {
    fs.readdirSync(directory, { withFileTypes: true }).forEach(entry => {
      const fullPath = path.join(directory, entry.name)
      if (entry.isDirectory()) visit(fullPath)
      else if (path.basename(fullPath) !== 'session-store.js') files.push(fullPath)
    })
  }
  visit(root)
  return files.map(file => fs.readFileSync(file, 'utf8')).join('\n')
}

function assertNoPattern (source, pattern, message) {
  assert.equal(pattern.test(source), false, message)
}

test('sensitive credentials and short-lived URLs never enter persistence or URL query construction', () => {
  const source = readAllMiniprogramFiles()
  const persistingSource = readPersistingSources()
  assertNoPattern(source, /[?&](?:accessToken|refreshToken|idCard|openid|unionid|deviceSecret|clientSecret|accessUrl)=/i, 'sensitive field in URL query')
  assertNoPattern(persistingSource, /wx\.setStorageSync\([\s\S]{0,500}(?:accessToken|refreshToken|idCard|openid|unionid|deviceSecret|clientSecret|accessUrl)/i, 'sensitive field in persistent storage')
  assertNoPattern(source, /console\.(?:log|info|warn|error)\([^\n]*(?:accessToken|refreshToken|idCard|openid|unionid|deviceSecret|clientSecret|accessUrl)/i, 'sensitive field in console logging')
})

test('short-lived report and WSS values are kept in page memory only', () => {
  const source = readAllMiniprogramFiles()
  assert.match(source, /currentWssToken/)
  assert.match(source, /currentAccessUrl/)
  assertNoPattern(source, /wx\.setStorageSync\([\s\S]{0,500}current(?:WssToken|AccessUrl)/i, 'short-lived access value persisted')
})

module.exports = { readAllMiniprogramFiles }
