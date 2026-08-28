# 2026-08-28 Miniapp API Matrix

## Scope

- Task 1 output for `feature/full-native-miniapp`.
- Consumers: `patient-api.js`, `followup-api.js`, `monitoring-api.js`, `report-api.js`, `station-api.js`.
- Evidence base: inspected `cdms/backend/src/main/java/com/cdms/followup/controller/*` and `cdms-iot/core/src/main/java/com/cdms/iot/core/*`.
- Public screening route distinction is explicit: `/api/v1/screening/h5/*` belongs to `cdmsManager`, not `cdms` followup.
- Evidence base for screening routes: inspected `cdmsManager/backend/src/main/java/com/cdms/manager/controller/ScreeningController.java` including `h5Questions`, `h5Organizations`, and `h5Submit`.

## H5 To Native Replacement

- `/h5/patients -> /pages/doctor/workspace/index`
- `/h5/followups -> /pages/followups/index`
- `PatientDetail -> /pages/patient-detail/index`
- `Patient360 -> /pages/patient-360/index`
- `MonitoringDetail -> /pages/monitoring/index`
- `Messages -> /pages/messages/index`
- `Statistics -> /pages/statistics/index`
- `History/Reports -> /pages/reports/index`
- `体脂秤工作站 -> /pages/device-scale/station/index`

## Cross-Cutting Contract Rules

- 所有路径参数和请求体中的患者、机构、任务、报告、设备会话 ID 均使用 String。
- Later task adapters must expose the same endpoint intent and stable field names documented here.
- CDMS Java controllers currently bind many IDs as `Long`; the miniapp adapter layer must stringify them at the boundary and never coerce them to JavaScript `Number`.
- `HandoffRedeemVO.UserInfo.orgId` already proves the transport rule: `机构 ID 以字符串传输，避免 19 位雪花 ID 在前端精度丢失`。
- 脱敏 rule: miniapp pages, logs, route params, storage payloads, clipboard text, and analytics payloads must not expose raw patient identity fields, WeChat identifiers, wearable tokens, refresh tokens, or report short URLs.
- Common error expectations to preserve in client handling: `400` invalid request, `401` auth/session invalid, `403` role or org scope denied, `404` missing resource, `5xx` service failure.
- Report/file short URLs are transient only: `expiresInSeconds` is clamped to `1-300 秒`, and the short URL response must be treated as memory-only.
- 短时地址只在当前内存中使用，不得写入 URL、Storage、日志、埋点或剪贴板。

## Auth Session Semantics Locked For Later Tasks

- Task 1 only documents these semantics; it does not implement production auth code.
- `Refresh Token survives network, timeout and 5xx`.
- `concurrent 401 uses one single-flight refresh`.
- `each request retries once`.
- `role switch preserves account session while clearing role/device context`.
- Route anchors for these semantics remain the already documented auth surface:
  - `POST /api/v1/miniapp/auth/refresh`
  - `POST /api/v1/miniapp/auth/switch-role`
  - `POST /api/v1/miniapp/auth/logout`
  - `GET /api/v1/miniapp/auth/me`
- Required client behavior for later tasks:
  - network, timeout, and `5xx` must not clear stored refresh credentials;
  - a burst of `401` responses must share one refresh promise;
  - each original request may retry at most once after a successful refresh;
  - role switch keeps account session primitives such as `refreshToken`, `identityId`, and `roles`, while clearing role-scoped patient/task/device context.

## Exact Route Inventory

