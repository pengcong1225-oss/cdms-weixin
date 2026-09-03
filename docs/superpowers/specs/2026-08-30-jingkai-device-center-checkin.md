# 经开基线：医生设备中心与体脂秤扫码签到接入说明

> 基线分支：`baseline/jingkai-wuhan-center-hospital`
> 参考实现：`D:\codex\worktrees\cdms-weixin-full-native-finish`（docs/superpowers/specs/2026-08-30-native-full-content-parity-design.md）

## 范围

本次按参考工程补齐三块能力，其余页面（医生工作台、患者 360、随访、报告等）保持基线现状，后续另行迁移：

1. 医生端设备中心：设备 Tab 按角色分流，医生身份展示可连接/可操作的设备目录。
2. 体脂秤双模式：扫码轮测（默认）与单人直接测量（兜底）。
3. 患者扫码签到：原生 `wx.scanCode` 扫医生工作站二维码加入候测队列。

## 角色与设备中心

- `pages/device/device` 通过 `globalData.activeRole` 区分角色。
- 医生目录：花潮身高体脂秤（SCALE_BLE，已接入）、MFA-1 血糖仪（MFA1_BLE，入口预留）、Sunvou 呼气报告（SUNVOU，入口预留）。后两者页面未随本次迁移，点击给出明确提示。
- 医生身份下不展示患者戒指绑定/解绑/设置；患者身份行为不变。
- 医生设备中心不管理患者家用设备。

## 扫码轮测流程

1. 医生进入 `pages/device-scale/mode` → `pages/device-scale/station`，自动创建场次。
2. 工作站用 Canvas 渲染二维码，内容为 `cdms://scale-checkin?stationId=...&token=...`，只含场次 ID 与服务端签发的不透明签到令牌，不含患者或机构信息。
3. 患者从 `pages/scale-checkin` 扫码，客户端只回传 `stationId + checkinToken`；患者身份由服务端根据登录令牌派生 `patientRef`，重复签到幂等。
4. 医生“下一位”叫号，服务端返回脱敏患者摘要（性别/年龄/身高），自动下发体脂秤用户信息帧。
5. 测量结果先保存草稿（`RESULT_PENDING`），医生二次确认后才写入正式记录并完成队列项；支持跳过、重排、关闭场次。

## MFA-1 与 Sunvou 工作站

- `pages/device-mfa1`：采集会话工作站（创建/读取/签发 WSS 令牌/取消/重试）。会话与 WSS 令牌只保存在页面内存，退出即清理；走医生 JWT 鉴权的 `/api/v1/miniapp/iot/acquisition-sessions` facade，小程序不持有 IoT 密钥、不做 HMAC 签名。
- `pages/device-sunvou`：标准报告查询与短时访问地址打开（`wx.downloadFile` + `wx.openDocument`，图片走 `wx.previewImage`）。访问地址只在页面内存保持，不落盘。
- `utils/report-api.js` 本次只移植 Sunvou 所需的三个能力（患者报告列表、报告/附件短时地址）。AI 报告及其 SSE 流式部分随报告页迁移（参考工程 Task 4）再加入，避免携带未接入页面的死代码。
- 参考工程两个页面均缺 `.json` 文件，移植时已补齐导航标题与 `usingComponents`。
- 医生设备目录中 MFA-1、Sunvou 入口已从占位提示改为真实导航。

## 修复的基线运行时缺陷

- `utils/api.js` 的 `module.exports` 漏导出 `cdmsRequest`：基线的 H5 handoff 调用链未使用该导出所以此前未暴露，但 station-api 等新适配器在真机上会直接 TypeError。已补导出并由测试锁定。

## 服务端依赖（复用参考工程契约，需后端同形可用）

`/api/v1/miniapp/scale/stations` 系列：创建/查询场次、签到、队列、叫号、跳过、重排、草稿、确认、关闭。所有写请求携带 `idempotencyKey`。

- `/api/v1/miniapp/iot/acquisition-sessions` 系列：MFA-1 会话创建/查询/WSS 令牌/取消（医生 JWT facade）。
- `/api/v1/patients/{id}/reports` 系列与 `access-url`：Sunvou 报告列表与短时地址。

## 新增文件

- 组件：`app-header`、`state-panel`、`form-section`、`status-tag`（相对于参考实现补齐了 mode/checkin 页缺失的 `usingComponents` 声明）。
- 工具：`auth-guard`、`station-api`、`scale-qr`、`qrcode-generator`（MIT 第三方库原样拷贝）、`session-store`。
- 页面：`device-scale/mode`、`device-scale/station`、`scale-checkin`。
- 服务：`services/scaleBle.js` 转发既有 `services/scale/scaleBle.js`，体脂秤 BLE 与指环 bleManager 不共享状态。

## 相对参考实现的修正

- `device-scale/mode/index.json` 与 `scale-checkin/index.json` 补齐 `usingComponents`（参考工程缺失会导致组件不渲染）。
- `app.wxss` 补充 `--cdms-*` 设计令牌全集与 `.secondary-button` 样式（参考工程使用但未定义）。
- `iot-device-protocol` 的 `--cdms-text-secondary` 变量已在 `app.wxss` 中定义。
- 保留基线已有改动：监测间隔含“每 1 分钟”、心率/血氧报警含 50 档位。

## 验证

`node --test`（21 项）、全量 `node --check`、`git diff --check` 通过。蓝牙扫描/连接/测量与真实二维码扫码需真机验收。