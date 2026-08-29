# MFA-1 小程序安全采集门面契约

版本：2026-08-30  
范围：`cdms-weixin` 原生 MFA-1 页面、`cdms` 认证门面、`cdms-iot` 内部采集会话服务

## 公网（小程序）接口

所有请求使用 `Authorization: Bearer <cdms access token>`，仅允许医生角色。小程序不接触 IoT client id、client secret、签名时间戳、nonce 或 HMAC signature。

| 操作 | CDMS 路径 | 请求 | 返回 |
|---|---|---|---|
| 创建 | `POST /api/v1/miniapp/iot/acquisition-sessions` | `businessSessionId`、`orgId`、`patientRef`、`traceId`、`expiresInSeconds` | `sessionId`、业务会话 ID、状态、过期时间、失败信息 |
| 查询 | `GET /api/v1/miniapp/iot/acquisition-sessions/{sessionId}` | 路径中的不透明字符串会话 ID | 会话状态 |
| 签发 WSS | `POST /api/v1/miniapp/iot/acquisition-sessions/{sessionId}/wss-token` | 无请求体 | 短时 `token`、`wssUrl`、过期时间 |
| 取消 | `POST /api/v1/miniapp/iot/acquisition-sessions/{sessionId}/cancel` | 可选 `reason` | 会话状态 |

服务端固定补充 `deviceType=MFA1`、`sourceChannel=BLE`，并以 JWT 机构和患者权限为准。创建时请求机构必须等于当前机构；患者必须存在且属于当前机构。有效期限制为 30–1800 秒。

## 内部（CDMS → cdms-iot）接口

CDMS 在服务端生成 `clientId`、秒级 timestamp、随机 nonce 和 HMAC-SHA256 signature，调用 `/v1/acquisition-sessions/**`。凭证来自服务端环境变量 `IOT_ACQUISITION_CLIENT_ID`、`IOT_ACQUISITION_CLIENT_SECRET`（可兼容已有 IoT report 配置），绝不进入小程序源代码、运行配置、日志或响应。

IoT 认证失败映射为安全的 502 业务错误；会话不存在为 404；会话冲突为 409；服务端凭证缺失为 503。错误响应不透传上游响应体或密钥。

## 配置

```yaml
iot:
  acquisition:
    base-url: ${IOT_ACQUISITION_BASE_URL:${IOT_REPORT_BASE_URL:http://localhost:9020}}
    client-id: ${IOT_ACQUISITION_CLIENT_ID:${IOT_REPORT_CLIENT_ID:}}
    client-secret: ${IOT_ACQUISITION_CLIENT_SECRET:${IOT_REPORT_CLIENT_SECRET:}}
```

开发环境缺少凭证时，采集调用必须失败闭合，不得返回 mock 成功结果。
