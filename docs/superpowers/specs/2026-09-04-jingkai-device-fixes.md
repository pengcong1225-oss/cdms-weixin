# 经开基线设备对接问题定位与修复方案

> 基线分支：`baseline/jingkai-wuhan-center-hospital`
> 接口文档来源：`D:\知识库仓库\doctorWho\项目文档\智慧医疗\慢阻肺项目\接口文档`

## 问题 3：体脂秤扫码轮测流程报错 —— 根因与结论

**前端侧本身已就绪，报错主因是后端场次接口未部署。**

链路：进入 `device-scale/station` → `createStation` → `POST /api/v1/miniapp/scale/stations`。
该接口对应的后端 `MiniappScaleStationController` 不在当前线上 jar（线上探测表现为带 token 500，而非 404）。后端代码在本分支 08-29 已合并（提交 481e59a/1bbd925），但服务器 jar 仍是 08-29 07:17 旧包——**缺的是后端打包发布，不是前端代码**。

前端可优化的健壮性点（后端就位后一并落地）：
- `createStation` 成功后立即 `refreshStation` 会并行 `getStation`+`getTodayQueue`，后端若队列接口超时会叠加报错；可改为首次创建用返回值直接渲染，仅轮询时再拉队列。
- `buildUserInfoFrame` 要求 age 为 0..255 整数、height 1..255；若队列患者缺身高/年龄，`callNext` 里 `configurePatient` 抛错会显示"下一位失败"。应显式提示"患者档案缺身高"，而非笼统失败。

**结论：此项需后端发布闭环，前端无独立修复空间。**

## 问题 1：呼气分析仪（Sunvou/TM2120）方向纠正

**现状错误**：`device-sunvou` + `sunvou-api` 走的是"医生输入 patientId → 从 `/api/v1/patients/{id}/reports` 查询"——这是我从参考工程 port 的"报告查询"方向。

**正确方向**（依《呼气分析仪系统对接说明》）：呼气分析仪是 **PC 软件（Sunvou Detector）**，医院信息系统（我们）**提供接口**，支持三种对接：
1. SQL Server / Oracle / MySQL 数据库直连（我们建表，厂商软件写库）
2. HTTP Api（我们暴露"获取信息/变更检查状态/上传报告/变更报告状态/上传文件"端点，厂商软件回调我们）
3. 本地 TXT/PDF/FTP 文件（厂商软件把报告文件推到我们 FTP/目录）

即：**厂商 PC 软件测试后主动推送报告到我们的平台**，医生端只读取已推送的报告，**不发起设备测试、也不实时调厂商系统**。

同文档目录下《接口文档针对经开的医院定制需求文档》里的 `xhx.jiaqiaokeji.com`（珈桥科技/正康）是另一家厂商的"平台侧查报告"接口（getReportListnoData / selectReport / chart），属备选对接形态，不是主方向。

**方案**：
- 设备目录中"Sunvou 呼气报告"入口改为**只读报告查看**：从我们自己的报告库读取（复用 `/api/v1/patients/{id}/reports`，即已部署的 DeviceReportController），明确标注"报告由厂商推送，医生端仅查看"。
- 后台侧（后端，不在小程序范围）新增厂商推送接收端点 + 报告落库：按文档 4.5 HTTP 契约实现"上传报告/上传文件"接收；或将厂商 SunvouConfig 配为提高报告状态后定时拉取。执行前需与你确认对接形态（DB 直连 vs HTTP 回调 vs FTP）。
- 移除"医生手动发起采集"的任何暗示。

## 问题 2：MFA-1 血糖仪改为与体脂秤一致的扫码签到流

**现状错误**：`device-mfa1` + `acquisition-api` 是"医生手动填 businessSessionId/orgId/patientRef → 创建采集会话 → 签 WSS 令牌"（参考工程的 MFA-1 采集会话模式）。不符合"连设备→扫码签到→叫号→测试→确认落库"。

**正确方向**：MFA-1 是 BLE 血糖仪（协议见《MFA-1 BLE 蓝牙通讯协议》：Service FFF0 / TX FFF6 / RX FFF7，16 字节帧 + 求和 CRC，测完自动推 0x78 结果帧），应复用体脂秤的**场次轮测机制**：
1. 医生创建场次 → 生成签到二维码（复用 `station` 机制，场次可标记设备类型 SCALE / MFA1）
2. 患者扫码签到进入队列（复用 `scale-checkin`，幂等、跨机构拒绝）
3. 医生"下一位"叫号 → 读队列患者信息 → 下发 MFA-1 无需性别/年龄/身高配置（血糖仪只需 0x01 时间同步即可）
4. BLE 连接 MFA-1 → 患者采血测试 → 设备自动推 0x78 结果 → 解析 GLU/UA/血脂/血压指标
5. 结果先存草稿，医生确认后落库到该患者血糖记录，完成队列项

**方案**：
- 新增 `services/mfa1Ble.js`（按 MFA-1 BLE 协议实现：FFE0/FFF6/FFF7，16 字节帧 CRC；结果帧 0x78 解析）——参照 `scaleBle.js` 结构，独立通道。
- `station-api` 与 backend `scale/stations` 契约改为**通用测量场次**（场次带 `deviceType`），或新增 `/api/v1/miniapp/measure-stations` 容 MFA-1；最小改动是让站台接口接受 `deviceType`，测量草稿指标按设备类型归一化。
- `device-mfa1` 页改为"创建场次 + 二维码 + 叫号 + 连接 MFA-1 + 结果确认"，与 station 页同构。
- `acquisition-api.js` 的 WSS 采集会话模式用于后续其他确有"代客采集"场景，MFA-1 主链路不再使用它。
- **后端改动**：测量场次需支持 MFA-1 设备类型 + 血糖指标落库（血糖记录表）。需与你确认后端契约。

## 问题 4：单人直接测量选患者不便（已实施）

已完成（纯前端，27/27 测试通过）：
- `utils/api.js` 的 `listDoctorPatients` 支持 `keyword` 参数（`/api/v1/patients?keyword=...`，与 H5 患者列表同契约）。
- `pages/device-scale/index.js` 增加搜索输入、按姓名/身份证/手机号 `keyword` 模糊搜索、分页加载更多（每页 20，下拉加载）、按 id 去重。
- `pages/device-scale/index.wxml/.wxss` 增加搜索框与"加载更多"入口。
- 新增 `test/patient-search.test.js` 锁定 keyword 契约与空白 keyword 忽略。

## 实施顺序建议

1. （已完成）问题 4 患者搜索。
2. 问题 3：后端发布 scale-stations（运维动作，前端随配健壮性小改）。
3. 问题 2：MFA-1 场次流（新增 mfa1Ble.js + station 契约扩展 + 后端血糖落库）——需确认后端契约后开发。
4. 问题 1：呼气报告改只读查看 + 后端推送接收端点——需先确认对接形态（DB/HTTP/FTP）。
