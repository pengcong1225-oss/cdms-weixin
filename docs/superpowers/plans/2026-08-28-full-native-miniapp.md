# 全量原生小程序 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (- [ ]) syntax for tracking.

**Goal:** 在 D:\codex\worktrees\cdms-weixin-full-native 中把 CDMS 移动端业务迁移为全量原生微信小程序，复用当前患者工作台视觉体系和服务端能力，保留公共建档问卷这一唯一外部 H5 例外，并实现显式退出才清除的持续登录。

**Architecture:** cdms-weixin 是唯一移动端发布工程，按认证基础、视觉与路由壳、医患业务、随访/监测/报告、设备工作站五个独立子项目推进。小程序通过分层 API 适配器调用 cdms 的业务接口和 cdms-iot 的设备/报告接口；客户端只做交互校验，机构范围、身份归属、报告匹配、设备授权和临床状态继续由服务端决定。所有业务入口改为原生页面，公共建档问卷仅显示固定地址并复制到剪贴板，不进入 WebView。

**Tech Stack:** 微信原生小程序 JavaScript/WXML/WXSS；现有 wx.request、wx.uploadFile、BLE 服务和 cdms-weixin Node 测试；CDMS Spring Boot API、CDMS IoT API、现有设备协议和报告同步链路。

**Spec:** docs/superpowers/specs/2026-08-27-native-scale-station-design.md

## Global Constraints

- cdms-weixin 是移动端唯一发布工程和主要实施仓库。
- 正式业务链路不得使用 H5 或 WebView；通用公开建档问卷是唯一允许保留的外部 H5 例外，且只展示或复制固定公开地址。
- 视觉权威源是 miniprogram/app.wxss、miniprogram/pages/home/home.* 和现有原生设备卡片，不采用旧 CDMS H5/Vant 的视觉体系。
- 当前服务端是业务事实和数据规则的主要来源；优先复用现有接口、权限、数据表、设备协议和报告同步能力。
- 小程序不得复制服务端计分、身份归属、机构范围、设备授权、报告匹配或临床状态规则。
- 所有患者、机构、任务、报告、设备会话和雪花 ID 按字符串处理，禁止 JavaScript Number 转换。
- 患者个人信息、微信标识、令牌、设备密钥和报告短时地址不得写入 URL、普通日志、埋点或错误提示。
- Refresh Token 持久化，Access Token 优先内存化；网络断开、超时和 5xx 不清除登录态，只有显式退出主动清除。
- 401 并发请求使用单例刷新锁，每个原请求最多重试一次；服务端吊销、禁用或撤销角色时允许强制重新登录。
- 角色切换只清除角色相关患者、任务和设备上下文，不清除账号登录凭据。
- 身高体脂秤使用独立 ScaleBle，不得修改或复用指环 bleManager 的状态。
- 本计划每个任务完成后先运行定向测试，再单独提交；不把 H5 迁移、服务端扩展和无关重构混在同一提交。

---

## 子项目与文件地图

认证与请求层：

- 修改 miniprogram/app.js、miniprogram/utils/api.js、miniprogram/pages/auth/login.js、miniprogram/utils/role-entry.js。
- 新增 miniprogram/utils/session-store.js、miniprogram/utils/auth-guard.js。
- 测试 test/auth-persistent-session.test.js、test/auth-error-policy.test.js，并扩展现有 auth-refresh-regression.test.js。

视觉与原生壳：

- 修改 miniprogram/app.wxss、miniprogram/app.json、miniprogram/pages/home/home.*、miniprogram/utils/workspace-entry.js。
- 新增原生公共组件：miniprogram/components/app-header、workspace-card、patient-card、stat-card、status-tag、form-section、choice-tile、state-panel、bottom-action-bar。
- 新增 miniprogram/pages/doctor/workspace 与 miniprogram/pages/patient/workspace。
- 页面迁移完成后删除 miniprogram/pages/h5。
- 测试 test/native-design-system.test.js、test/native-route-contract.test.js。

业务页面与 API：

- 新增 miniprogram/utils/patient-api.js、followup-api.js、message-api.js、stats-api.js、monitoring-api.js、report-api.js、station-api.js、acquisition-api.js、sunvou-api.js。
- 新增患者列表、患者详情、患者 360、随访、消息、统计、监测、报告、MFA-1、Sunvou 和医生设备工作站页面。
- 保留 miniprogram/services/bleManager.js、miniprogram/utils/cdms-bridge.js 的指环职责和既有行为。

服务端契约基线：

- cdms 已有认证、患者、随访、360、监测、消息、统计、报告、AI 报告和小程序体脂秤接口。
- cdms-iot 已有指环会话/上传、测量/告警、采集会话和报告接口。
- cdmsManager 只用于设备配置、运维和未匹配报告处理，普通小程序用户不直接调用 Manager 管理接口。

---

## Task 1: 建立接口契约与迁移清单

**Files:**

- Create: docs/superpowers/contracts/2026-08-28-miniapp-api-matrix.md
- Create: test/native-api-contract.test.js
- Read: D:\aiProject\workspace-opc\cdms\backend\src\main\java\com\cdms\followup\controller
- Read: D:\aiProject\workspace-opc\cdms-iot\core\src\main\java\com\cdms\iot\core

**Interfaces:**

