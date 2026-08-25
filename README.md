# cdms-weixin：CDMS + RWFit 云开发小程序

本项目保留微信云开发的 `cloudfunctions/` 和环境配置，同时将 CDMS/RWFit 小程序代码放在 `miniprogram/`。患者端基于 RWFit 官方 Demo，负责手环扫描、绑定、历史同步和数据上传；医生端通过 `pages/wearable/sync/index` 负责一次性实时检测。

发布边界：`D:\weixinProject\cdms-weixin` 是完整业务小程序的唯一发布工程；`cdms-iot/miniapp` 仅作为 IoT 登录与采集桥接参考，不单独发布，也不覆盖本项目的页面路由。

## 云开发环境

- `project.config.json` 的 `miniprogramRoot` 为 `miniprogram/`，`cloudfunctionRoot` 为 `cloudfunctions/`。
- 发布包默认使用 `miniprogram/config/runtime.js` 中的生产地址；开发者工具启动参数仍可覆盖它们，因此体验版不依赖私有联调配置。
- `cloudbaserc.json` 的 `functionRoot` 应为 `./cloudfunctions`；迁移脚本会自动修正 QuickStart 中过期的 `./functions`。
- 云环境 ID 从 `miniprogram/envList.js` 读取；当前已配置生产开发环境 `cloud1-d2go472bm336b5d8a`（环境名 `cloud1`）。
- 原有 `cloudfunctions/quickstartFunctions` 会保留。它不是 RWFit 数据链路的一部分，是否部署由项目另行决定。

## 运行链路

1. 小程序使用 `cdmsBaseUrl` 调用 `cdms` 的微信授权登录接口；用户填写已建档手机号，服务端兑换微信 code 后返回患者/医生角色并支持个人中心切换。小程序不保存或提交账户密码。
2. 进入 H5 患者列表、患者360或随访前，由 `cdms` 生成一次性 handoff code；小程序只打开受控 H5 路由，不在 URL 中放 JWT。
3. 小程序首页的“CDMS 业务工作台”通过 `cdms` 生成一次性 H5 handoff 地址，患者进入随访，医生进入患者列表；H5 只负责业务展示，不接触蓝牙。
4. Manager/统一认证层仍可将 `iotBaseUrl`、`patientRef`、`mode` 等上下文传给小程序；设备会话必须由服务端签发。
5. 小程序初始化 CloudBase 和 BLE 适配器，使用 handoff 兑换短期 IoT 会话。
6. 患者模式登录后由 CDMS 后端代签名申请 `LONG_TERM` 手环会话（小程序不持有 IoT 密钥）；医生模式仍使用 Manager handoff 的 `TEMPORARY` 会话，只采集实时数据。
7. 数据标准化后上传 `cdms-iot` 的 `POST /v1/wearable-upload-batches`；弱网时按患者隔离到本地队列。

## 开发与验收

使用微信开发者工具导入本项目，确认 AppID 为 `wx0a1ac8be9b6fb0e4`。当前 `project.private.config.json` 已预置 `jq.mockr.com.cn` HTTPS 联调编译模式，并关闭开发阶段的合法域名校验：

```text
cdmsBaseUrl=https://jq.mockr.com.cn/cdmsapi&managerBaseUrl=https://jq.mockr.com.cn/cdmsmanagerapi/api/v1&iotBaseUrl=https://jq.mockr.com.cn/cdmsiotapi
```

参数会由 `miniprogram/app.js` 写入运行时上下文；`cdmsBaseUrl` 不要再追加 `/api/v1`，CDMS 请求会自动拼接，Manager 地址则已包含 `/api/v1`。生产服务器的 CDMS 业务 H5 handoff 地址已配置为 `https://jq.mockr.com.cn/cdms/`；`/mzf-sq/` 仅用于问卷/设备采集 H5，不承载患者列表和随访页面。正式真机和发布前仍需在微信后台将该域名加入 request、uploadFile、downloadFile、合法业务域名及 socket 合法域名。模拟器可以验证登录、角色切换、H5 handoff 和报告查询；蓝牙扫描、连接、历史同步、实时数据和断线重连必须用真机验收。修改发布包代码后，需要在微信开发者工具中重新编译并上传体验版；服务器端配置不会自动更新小程序版本。

RWFit SDK 位于 `miniprogram/sdk/rw-ble-sdk.min.js`，MIT 许可见 `miniprogram/sdk/RWFit-LICENSE`。SDK 版本为 `RW_SDK_V2.0.0_20260807`。原始 PPG/ACC 和调试波形不会上传到 CDMS。