- `POST /api/v1/miniapp/auth/login`
- `POST /api/v1/miniapp/auth/doctor-login`
- `POST /api/v1/miniapp/auth/switch-role`
- `POST /api/v1/miniapp/auth/refresh`
- `POST /api/v1/miniapp/auth/logout`
- `GET /api/v1/miniapp/auth/me`
- `GET /api/v1/patients`
- `GET /api/v1/patients/{id}`
- `POST /api/v1/patients`
- `PUT /api/v1/patients/{id}`
- `DELETE /api/v1/patients/{id}`
- `POST /api/v1/patients/duplicate-check`
- `GET /api/v1/patients/{patientId}/followups`
- `GET /api/v1/followups/{id}`
- `GET /api/v1/followups/my`
- `POST /api/v1/followups`
- `POST /api/v1/followups/draft`
- `PUT /api/v1/followups/{id}`
- `DELETE /api/v1/followups/{id}`
- `GET /api/v1/patients/{patientId}/360`
- `GET /api/v1/patients/{patientId}/monitoring/summary`
- `GET /api/v1/patients/{patientId}/monitoring/trends`
- `GET /api/v1/patients/{patientId}/monitoring/alerts`
- `POST /api/v1/monitoring/alerts/{alertId}/acknowledge`
- `GET /api/v1/messages`
- `GET /api/v1/messages/unread-count`
- `POST /api/v1/messages/{id}/read`
- `POST /api/v1/messages/read-all`
- `GET /api/v1/stats/home`
- `GET /api/v1/stats/detail`
- `GET /api/v1/stats/my-followups`
- `GET /api/v1/stats/my`
- `GET /api/v1/patients/{patientId}/reports`
- `POST /api/v1/patients/{patientId}/reports/{reportId}/access-url`
- `POST /api/v1/patients/{patientId}/reports/files/{fileId}/access-url`
- `GET /api/v1/ai/report/patient/{patientId}`
- `POST /api/v1/ai/report/patient/{patientId}/stream`
- `GET /api/v1/ai/report/org/{orgId}`
- `POST /api/v1/ai/report/org/{orgId}/stream`
- `POST /api/v1/ai/report/{reportId}/confirm`
- `POST /api/v1/miniapp/iot/wearable-session`
- `DELETE /api/v1/miniapp/iot/wearable-session`
- `POST /api/v1/miniapp/iot/scale/measurements`
- `POST /v1/wearable-sessions`
- `POST /v1/wearable-upload-batches`
- `GET /v1/measurements`
- `POST /v1/acquisition-sessions`
- `GET /v1/acquisition-sessions/{sessionId}`
- `GET /v1/reports`
- `GET /api/v1/screening/h5/questions`
- `GET /api/v1/screening/h5/organizations`
- `POST /api/v1/screening/h5/submit`

## Matrix