- Produces: 按角色、页面、HTTP 方法、路径、请求字段、响应字段、权限范围、错误码和是否需要服务端补契约组织的矩阵。
- Later tasks consume: patient-api.js、followup-api.js、monitoring-api.js、report-api.js、station-api.js 中与矩阵一致的函数名和字段名。
- IDs: 所有路径参数和请求体中的患者、机构、任务、报告、设备会话 ID 均使用 String。

- [ ] Step 1: 写当前 H5 到原生页面的替换关系。

    /h5/patients -> /pages/doctor/workspace/index
    /h5/followups -> /pages/followups/index
    PatientDetail -> /pages/patient-detail/index
    Patient360 -> /pages/patient-360/index
    MonitoringDetail -> /pages/monitoring/index
    Messages -> /pages/messages/index
    Statistics -> /pages/statistics/index
    History/Reports -> /pages/reports/index
    体脂秤工作站 -> /pages/device-scale/station/index

- [ ] Step 2: 在契约矩阵固定现有接口。

    认证：POST /api/v1/miniapp/auth/login、doctor-login、switch-role、refresh、logout，GET /api/v1/miniapp/auth/me。
    患者：GET/POST/PUT/DELETE /api/v1/patients、GET /api/v1/patients/{id}、POST /api/v1/patients/duplicate-check。
    随访：GET /api/v1/patients/{patientId}/followups、GET /api/v1/followups/{id}、GET /api/v1/followups/my、POST /api/v1/followups、POST /api/v1/followups/draft、PUT/DELETE /api/v1/followups/{id}。
    360/监测：GET /api/v1/patients/{patientId}/360、monitoring/summary、monitoring/trends、monitoring/alerts，POST /api/v1/monitoring/alerts/{alertId}/acknowledge。
    消息/统计：GET /api/v1/messages、unread-count，POST /api/v1/messages/{id}/read、read-all，GET /api/v1/stats/home、detail、my-followups、my。
    报告：GET /api/v1/patients/{patientId}/reports，POST report/file access-url，GET /api/v1/ai/report/patient/{patientId}、/org/{orgId}，POST /api/v1/ai/report/patient/{patientId}/stream、/org/{orgId}/stream 和 /api/v1/ai/report/{reportId}/confirm。
    设备：POST/DELETE /api/v1/miniapp/iot/wearable-session，POST /api/v1/miniapp/iot/scale/measurements；现有 /api/v1/checkins 直接接收 patientId，不满足扫码后由令牌派生患者身份的要求，必须在契约矩阵中标为服务端缺口。cdms-iot 的 /v1/wearable-sessions、/v1/wearable-upload-batches、/v1/measurements、/v1/acquisition-sessions 和 /v1/reports 继续复用。
    公共建档问卷：继续使用 /api/v1/screening/h5/questions、/organizations、/submit 现有公开接口；固定核对 7 题 COPD-SQ、服务端 totalScore >= 16 高危规则、启用机构选择和提交时机构状态校验。小程序不嵌入问卷，只复制固定公开地址。

- [ ] Step 3b: 明确体脂秤场次服务端契约缺口。

    在 cdms 中新增受保护的 /api/v1/miniapp/scale/stations* 契约设计，至少包括场次创建/查询、使用不透明 checkinToken 的签到、队列查询、叫号、跳过、重新排队、测量草稿、确认和关闭。医生操作按机构授权，患者签到从登录令牌派生 patientRef；不得继续让小程序调用 /api/v1/checkins?patientId=... 作为正式方案。

    该缺口的服务端实施文件固定为 cdms/backend/src/main/java/com/cdms/followup/controller/MiniappScaleStationController.java、对应 DTO/Service/Mapper、数据库迁移和 MiniappScaleStationControllerTest；只有契约测试和服务端授权/事务测试通过后，Task 7 才能接入小程序。

- [ ] Step 3: 写契约断言，锁定字符串 ID、脱敏字段、错误码和报告短时地址的生命周期。

    const payload = { patientId: '768495013408443', orgId: '1972545374712086529' }
    assert.equal(typeof payload.patientId, 'string')
    assert.equal(typeof payload.orgId, 'string')
    assert.equal(encodeURIComponent(payload.patientId), '768495013408443')

- [ ] Step 4: 运行并提交。

    Run: node --test test/native-api-contract.test.js
    Expected: PASS，矩阵中所有迁移路由和 ID 规则均有断言。

    git add docs/superpowers/contracts/2026-08-28-miniapp-api-matrix.md test/native-api-contract.test.js
    git commit -m "docs: define native miniapp api contract matrix"

---

## Task 2: 完成持续登录、刷新锁和退出清理

**Files:**

- Modify: miniprogram/app.js、miniprogram/utils/api.js、miniprogram/pages/auth/login.js、miniprogram/utils/role-entry.js
- Create: miniprogram/utils/session-store.js、miniprogram/utils/auth-guard.js
- Test: test/auth-persistent-session.test.js、test/auth-error-policy.test.js
- Modify test: test/auth-refresh-regression.test.js、test/auth-role-switch-regression.test.js

**Interfaces:**

