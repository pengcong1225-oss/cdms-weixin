// 发布包默认使用的生产服务地址。
// 开发者工具或入口参数传入的地址会在 app.applyBridgeQuery 中覆盖这些默认值。
module.exports = {
  cdmsBaseUrl: 'https://jq.mockr.com.cn/cdmsapi',
  managerBaseUrl: 'https://jq.mockr.com.cn/cdmsmanagerapi/api/v1',
  iotBaseUrl: 'https://jq.mockr.com.cn/cdmsiotapi',
  // 患者建档问卷（复用 cdmsManager 既有 H5：慢阻肺筛查问卷，提交即建档）。
  // 该页面不登录也能填写：选机构 → 填基本信息与 7 道题 → 提交，服务端会 matchOrCreate 患者档案。
  archiveQuestionnaireUrl: 'https://jq.mockr.com.cn/mzf-sq/#/screen'
}