| Domain | Role/Page | Method | Path | Request Fields | Response Fields | Permission / Scope | Errors | Server Gap |
| --- | --- | --- | --- | --- | --- | --- | --- | --- |
| Auth | patient login page | POST | `/api/v1/miniapp/auth/login` | `phone`, optional `wxCode`; miniapp keeps identity IDs as String | `token`, `refreshToken`, `tokenExpireTime`, `identityId`, `activeRole`, `roleSelectionRequired`, `roles[]` | miniapp public login | `400`, `401`, `403` | No |
| Auth | doctor login page | POST | `/api/v1/miniapp/auth/doctor-login` | `username`, `password` | same `MiniappSessionVO` | miniapp public login | `400`, `401`, `403` | No |
| Auth | role switch | POST | `/api/v1/miniapp/auth/switch-role` | `roleType` | same `MiniappSessionVO` | authenticated identity only; server derives identity from JWT | `400`, `401`, `403` | No |
| Auth | token refresh | POST | `/api/v1/miniapp/auth/refresh` | `refreshToken` | same `MiniappSessionVO` | refresh token owner only | `400`, `401` | No |
| Auth | logout | POST | `/api/v1/miniapp/auth/logout` | none | success envelope | authenticated identity only | `401` | No |
| Auth | session bootstrap | GET | `/api/v1/miniapp/auth/me` | none | `identityId`, `activeRole`, `principalId`, `patientId`, `orgId` | authenticated identity only | `401` | No |
| Auth | client-side policy lock only | POST | `/api/v1/miniapp/auth/refresh` | no new payload in Task 1 | existing `MiniappSessionVO` contract only | Task 1 documentation only; no production auth change here | `401`, `5xx` | No |
| Auth | client-side policy lock only | POST | `/api/v1/miniapp/auth/switch-role` | no new payload in Task 1 | existing `MiniappSessionVO` contract only | Task 1 documentation only; role switch keeps account session and clears role/device context later in client code | `400`, `401`, `403` | No |
| Patient | doctor workspace list | GET | `/api/v1/patients` | query DTO; later adapter should use String IDs in params such as `orgId`, keyword, page fields | `PageResult<PatientListVO>` | doctor/org scope only; patient role blocked | `400`, `403` | No |
| Patient | patient detail page | GET | `/api/v1/patients/{id}` | `{id}` as String client path param | `PatientDetailVO` | patient can only read self; doctor scoped by service | `403`, `404` | No |
| Patient | doctor archive create | POST | `/api/v1/patients` | `PatientSaveDTO` with nested `basicInfo`, `smokeInfo`, `lungFunction`, `copdInfo`, `allergies`, `dustExposures`; client sends `basicInfo.orgId`, `serveOrgId`, `createOrgId` as String | created data contains `id`, `message` | doctor only | `400`, `403` | No |
| Patient | doctor archive update | PUT | `/api/v1/patients/{id}` | `{id}` as String plus same `PatientSaveDTO` | success envelope | doctor only | `400`, `403`, `404` | No |
| Patient | doctor archive delete | DELETE | `/api/v1/patients/{id}` | `{id}` as String | `message` | doctor only | `403`, `404` | No |
| Patient | doctor archive duplicate check | POST | `/api/v1/patients/duplicate-check` | `basicInfo` body; optional `excludeId` must be String in adapter | duplicate-check result map | doctor only | `400`, `403` | No |
| Followup | doctor patient list | GET | `/api/v1/patients/{patientId}/followups` | `{patientId}` as String; query `page`, `page_size`, `visit_type`, `start_date`, `end_date` | followup list map | authenticated role; patient-specific restriction handled upstream by flow | `400`, `403`, `404` | No |
| Followup | detail page | GET | `/api/v1/followups/{id}` | `{id}` as String | `FollowUpDetailVO` | authenticated | `403`, `404` | No |
| Followup | patient personal history | GET | `/api/v1/followups/my` | query `page`, `page_size`, `visit_type`, `start_date`, `end_date` | followup list map | authenticated operator context | `400`, `401` | No |
| Followup | doctor create | POST | `/api/v1/followups` | `FollowUpSaveDTO`: `patientId`, `visitDate`, `visitType`, `patientStatus`, CAT, mMRC, medications, photos, COPD snapshot; client keeps `patientId` as String | created map | authenticated clinical flow | `400`, `403` | No |
| Followup | doctor draft save | POST | `/api/v1/followups/draft` | partial `FollowUpSaveDTO` | draft result map | authenticated | `400`, `403` | No |
| Followup | doctor update | PUT | `/api/v1/followups/{id}` | `{id}` as String plus `FollowUpSaveDTO` | success envelope | authenticated | `400`, `403`, `404` | No |
| Followup | doctor delete | DELETE | `/api/v1/followups/{id}` | `{id}` as String | success envelope | authenticated | `403`, `404` | No |
| Patient360 | patient 360 page | GET | `/api/v1/patients/{patientId}/360` | `{patientId}` as String; optional `followupPage` | 360 aggregate map | patient self only or doctor scoped | `403`, `404` | No |
| Monitoring | monitoring summary | GET | `/api/v1/patients/{patientId}/monitoring/summary` | `{patientId}` as String | `PatientMonitoringSummaryVO` | authenticated patient self / doctor scope | `403`, `404` | No |
| Monitoring | monitoring trends | GET | `/api/v1/patients/{patientId}/monitoring/trends` | `{patientId}` as String; `range=7d|30d` | `PatientMonitoringTrendVO` | authenticated patient self / doctor scope | `400`, `403` | No |
| Monitoring | monitoring alerts | GET | `/api/v1/patients/{patientId}/monitoring/alerts` | `{patientId}` as String; `page`, `pageSize` | `PageResult<MonitorAlertVO>` | authenticated patient self / doctor scope | `403`, `404` | No |
| Monitoring | alert acknowledge | POST | `/api/v1/monitoring/alerts/{alertId}/acknowledge` | `{alertId}` as String | success envelope | authenticated clinician flow | `403`, `404` | No |
| Messages | messages page | GET | `/api/v1/messages` | `page`, `pageSize` | `PageResult<UserMessageVO>` | authenticated | `401` | No |
| Messages | unread badge | GET | `/api/v1/messages/unread-count` | none | `{count}` | authenticated | `401` | No |
| Messages | mark read | POST | `/api/v1/messages/{id}/read` | `{id}` as String | success envelope | authenticated | `401`, `404` | No |
| Messages | mark all read | POST | `/api/v1/messages/read-all` | none | success envelope | authenticated | `401` | No |
| Stats | doctor home | GET | `/api/v1/stats/home` | none | `HomeStatsVO` | doctor only | `403` | No |
| Stats | doctor detail | GET | `/api/v1/stats/detail` | `month`, `org_id` as String in adapter | `StatsDetailVO` | doctor only | `400`, `403` | No |
| Stats | my followups | GET | `/api/v1/stats/my-followups` | `start_date`, `end_date` | `MyFollowupStatsVO` | authenticated operator context | `400` | No |
| Stats | my stats | GET | `/api/v1/stats/my` | none | `MyStatsVO` | authenticated | `401` | No |
| Reports | standard report list | GET | `/api/v1/patients/{patientId}/reports` | `{patientId}` as String; `category`, `cursor`, `page`, `pageSize` | `items`, `page`, `pageSize`, `nextCursor`, `hasMore` | patient self / doctor scope via CDMS | `400`, `403`, `404` | No |
| Reports | report short URL | POST | `/api/v1/patients/{patientId}/reports/{reportId}/access-url` | `{patientId}`, `{reportId}` as String; query `expirySeconds`, `purpose` | `url`, `expiresInSeconds` | patient self / doctor scope via CDMS | `400`, `403`, `404` | No |
| Reports | file short URL | POST | `/api/v1/patients/{patientId}/reports/files/{fileId}/access-url` | `{patientId}`, `{fileId}` as String; query `expirySeconds`, `purpose` | `url`, `expiresInSeconds` | patient self / doctor scope via CDMS | `400`, `403`, `404` | No |
| AI Reports | patient latest report | GET | `/api/v1/ai/report/patient/{patientId}` | `{patientId}` as String | `AiReportResultVO` or `null` | `requirePatientSelf` | `403`, `404` | No |
| AI Reports | patient generation stream | POST | `/api/v1/ai/report/patient/{patientId}/stream` | `{patientId}` as String | SSE stream, server timeout 120s | `requirePatientSelf` | `403`, `404`, `5xx` | No |
| AI Reports | org latest report | GET | `/api/v1/ai/report/org/{orgId}` | `{orgId}` as String; optional `period` | `AiReportResultVO` or `null` | doctor only | `403`, `404` | No |
| AI Reports | org generation stream | POST | `/api/v1/ai/report/org/{orgId}/stream` | `{orgId}` as String; optional `period` | SSE stream | doctor only | `403`, `404`, `5xx` | No |
| AI Reports | doctor confirm | POST | `/api/v1/ai/report/{reportId}/confirm` | `{reportId}` as String; body `confirmed`, `doctorRemark` | `AiReportResultVO` | doctor only | `400`, `403`, `404` | No |
| Miniapp wearable | patient wearable session create | POST | `/api/v1/miniapp/iot/wearable-session` | body `deviceRef`, optional `sessionId` | IoT session response | patient role only; server derives `orgId`, `patientId`, `principalId` from JWT | `400`, `403` | No |
| Miniapp wearable | patient wearable session release | DELETE | `/api/v1/miniapp/iot/wearable-session` | query `deviceRef` | success envelope | patient role only | `400`, `403` | No |
| Miniapp scale | doctor measurement submit | POST | `/api/v1/miniapp/iot/scale/measurements` | `patientId`, `deviceId`, `measuredAt`, `confirmed`, `gender`, `age`, `height`, `metrics[]` | `{status}` | authenticated scale flow; patient identity should not be inferred from URL | `400`, `403` | Partial: submit exists, full station contract missing |
| IoT wearable | reusable protected wearable session | POST | `/v1/wearable-sessions` | `clientId`, `timestamp`, `nonce`, `signature`, `sessionId`, `orgId`, `patientRef`, `deviceRef`, `actorType`, `actorId`, `bindingMode`, `allowHistory`, `expiresInSeconds` | `WearableSessionView` | `wearable` or `admin` scope; org-checked | `400`, `401`, `403` | No |
| IoT wearable | batch upload | POST | `/v1/wearable-upload-batches` | bearer or `X-Wearable-Token`; upload batch body | `{accepted, duplicates, rejected}` | valid wearable token | `400`, `401`, `403` | No |
| IoT data | protected measurement query | GET | `/v1/measurements` | `patientRef`, optional `orgId`, `types`, `from`, `to`, `limit` | `latest`, `trend`, `daily` | `wearable`, `reports`, or `admin` scope | `400`, `401`, `403` | No |
| IoT acquisition | session create | POST | `/v1/acquisition-sessions` | signed body with `businessSessionId`, `orgId`, `patientRef`, `deviceType`, `sourceChannel`, `traceId`, optional `expiresInSeconds` | `AcquisitionSessionResponse` | `acquisition` or `admin` scope | `400`, `401`, `403` | No |
| IoT acquisition | session lookup | GET | `/v1/acquisition-sessions/{sessionId}` | `{sessionId}` as String | `AcquisitionSessionResponse` | `acquisition` or `admin` scope | `401`, `403`, `404` | No |
| IoT reports | protected report list | GET | `/v1/reports` | `patientId` or `orgId`, `category`, `cursor`, `limit` | `items`, `nextCursor` | `reports` scope; unscoped callers also need `reports:global` | `400`, `401`, `403` | No |