- session-store.js: readAuth(): AuthSnapshot|null、writeAuth(snapshot): void、clearAuth(): void。
- auth-guard.js: ensureSession({ role, redirect = true }): Promise<AuthSnapshot>。
- api.js: refreshAccessToken(): Promise<string>、cdmsRequest(path, method, data, token): Promise<any>；单次请求最多刷新并重试一次。
- app.js: restoreAuth(): AuthSnapshot|null、saveAuth(session): void、clearRoleContext(): void、clearAuth(): void。
- AuthSnapshot 至少包含字符串 refreshToken、identityId、activeRole、roles、patientRef 和 cdmsBaseUrl。
- Test helpers: shouldClearAuth(error): boolean、restoreFromStorage(snapshot): Promise<AuthSnapshot>、createMockRequest(options): MockRequest、switchRoleContext(snapshot, roleType): AuthSnapshot；这些辅助函数在对应测试文件内定义，不进入生产 API。

- [ ] Step 1: 先写异常策略失败测试。

    test('network, timeout and 5xx retain refresh token', () => {
      const auth = { refreshToken: 'refresh-1', identityId: 'identity-1', activeRole: 'PATIENT' }
      assert.equal(shouldClearAuth({ kind: 'NETWORK', auth }), false)
      assert.equal(shouldClearAuth({ kind: 'TIMEOUT', auth }), false)
      assert.equal(shouldClearAuth({ kind: 'HTTP', statusCode: 500, auth }), false)
      assert.equal(shouldClearAuth({ kind: 'HTTP', statusCode: 401, code: 'TOKEN_REVOKED', auth }), true)
    })

- [ ] Step 2: 写启动恢复和刷新并发测试。

    test('restart restores from refresh token without login form', async () => {
      const result = await restoreFromStorage({ refreshToken: 'refresh-1' })
      assert.equal(result.activeRole, 'PATIENT')
      assert.equal(result.refreshToken, 'refresh-2')
    })

    test('concurrent 401 requests share one refresh promise', async () => {
      const result = await Promise.all([request('/api/v1/patients'), request('/api/v1/messages')])
      assert.deepEqual(result.map(item => item.status), [200, 200])
      assert.equal(refreshCalls, 1)
    })

- [ ] Step 3: 实现持久化和启动顺序。

    onLaunch(options) {
      const snapshot = sessionStore.readAuth()
      this.restoreAuth(snapshot)
      this.applyBridgeQuery(options && options.query)
      this.restoreSessionInBackground()
      this.initNativeServices()
    }

    Access Token 只放运行态；Refresh Token 和身份快照写入 cdms.miniapp.auth。启动静默刷新成功后更新 Access Token、轮换后的 Refresh Token、角色和 patientRef。网络失败保留已有快照，服务端明确返回 TOKEN_REVOKED、ACCOUNT_DISABLED、ROLE_REVOKED 或 CREDENTIAL_CHANGED 时才进入登录页。

- [ ] Step 4: 实现单例刷新锁和角色上下文清理。

    function shouldClearAuth(error) {
      return error && error.statusCode === 401 &&
        ['TOKEN_REVOKED', 'ACCOUNT_DISABLED', 'ROLE_REVOKED', 'CREDENTIAL_CHANGED'].includes(error.code)
    }

    401 刷新成功后所有等待请求各自只重试一次；刷新失败按网络错误与服务端明确失效分类。切换角色保留 refreshToken、identityId 和 roles，清空旧 patientRef、taskId、wearableToken、wearableSessionId 和设备上下文。

- [ ] Step 5: 实现显式退出。

    用户确认退出后立即 sessionStore.clearAuth()、app.clearRoleContext()，再尽力调用 POST /api/v1/miniapp/auth/logout，最后执行 bleManager.unbind() 并 wx.reLaunch({ url: '/pages/auth/login' })。服务端登出失败不能恢复本地凭据。

- [ ] Step 6: 运行并提交。

    Run: node --test test/auth-persistent-session.test.js test/auth-error-policy.test.js test/auth-refresh-regression.test.js test/auth-role-switch-regression.test.js
    Expected: PASS，覆盖重启恢复、并发刷新、网络异常保留、服务端吊销强退、显式退出和角色切换。

    git add miniprogram/app.js miniprogram/utils/api.js miniprogram/utils/session-store.js miniprogram/utils/auth-guard.js miniprogram/pages/auth/login.js miniprogram/utils/role-entry.js test/auth-persistent-session.test.js test/auth-error-policy.test.js test/auth-refresh-regression.test.js test/auth-role-switch-regression.test.js
    git commit -m "feat: harden persistent miniapp session"

---

## Task 3: 建立原生视觉组件和角色路由壳

**Files:**

