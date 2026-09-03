const assert = require('assert')
const fs = require('fs')
const path = require('path')

const root = path.resolve(__dirname, '..', 'miniprogram')
const appConfig = JSON.parse(fs.readFileSync(path.join(root, 'app.json'), 'utf8'))

// app.json 里注册的每个页面必须三件套齐全（wxss 可选），防止"路由存在但文件缺失"导致开发者工具构建失败
for (const route of appConfig.pages) {
  for (const ext of ['js', 'json', 'wxml']) {
    const file = path.join(root, `${route}.${ext}`)
    assert.ok(fs.existsSync(file), `missing page file: ${route}.${ext}`)
    assert.ok(fs.statSync(file).size > 0, `empty page file: ${route}.${ext}`)
  }
  const jsonPath = path.join(root, `${route}.json`)
  const json = JSON.parse(fs.readFileSync(jsonPath, 'utf8'))
  // 页面声明的组件必须存在四件套
  for (const [tag, componentPath] of Object.entries(json.usingComponents || {})) {
    const base = path.join(root, componentPath.replace(/^\//, ''))
    for (const ext of ['js', 'json', 'wxml']) {
      assert.ok(fs.existsSync(`${base}.${ext}`), `page ${route} uses component ${tag} but ${componentPath}.${ext} is missing`)
    }
  }
}

console.log('route files tests passed')