## Protected Station-Contract Gap

- Existing `POST /api/v1/checkins?patientId=...` is a queue helper only.
- `POST /api/v1/checkins?patientId=...` and related `/api/v1/checkins/{patientId}/select` or `/complete` directly carry patient identity and therefore `不满足扫码后由令牌派生患者身份的要求`.
- Existing `/api/v1/checkins?patientId=...` is not an acceptable formal QR flow and must not be used by the full-native miniapp as the production station path.
- Required replacement is a `受保护的 /api/v1/miniapp/scale/stations* 契约缺口`.
- The protected station contract must include station create/query, opaque `checkinToken` sign-in, queue query, call next, skip, requeue, measurement draft, confirm, and close.
- Doctor actions are org-authorized. Patient sign-in must derive patient identity from the authenticated login token, not from query/body patient IDs.
- Fixed server implementation target: `cdms/backend/src/main/java/com/cdms/followup/controller/MiniappScaleStationController.java`, matching DTO/Service/Mapper, database migration, and `MiniappScaleStationControllerTest`.
- Only after contract tests plus server authorization/transaction tests pass can `Task 7 才能接入小程序`.

## Public Screening Contract To Preserve

- Real public route owner is `cdmsManager`, not `cdms` followup.
- Verified source: `D:\aiProject\workspace-opc\cdmsManager\backend\src\main\java\com\cdms\manager\controller\ScreeningController.java`.
- Verified public routes: `GET /api/v1/screening/h5/questions`, `GET /api/v1/screening/h5/organizations`, `POST /api/v1/screening/h5/submit`.
- Related manager-only routes such as `/api/v1/screening/h5/context` and `/api/v1/screening/h5/token` exist in the same controller, but Task 1 only freezes the three public routes required by the brief.
- Questionnaire invariant: `7 题 COPD-SQ`.
- Server scoring invariant: `totalScore >= 16` means high risk.
- Organization selection invariant: `启用机构选择`.
- Submission invariant: `提交时机构状态校验`.
- Miniapp rule: the miniapp does not embed the questionnaire; it only shows or copies the fixed public URL.

## Client Invariants Locked For Later Tasks

- Example payload:

```js
const payload = { patientId: '768495013408443', orgId: '1972545374712086529' }
```

- `typeof payload.patientId === 'string'`
- `typeof payload.orgId === 'string'`
- `encodeURIComponent(payload.patientId) === '768495013408443'`
- Route builders, request serializers, storage snapshots, and page state must preserve these IDs as strings end to end.