- Modify: miniprogram/app.wxss、miniprogram/app.json、miniprogram/pages/home/home.*、miniprogram/utils/workspace-entry.js
- Create: miniprogram/components/app-header、workspace-card、patient-card、stat-card、status-tag、form-section、choice-tile、state-panel、bottom-action-bar
- Create: miniprogram/pages/doctor/workspace/index.*、miniprogram/pages/patient/workspace/index.*
- Delete after route migration: miniprogram/pages/h5/*
- Test: test/native-design-system.test.js、test/native-route-contract.test.js

**Interfaces:**

- getRoleEntry('DOCTOR') returns { type: 'NATIVE', url: '/pages/doctor/workspace/index' }。
- getRoleEntry('PATIENT') returns { type: 'NATIVE', url: '/pages/patient/workspace/index' }。
- getWorkspaceEntries only returns NATIVE entries or a public questionnaire copy action；不返回 H5 业务入口。
- Shared components receive plain serializable properties and emit named events；业务组件不接受 H5 URL 作为目的地。
- app.wxss exports --cdms-primary、--cdms-primary-soft、--cdms-surface、--cdms-text、--cdms-muted、--cdms-radius-card: 28rpx 和状态色。

- [ ] Step 1: 写路由与视觉契约测试。

    test('business role entries are native', () => {
      assert.equal(getRoleEntry('DOCTOR').type, 'NATIVE')
      assert.equal(getRoleEntry('PATIENT').type, 'NATIVE')
      assert.equal(getWorkspaceEntries('DOCTOR').some(item => item.type === 'H5'), false)
      assert.equal(getWorkspaceEntries('PATIENT').some(item => item.type === 'H5'), false)
    })

- [ ] Step 2: 把当前患者工作台视觉值集中到 app.wxss。

    沿用当前主色 #0c9b6c、浅色 #e5f6ee、背景 #f3f7f5、卡片圆角 28rpx、白色卡片、柔和阴影、胶囊状态、表单输入和标题层级。公共组件只使用变量；医生端和患者端使用同一套视觉语言。

- [ ] Step 3: 实现公共组件契约。

    app-header: title, subtitle, showBack, showLogout；事件 back、logout。
    workspace-card: title, subtitle, icon, disabled；事件 select。
    patient-card: patient, masked；事件 select。
    stat-card: title, value, caption, tone。
    status-tag: text, tone。
    form-section: title, caption。
    choice-tile: options, value, multiple；事件 change。
    state-panel: state, title, message, actionText；事件 action。
    bottom-action-bar: primaryText, secondaryText, loading；事件 primary、secondary。

- [ ] Step 4: 替换角色入口。

    患者首页保留指环设备卡片、健康卡片、下拉同步和退出按钮；医生进入医生原生工作台。删除业务代码中的 createHandoff、openCdmsWorkspace、redirectDoctorWorkspace 和 pages/h5 跳转。

- [ ] Step 5: 删除 WebView 业务页面并固定公共问卷地址。

    确认 rg -n "web-view|pages/h5|createHandoff|targetPath.*h5" miniprogram 只剩测试或公共问卷说明中的文字。移除 pages/h5 注册和目录。公共问卷只使用：

    const PUBLIC_SCREENING_URL = 'https://jq.mockr.com.cn/mzf-sq/#/screen'

    患者端显示和复制该地址，不拼接患者、机构、场次、令牌或微信标识。

- [ ] Step 6: 运行并提交。

    Run: node --test test/native-design-system.test.js test/native-route-contract.test.js test/role-entry.test.js test/workspace-entry.test.js
    Run: node --check miniprogram/app.js
    Expected: PASS，医生和患者业务入口均为原生，WebView 业务入口为零。

    git add miniprogram/app.wxss miniprogram/app.json miniprogram/pages/home miniprogram/utils/role-entry.js miniprogram/utils/workspace-entry.js miniprogram/components miniprogram/pages/doctor miniprogram/pages/patient test/native-design-system.test.js test/native-route-contract.test.js
    git commit -m "feat: establish native miniapp shell"

---

## Task 4: 原生医生工作台、患者列表、档案和患者 360

**Files:**

- Create: miniprogram/utils/patient-api.js
- Create: miniprogram/pages/patient-list/index.*、miniprogram/pages/patient-detail/index.*、miniprogram/pages/patient-360/index.*
- Modify: miniprogram/pages/doctor/workspace/index.*、miniprogram/app.json
- Test: test/patient-api.test.js、test/patient-pages.test.js

**Interfaces:**

- listPatients({ page, pageSize, keyword, orgId }): Promise<PageResult>
- getPatient(patientId): Promise<PatientDetail>
- getPatient360(patientId): Promise<Patient360>
- checkDuplicate(payload): Promise<DuplicateResult>
- createPatient(payload): Promise<PatientDetail>
- updatePatient(patientId, payload): Promise<PatientDetail>
- deletePatient(patientId): Promise<void>
- listOrganizations({ keyword }): Promise<OrgOption[]>
- Test helper: createRequestSpy(): { last: { url: string, method: string, data: any } }，由 test/patient-api.test.js 注入请求实现。

- [ ] Step 1: 写 API 适配器测试，验证查询编码和字符串 ID。

    await listPatients({ page: 1, pageSize: 20, keyword: '测试', orgId: '1972545374712086529' })
    assert.equal(lastRequest.url, '/api/v1/patients?page=1&pageSize=20&keyword=%E6%B5%8B%E8%AF%95&orgId=1972545374712086529')

- [ ] Step 2: 实现患者列表。

    状态固定包含 loading、refreshing、keyword、patients、page、hasMore、error 和 empty。支持搜索、下拉刷新、触底分页、患者卡片点击和错误重试。机构范围只信任服务端返回。

- [ ] Step 3: 实现档案表单。

    覆盖 PatientSaveDTO 字段。证件查重调用 POST /api/v1/patients/duplicate-check，保存调用 POST /api/v1/patients 或 PUT /api/v1/patients/{id}。身份证、手机号、机构和患者状态展示脱敏值；日志不输出原始身份信息。

- [ ] Step 4: 实现详情和 360。

    详情提供摘要、档案编辑、随访、监测和报告入口。360 调用 GET /api/v1/patients/{patientId}/360，按“基本信息、COPD 专档、最近随访、设备指标、风险提示”展示服务端结果，不在客户端重算临床结论。

- [ ] Step 5: 运行并提交。

    Run: node --test test/patient-api.test.js test/patient-pages.test.js
    Run: node --check miniprogram/utils/patient-api.js
    Expected: PASS，覆盖列表分页、详情、查重、保存和权限错误。

    git add miniprogram/utils/patient-api.js miniprogram/pages/doctor miniprogram/pages/patient-list miniprogram/pages/patient-detail miniprogram/pages/patient-360 miniprogram/app.json test/patient-api.test.js test/patient-pages.test.js
    git commit -m "feat: add native patient management"

---

## Task 5: 原生随访、消息、统计和患者端工作台

**Files:**

- Create: miniprogram/utils/followup-api.js、miniprogram/utils/message-api.js、miniprogram/utils/stats-api.js
- Create: miniprogram/pages/followups/index.*、miniprogram/pages/followups/detail.*、miniprogram/pages/messages/index.*、miniprogram/pages/statistics/index.*
- Modify: miniprogram/pages/patient/workspace/index.*、miniprogram/app.json
- Test: test/followup-api.test.js、test/followup-pages.test.js、test/message-stats-api.test.js

**Interfaces:**

- followup-api.js: listMyFollowups(params)、listPatientFollowups(patientId, params)、getFollowup(id)、saveFollowup(payload)、saveFollowupDraft(payload)、updateFollowup(id, payload)、deleteFollowup(id)、uploadPhoto(filePath)。
- followup-api.js also exports validateFollowup(payload): { ok: boolean, errors: Record<string, string> }，只做表单完整性检查；CAT 评分和临床结论仍由服务端计算。
- message-api.js: listMessages(params)、getUnreadCount()、markMessageRead(id)、markAllMessagesRead()。
- stats-api.js: getHomeStats(params)、getStatsDetail(params)、getMyFollowupStats(params)、getMyStats(params)。

- [ ] Step 1: 写随访校验失败测试。

    test('followup validation requires eight CAT answers and valid visit date', () => {
      const result = validateFollowup({ patientId: '1', visitType: 0, visitDate: '', catAnswers: [0, 1] })
      assert.deepEqual(result.errors, {
        visitDate: '随访日期必填',
        catAnswers: 'CAT 8 项必须齐全且每项 0-5'
      })
    })

- [ ] Step 2: 实现随访列表、详情和草稿。

    患者端使用 /api/v1/followups/my，医生端在患者上下文中使用 /api/v1/patients/{patientId}/followups。原生表单覆盖 CAT 8 项、mMRC、主诉、用药、生活方式、COPD 快照和照片；照片通过 wx.uploadFile 调用现有上传接口，并沿用 jpg/jpeg/png、单张不超过 5 MiB 的服务端约束。

- [ ] Step 3: 实现消息页。

    支持未读数、分页、单条已读和全部已读。消息打开后刷新服务端状态，不在本地伪造通知内容。

- [ ] Step 4: 实现统计页和患者工作台。

    统计页面展示服务端数值、趋势和时间范围；患者工作台包含随访、消息、报告、指环设备和公共问卷复制入口。无 patientRef 时只显示脱敏提示和固定问卷地址，不显示个人数据。

- [ ] Step 5: 运行并提交。

    Run: node --test test/followup-api.test.js test/followup-pages.test.js test/message-stats-api.test.js
    Run: node --check miniprogram/utils/followup-api.js
    Expected: PASS，覆盖患者/医生范围、草稿、图片限制、消息已读、统计和未建档入口。

    git add miniprogram/utils/followup-api.js miniprogram/utils/message-api.js miniprogram/utils/stats-api.js miniprogram/pages/followups miniprogram/pages/messages miniprogram/pages/statistics miniprogram/pages/patient miniprogram/app.json test/followup-api.test.js test/followup-pages.test.js test/message-stats-api.test.js
    git commit -m "feat: add native followup messaging and stats"

---

## Task 6: 原生监测、标准报告和 AI 报告

**Files:**

- Create: miniprogram/utils/monitoring-api.js、miniprogram/utils/report-api.js
- Create: miniprogram/pages/monitoring/index.*、miniprogram/pages/reports/index.*、miniprogram/pages/reports/detail.*
- Modify: miniprogram/pages/patient-360/index.*
- Test: test/monitoring-api.test.js、test/report-api.test.js、test/monitoring-report-pages.test.js

**Interfaces:**

- monitoring-api.js: getMonitoringSummary(patientId)、getMonitoringTrends(patientId, params)、getMonitoringAlerts(patientId, params)、acknowledgeAlert(alertId)。
- report-api.js: listPatientReports(patientId, params)、getReportAccessUrl(patientId, reportId)、getFileAccessUrl(patientId, fileId)、getAiReport(patientId)、generatePatientAiReport(patientId)、getOrgAiReport(orgId, period)、generateOrgAiReport(orgId, period)、confirmAiReport(reportId, body)。
- report-api.js also exports buildReportRoute({ patientId, reportId }): string，返回不含 accessUrl、token 或短时地址的原生路由。
- 报告短时地址只在当前内存中用于 wx.downloadFile、wx.openDocument 或原生预览；不写入路由、Storage、日志、埋点和剪贴板。
- 监测页面只渲染服务端指标和告警状态，不复制 WearableAttentionRuleEngine。

- [ ] Step 1: 写短时地址和监测数据映射测试。

    test('report access urls never enter route query or storage', () => {
      const route = buildReportRoute({ patientId: '768495013408443', reportId: '9001' })
      assert.equal(route.includes('accessUrl'), false)
      assert.equal(route.includes('token'), false)
    })

- [ ] Step 2: 实现监测摘要、趋势和告警。

    页面顺序固定为“摘要卡、时间范围、趋势、告警”。确认告警调用服务端后刷新当前列表，不本地修改临床等级和风险结论。

- [ ] Step 3: 实现标准报告和附件访问。

    先调用报告 access-url 接口，再在内存中打开文件或原生文本视图。访问失败显示可重试状态，不能把地址复制到剪贴板。

- [ ] Step 4: 实现 AI 报告读取、生成和确认。

    优先读取已生成报告；患者和机构生成分别调用 POST /api/v1/ai/report/patient/{patientId}/stream、POST /api/v1/ai/report/org/{orgId}/stream。微信端对 SSE 不做 URL 嵌入，使用现有服务端允许的分段响应或在契约矩阵中落定的轮询读取方式；不在小程序本地拼装临床结论。确认前显示服务端报告版本和患者摘要，确认调用 POST /api/v1/ai/report/{reportId}/confirm，body 只发送 confirmed 和 doctorRemark，完成后刷新详情。

- [ ] Step 5: 运行并提交。

    Run: node --test test/monitoring-api.test.js test/report-api.test.js test/monitoring-report-pages.test.js
    Run: node --check miniprogram/utils/monitoring-api.js
    Run: node --check miniprogram/utils/report-api.js
    Expected: PASS，覆盖趋势、告警、报告短时地址生命周期、AI 报告确认和错误重试。

    git add miniprogram/utils/monitoring-api.js miniprogram/utils/report-api.js miniprogram/pages/monitoring miniprogram/pages/reports miniprogram/pages/patient-360 test/monitoring-api.test.js test/report-api.test.js test/monitoring-report-pages.test.js
    git commit -m "feat: add native monitoring and reports"

---

## Task 7: 原生体脂秤轮测场次和医生设备工作站

**Files:**

- Create: miniprogram/utils/station-api.js、miniprogram/pages/device-scale/station/index.*
- Server contract when Task 1 confirms the gap: D:\aiProject\workspace-opc\cdms\backend\src\main\java\com\cdms\followup\controller\MiniappScaleStationController.java、对应 DTO/Service/Mapper、迁移和测试；服务端仓库使用独立分支提交。
- Modify: miniprogram/pages/device-scale/index.*、miniprogram/app.json
- Create or preserve: miniprogram/services/scaleBle.js
- Test: test/station-api.test.js、test/scale-station-page.test.js
- Preserve and re-run: test/scale-ble.test.js

**Interfaces:**

- station-api.js: createStation(payload)、getStation(stationId)、createCheckin(stationId, checkinToken)、getTodayQueue(stationId)、callNext(stationId)、skipQueueItem(stationId, queueItemId)、requeueQueueItem(stationId, queueItemId)、saveMeasurementDraft(stationId, queueItemId, payload)、confirmMeasurement(stationId, queueItemId, draftId)、closeStation(stationId, discardDraftIds)。
- station-api.js also exports reduceStationState(state, action): StationState，供页面状态机测试使用；服务端仍是最终状态来源。状态值固定包含 OPEN/CLOSED/EXPIRED 场次和 WAITING/CALLED/MEASURING/RESULT_PENDING/COMPLETED/SKIPPED/CANCELLED 队列状态。
- 每个写请求携带服务端要求的幂等键；患者签到只发送不透明令牌，不发送患者 ID、机构 ID、姓名、手机号或身份证号。

- [ ] Step 1: 写队列状态机测试。

    test('station allows one active queue item', () => {
      const next = reduceStationState({ items: [
        { id: '1', status: 'CALLED' },
        { id: '2', status: 'WAITING' }
      ] }, { type: 'CALL_NEXT' })
      assert.equal(next.error, '当前已有患者正在测量')
    })

- [ ] Step 2: 先实现并验证服务端场次契约，再实现医生场次页面。

    在 cdms 独立分支完成场次/队列表结构、令牌 nonce/有效期、机构和患者授权、重复签到幂等、单当前患者约束、草稿确认事务、关闭门禁及 Controller/Service 测试。服务端响应固定返回场次状态、队列状态、脱敏患者摘要和草稿状态。服务端契约通过后，小程序页面状态包含场次状态、二维码、候测数、当前患者脱敏摘要、设备连接状态、测量草稿和异常草稿；流程固定为“创建场次、连接 AiLink、下一位、设置性别/年龄/身高、接收草稿、医生确认、下一位”。

- [ ] Step 3: 实现患者扫码签到。

    使用 wx.scanCode 后调用 createCheckin(stationId, checkinToken)。服务端从登录令牌派生 patientRef；重复扫码返回原队列项，未建档和跨机构直接阻止。不得调用现有直接接收 patientId 的 /api/v1/checkins 作为正式实现。未建档页面只显示固定问卷地址及复制按钮。

- [ ] Step 4: 实现独立 ScaleBle 和异常草稿。

    ScaleBle 只管理体脂秤；bleManager 的指环连接、绑定、同步和历史队列代码不改写。无法归属当前患者的数据进入异常草稿区；设备断线保留队列项，重连后重新测量，不生成空结果。

- [ ] Step 5: 实现服务端事务确认和关闭门禁。

    确认按钮只调用服务端确认接口；服务端负责场次开放、当前患者、草稿未确认、正式测量、患者最新身高/体重/BMI、队列完成的事务。关闭场次前存在未确认草稿时必须明确丢弃或返回处理。

- [ ] Step 6: 运行并提交。

    Run: node --test test/station-api.test.js test/scale-station-page.test.js test/scale-ble.test.js
    Run: node --check miniprogram/utils/station-api.js
    Run: node --check miniprogram/services/scaleBle.js
    Expected: PASS，覆盖扫码幂等、单当前患者、跨机构拒绝、异常草稿、重复确认、关闭门禁和指环回归。

    git add miniprogram/utils/station-api.js miniprogram/pages/device-scale miniprogram/services/scaleBle.js miniprogram/app.json test/station-api.test.js test/scale-station-page.test.js test/scale-ble.test.js
    git commit -m "feat: add native scale testing station"

---

## Task 8: 原生指环、MFA-1 和 Sunvou 能力

**Files:**

- Modify: miniprogram/pages/device/device.*、miniprogram/pages/wearable/sync/index.*
- Create: miniprogram/utils/acquisition-api.js、miniprogram/utils/sunvou-api.js
- Create: miniprogram/pages/device-mfa1/index.*、miniprogram/pages/device-sunvou/index.*
- Read and preserve: miniprogram/services/bleManager.js、miniprogram/utils/cdms-bridge.js
- Read: D:\aiProject\workspace-opc\cdms-iot\core\src\main\java\com\cdms\iot\core\acquisition\AcquisitionSessionController.java
- Test: test/wearable-native-regression.test.js、test/acquisition-api.test.js、test/sunvou-api.test.js

**Interfaces:**

- acquisition-api.js: createSession(payload)、getSession(sessionId)、getWssToken(sessionId)、launchSession(sessionId)、cancelSession(sessionId)、retrySession(sessionId)。
- sunvou-api.js: listReports(params)、getReport(reportId)、getReportAccessUrl(reportId)。
- WSS token 和报告短时地址只保存在当前页面内存，退出或会话结束时清理。
- bleManager 的 init、subscribe、snapshot、reconnect、unbind、syncAllHealthData 行为保持兼容。

- [ ] Step 1: 写指环链路不变量测试。

    const batch = createUploadBatch({ patientRef: '768495013408443', records: [] })
    assert.equal(batch.patientRef, '768495013408443')
    assert.equal(String(batch.patientRef).includes('[object Object]'), false)

- [ ] Step 2: 以 cdms-iot acquisition session 契约实现 MFA-1。

    页面显示设备状态、会话状态、开始/重试/取消；每个会话绑定任务、设备类型、患者/机构授权和 trace ID，权限由服务端验证。

- [ ] Step 3: 以现有报告接口实现 Sunvou 查询。

    列表、详情、访问地址和重试均使用原生卡片和状态面板；普通小程序用户不直接访问 cdmsManager 运维接口。

- [ ] Step 4: 回归指环、解绑和上传队列。

    Run: node --test test/iot-rebind.test.js test/iot-session-recovery.test.js test/iot-upload-api.test.js test/auth-wearable-scope-regression.test.js
    Expected: 指环绑定、同步、解绑、401 会话恢复和患者 scope 隔离继续通过。

- [ ] Step 5: 运行新增测试并提交。

    Run: node --test test/wearable-native-regression.test.js test/acquisition-api.test.js test/sunvou-api.test.js
    git add miniprogram/pages/device miniprogram/pages/wearable miniprogram/utils/acquisition-api.js miniprogram/utils/sunvou-api.js miniprogram/pages/device-mfa1 miniprogram/pages/device-sunvou test/wearable-native-regression.test.js test/acquisition-api.test.js test/sunvou-api.test.js
    git commit -m "feat: complete native device workspaces"

---

## Task 9: 准备体脂秤轮测测试患者数据

**Files:**

- Create: docs/superpowers/runbooks/2026-08-28-scale-test-data.md
- Create: test/scale-test-fixture-contract.test.js
- Execute separately in test environment: D:\aiProject\workspace-opc\cdms 的受控数据脚本或受保护服务接口；不在小程序启动和自动化测试中写数据库。

**Interfaces:**

- Produces: 可重复执行、执行前备份、执行后核对、可回滚的两名体脂秤轮测测试患者数据记录。
- Test fixture invariant: 测试患者无微信伪造身份、无手环绑定、无手环测量、无手环告警和无 IoT 上传批次；测试患者2保留微信关联、设备绑定和手环数据主键及内容摘要。

- [ ] Step 1: 写数据前置核验和停止条件。

    测试患者按身份证号 429004199102162952 和手机号 18696144935 分别查询；身份证已存在时复用并核对姓名，手机号属于其他身份证时立即停止。目标机构必须是启用的测试机构，不使用空机构。测试患者2 必须精确锁定 patient id 768495013408443、手机号 18671457982，并核对目标机构 1972545374712086529（沌阳街沌阳社区卫生服务中心）。任一身份证、手机号、主键或机构不一致都停止。

- [ ] Step 2: 写幂等写入和不变量核对。

    测试患者补齐 COPD 专档、一次高危 COPD-SQ、一次已确诊记录和少量非手环随访/评估数据；不创建 cdms_patient_account，不写设备绑定、设备测量、患者监测状态、监测告警、IoT 上传批次或手环记录。测试患者2只更名为“测试患者2”，同步更新明确的筛查冗余姓名，迁移 CDMS/IoT 关联机构字段到目标机构，保留身份证、微信关联、设备绑定、手环数据、来源审计字段和原始指标内容。

- [ ] Step 3: 生成 runbook 并记录备份与摘要。

    runbook 必须记录受影响数据库备份位置、写入主键、两库手环记录数量、设备绑定主键集合、关键数据内容摘要、目标机构、执行时间和操作者。迁移前后比较主键集合和内容摘要；若目标机构已有相同 device_ref 的 ACTIVE 绑定，停止迁移，不自动释放、抢占或覆盖。

- [ ] Step 4: 运行契约测试并提交文档。

    Run: node --test test/scale-test-fixture-contract.test.js
    Expected: PASS，测试数据不变量、患者2设备数据保留规则和禁止伪造微信身份均被锁定。

    git add docs/superpowers/runbooks/2026-08-28-scale-test-data.md test/scale-test-fixture-contract.test.js
    git commit -m "docs: define scale station test data runbook"

---

## Task 10: 全量安全、视觉、路由和真机验收

**Files:**

- Create: test/full-native-route-scan.test.js、test/full-native-security-scan.test.js
- Create: docs/superpowers/verification/2026-08-28-full-native-miniapp-acceptance.md
- Modify only for a scoped verification defect: the affected implementation or test file.

**Interfaces:**

- Produces: 全量原生验收记录、路由扫描结果、敏感字段扫描结果、自动化测试结果和真机验收清单。
- Consumes: Tasks 1–9 的页面、接口适配器、设备服务和测试数据核对记录。
- Test helper: readAllMiniprogramFiles(): string，在 test/full-native-route-scan.test.js 和 test/full-native-security-scan.test.js 中读取 miniprogram 下受检文件。

- [ ] Step 1: 写业务路由扫描测试。

    const source = readAllMiniprogramFiles()
    assert.equal(source.includes('<web-view'), false)
    assert.equal(source.includes('/pages/h5/'), false)
    assert.equal(source.includes('createHandoff('), false)

- [ ] Step 2: 写敏感字段扫描测试。

    扫描 URL 拼接、wx.setStorageSync、console.log/warn/error 和埋点 payload，禁止 access token、refresh token、患者身份证、微信标识、设备密钥和报告 access URL 落入持久化、URL、日志或埋点。

- [ ] Step 3: 运行自动化检查。

    Run: node --test
    Run: Get-ChildItem -Recurse -File miniprogram -Filter *.js | ForEach-Object { node --check $_.FullName }
    Run: git diff --check
    Expected: 所有 Node 测试、JavaScript 语法检查和 diff 检查通过。

- [ ] Step 4: 执行微信开发者工具验收并截图。

    1. 关闭小程序、微信进程回收、手机重启后均静默恢复最近角色。
    2. 断网、超时、5xx 后登录态保留；服务端吊销后进入登录页。
    3. 退出后返回、重开和旧令牌均不能恢复会话。
    4. 医生患者列表、档案、360、随访、监测、消息、统计、报告均为原生。
    5. 患者随访、报告、指环和公共问卷复制均为原生；问卷 URL 无身份和场次参数。
    6. 两名以上患者扫码进入同一体脂秤场次，连续叫号、测量、确认、跳过、重测。
    7. 体脂秤断线重连不生成空结果；异常测量不自动补绑患者。
    8. 指环绑定、同步、历史、解绑保持原有行为。
    9. MFA-1 会话和 Sunvou 查询不通过 WebView，短时地址不落盘。
    10. 所有页面符合患者工作台绿色、浅灰绿背景、白色圆角卡片、表单和信息层级。

- [ ] Step 5: 记录验收并提交。

    git add test/full-native-route-scan.test.js test/full-native-security-scan.test.js docs/superpowers/verification/2026-08-28-full-native-miniapp-acceptance.md
    git commit -m "test: verify full native miniapp acceptance"

---

## 交付顺序和发布门禁

1. 先完成 Task 1 契约矩阵；接口缺口以对应服务端仓库的独立分支、测试和发布审计处理。
2. 完成 Task 2 后，所有页面必须通过 auth-guard.js 进入，不允许页面自行读取或清除令牌。
3. 完成 Task 3 后，医生和患者业务入口必须已经切换为原生，才能继续迁移业务页面。
4. Task 4–6 每个子项目独立验收和提交，任何子项目不得回退到 H5 页面。
5. Task 7–8 设备改造先通过指环回归，再开放体脂秤、MFA-1 和 Sunvou 入口。
6. Task 10 通过前不上传微信体验版、不部署服务端、不切换生产配置。
7. 测试患者数据、真实微信绑定、设备绑定、生产数据库和生产服务不属于本计划的自动化写入步骤；测试数据操作必须另行执行受控备份、幂等和回滚核对。
