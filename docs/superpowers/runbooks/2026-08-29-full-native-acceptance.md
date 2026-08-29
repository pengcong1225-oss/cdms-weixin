# 全量原生小程序验收运行手册

## 1. 导入与配置

1. 在微信开发者工具导入 `D:\codex\worktrees\cdms-weixin-full-native-finish`。
2. 使用不带身份参数的 CDMS 服务地址配置 `cdmsBaseUrl`；将 CDMS API 域名加入 request 合法域名。
3. 服务端配置 `IOT_ACQUISITION_BASE_URL`、`IOT_ACQUISITION_CLIENT_ID`、`IOT_ACQUISITION_CLIENT_SECRET`，值只放部署环境密钥管理，不写入小程序项目。
4. 编译时关闭 ES6 转换差异导致的兼容选项，执行项目自带 Node 测试作为导入前门禁。

## 2. 自动门禁

在小程序工作树运行：

```powershell
node --test
```

在 `D:\codex\worktrees\cdms-miniapp-native-finish\backend` 运行：

```powershell
mvn -q test
```

另行执行 `node --check` 逐文件语法检查、路由/敏感字段扫描和 `git diff --check`。物理 BLE、WSS、网络抖动和设备断线属于手工验收，不以自动化通过替代。

## 3. 手工链路

- 医生登录后进入患者列表，打开患者详情、360、随访、监测、报告、统计、消息和设备工作站；确认页面均为原生且患者上下文不出现在 URL query。
- 在 MFA-1 工作站创建会话、刷新状态、签发 WSS 令牌、重试和取消；开发者工具 Network 中只应看到 CDMS JWT，不得出现 `X-CDMS-Signature`、IoT client id 或 secret。
- 使用患者账号验证患者工作台、随访、报告、指环同步和问卷复制；问卷复制内容不得携带身份、令牌或场次参数。
- 断网、超时和 5xx 后重新进入小程序，确认登录态仍在；服务端确认吊销后才跳转登录页。点击唯一退出按钮后，重新进入必须要求登录。
- 有真实设备条件时，验证 MFA-1 BLE 连接、WSS 收包、完成状态和异常重试；当前环境不宣称已完成真机测试。

## 4. 记录

记录开发者工具版本、基础库版本、测试账号、接口环境、Network 截图、设备型号和失败链路。任何 401/403、越权患者数据、客户端 IoT 凭证、H5/WebView 入口均为发布阻塞项。
