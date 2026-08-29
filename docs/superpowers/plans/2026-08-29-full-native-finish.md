# Full Native Miniapp Finish Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Deliver a complete, testable native CDMS miniapp across all registered business pages, with a closed doctor workspace, safe MFA-1 acquisition flow, and no client-side IoT credentials.

**Architecture:** The miniapp remains a native WeChat implementation and calls the authenticated `cdms` API for business data. `cdms` becomes the only public miniapp-to-IoT boundary for MFA-1 acquisition: it validates the miniapp JWT scope and forwards signed server-to-server requests to `cdms-iot` using environment-provided credentials. Existing patient, follow-up, monitoring, report, scale, wearable, Sunvou, and legacy native pages are retained and made reachable through explicit native routes and context-safe navigation.

**Tech Stack:** WeChat Mini Program JavaScript/WXML/WXSS, Node.js built-in test runner, Spring Boot 4.1, Java 17, RestClient, JUnit 5, MyBatis-Plus, HMAC-SHA256.

**Spec:** `docs/superpowers/specs/2026-08-27-native-scale-station-design.md`, plus the approved full-native finish scope recorded in this plan.

## Global Constraints

- No business `web-view`, H5 handoff, or browser-only fallback may remain in the miniapp.
- Reuse the patient workbench visual system: existing colors, radii, cards, forms, status tags, and information hierarchy.
- Refresh/network/timeout/5xx failures retain the persisted session; only explicit logout or server-confirmed revocation clears it.
- Patient identifiers remain opaque strings and sensitive identity values never enter URL query strings or durable storage.
- IoT client secrets are server-only environment values and must never enter miniapp source, runtime config, logs, or build output.
- Every behavior change follows a failing test, minimal implementation, passing focused test, then full-suite verification.
- Real-device execution is outside this environment; deliver a WeChat Developer Tools/test-device-ready package and a reproducible manual acceptance checklist.

---

### Task 1: Doctor workspace native entry closure

**Files:**
- Modify: `miniprogram/pages/doctor/workspace/index.js`
- Modify: `miniprogram/pages/doctor/workspace/index.wxml`
- Modify: `miniprogram/pages/doctor/workspace/index.wxss` only if the full entry grid needs the existing design tokens
- Test: `test/workspace-entry.test.js`
- Test: `test/native-route-contract.test.js`

**Interfaces:**
- Consumes: the existing native page routes and `ensureSession({ role: 'DOCTOR' })`.
- Produces: enabled entries for patients, follow-ups, monitoring, messages, statistics, reports, scale station, and device workstations; patient-scoped entries must carry `patientId` only when a patient context exists.

- [ ] **Step 1: Write the failing route-entry tests**

  Add assertions that a doctor can select every native workbench entry, that no entry is disabled with “后续接入” copy, and that patient-scoped entries either receive an opaque patient id or show a context-required state instead of falling back to personal scope.

- [ ] **Step 2: Run focused tests to verify the expected failure**

  Run `node --test test/workspace-entry.test.js test/native-route-contract.test.js`.
  Expected: failure because the current follow-up entry is disabled and the remaining native pages are not exposed from the doctor workspace.

- [ ] **Step 3: Implement the minimal entry map and context-safe navigation**

  Replace the placeholder stats and state panel copy with real native capability copy. Add explicit route metadata for `/pages/followups/index`, `/pages/monitoring/index`, `/pages/messages/index`, `/pages/statistics/index`, and `/pages/reports/index`; use `patientId` only for patient-scoped routes and show a context prompt where required. Keep all visual markup on the existing `workspace-card`, `stat-card`, and `state-panel` components.

- [ ] **Step 4: Run focused tests to verify the behavior**

  Run `node --test test/workspace-entry.test.js test/native-route-contract.test.js`.
  Expected: PASS with no disabled business entry and no invalid personal-scope fallback.

- [ ] **Step 5: Commit**

  `git add miniprogram/pages/doctor/workspace test/workspace-entry.test.js test/native-route-contract.test.js && git commit -m "feat: close native doctor workspace entries"`

### Task 2: Secure `cdms` acquisition facade for MFA-1

**Files:**
- Create: `backend/src/main/java/com/cdms/followup/service/IotAcquisitionSessionClient.java`
- Create: `backend/src/main/java/com/cdms/followup/service/RemoteIotAcquisitionSessionClient.java`
- Create: `backend/src/main/java/com/cdms/followup/controller/MiniappAcquisitionController.java`
- Modify: `backend/src/main/resources/application.yml`
- Modify: `backend/src/main/java/com/cdms/followup/security/JwtInterceptor.java` only if the existing authenticated miniapp route policy needs an explicit facade allowlist entry
- Test: `backend/src/test/java/com/cdms/followup/controller/MiniappAcquisitionControllerTest.java`
- Test: `backend/src/test/java/com/cdms/followup/service/RemoteIotAcquisitionSessionClientTest.java`
- Test: `backend/src/test/java/com/cdms/followup/config/ApiSecurityRoutingContractTest.java` if route coverage changes

**Interfaces:**
- Consumes: `UserContext`, the existing miniapp JWT interceptor, `cdms-iot` internal contract `/v1/acquisition-sessions/**`, and server-side `IOT_REPORT_BASE_URL`, `IOT_REPORT_CLIENT_ID`, `IOT_REPORT_CLIENT_SECRET` or an explicitly separated equivalent configuration group.
- Produces: authenticated facade operations `POST /api/v1/miniapp/iot/acquisition-sessions`, `GET /api/v1/miniapp/iot/acquisition-sessions/{sessionId}`, `POST /api/v1/miniapp/iot/acquisition-sessions/{sessionId}/wss-token`, and `POST /api/v1/miniapp/iot/acquisition-sessions/{sessionId}/cancel`; no IoT credential fields are accepted from the miniapp.

- [ ] **Step 1: Write failing controller and client tests**

  Verify the controller rejects non-doctor sessions, rejects a request whose `orgId` or `patientRef` does not match `UserContext`, forwards only the allowlisted acquisition fields, and returns a safe 502-style business error when the IoT service is unavailable. Verify the remote client signs POST bodies and header-only GET/POST requests using server configuration.

- [ ] **Step 2: Run focused backend tests to verify the expected failure**

  Run `mvn -q -Dtest=MiniappAcquisitionControllerTest,RemoteIotAcquisitionSessionClientTest test` from `D:\codex\worktrees\cdms-miniapp-native-finish\backend`.
  Expected: compilation/test failure because the facade types do not exist.

- [ ] **Step 3: Implement the server-side facade**

  Reuse the existing HMAC canonicalization used by `RemoteIotWearableSessionClient` and the `cdms-iot` acquisition contract. Generate `clientId`, timestamp, nonce, and signature on the server; never echo the secret. Enforce `DOCTOR` role and org/patient scope before forwarding. Map dependency authentication, conflict, and unavailable responses to stable CDMS business errors without exposing upstream credentials or raw response bodies.

- [ ] **Step 4: Run focused backend tests to verify the behavior**

  Run the same Maven command and confirm all focused tests pass. Then run `mvn -q test` from the backend module.

- [ ] **Step 5: Commit**

  `git add backend/src/main backend/src/test && git commit -m "feat: add secure miniapp acquisition facade"`

### Task 3: Switch the native MFA-1 page to the facade

**Files:**
- Modify: `miniprogram/utils/acquisition-api.js`
- Modify: `miniprogram/config/runtime.js`
- Modify: `miniprogram/pages/device-mfa1/index.js` only where request/response fields need the public facade contract
- Test: `test/acquisition-api.test.js`
- Test: `test/full-native-security-scan.test.js`
- Test: `test/native-api-contract.test.js`

**Interfaces:**
- Consumes: the `cdms` facade endpoints from Task 2 and the existing `api.cdmsRequest` access-token path.
- Produces: `createSession`, `getSession`, `launchSession`, `cancelSession`, and `retrySession` that use CDMS JWT authentication and never calculate or send an IoT HMAC signature in the miniapp.

- [ ] **Step 1: Write failing adapter/security tests**

  Assert that MFA-1 requests target the configured `cdmsBaseUrl`, include the access token, omit `iotBaseUrl`, `clientId`, `clientSecret`, HMAC headers, and signature body fields, while preserving string session ids and short-lived WSS values only in page memory.

- [ ] **Step 2: Run focused tests to verify the expected failure**

  Run `node --test test/acquisition-api.test.js test/full-native-security-scan.test.js test/native-api-contract.test.js`.
  Expected: failure because the current adapter signs and calls `iotBaseUrl` directly.

- [ ] **Step 3: Implement the facade adapter**

  Replace direct IoT URL/signing with `api.cdmsRequest` calls to the four facade paths. Remove acquisition secret/client settings from the public runtime config. Keep the page’s retry/cancel state machine and fail-closed error handling.

- [ ] **Step 4: Run focused and full miniapp tests**

  Run the focused command, then `node --test` from the miniapp worktree. Expected: all tests pass and the security scan reports no credential leakage.

- [ ] **Step 5: Commit**

  `git add miniprogram/utils/acquisition-api.js miniprogram/config/runtime.js miniprogram/pages/device-mfa1 test && git commit -m "fix: route native mfa1 through cdms auth"`

### Task 4: Complete all registered native page reachability

**Files:**
- Modify: `miniprogram/pages/doctor/workspace/index.js`
- Modify: `miniprogram/pages/patient-360/index.js` where shortcuts need complete native context handoff
- Modify: `miniprogram/pages/device/device.js` where device workstations need explicit MFA-1/Sunvou context rules
- Modify: `miniprogram/pages/search/search.js` and `miniprogram/pages/history/history.js` only where an existing route still points to a removed H5/business handoff
- Test: `test/full-native-route-scan.test.js`
- Test: `test/role-entry.test.js`
- Test: `test/patient-pages.test.js`

**Interfaces:**
- Consumes: all routes registered in `miniprogram/app.json`, the current role/session guard, and existing page-level API adapters.
- Produces: every registered business page is either directly reachable through a native entry with a defined context or explicitly marked as an existing native utility page; no dead “功能准备中” business entry remains.

- [ ] **Step 1: Write failing route reachability assertions**

  Build a route matrix from `miniprogram/app.json` and assert that doctor/patient workspaces and patient-360 expose the applicable native pages, that all patient-scoped links carry string context, and that no production navigation contains webview/H5 handoff targets.

- [ ] **Step 2: Run the route tests to verify the expected failure**

  Run `node --test test/full-native-route-scan.test.js test/role-entry.test.js test/patient-pages.test.js`.
  Expected: failure for missing doctor-level reachability and any stale placeholder route.

- [ ] **Step 3: Implement the route/context closure**

  Add only the missing native links and context guards. Do not invent new business behavior where an existing API/page already defines it; use state panels for missing context and permission errors. Preserve the current patient workbench visual components.

- [ ] **Step 4: Run focused tests and full miniapp tests**

  Run the focused command, then `node --test`.

- [ ] **Step 5: Commit**

  `git add miniprogram/pages test && git commit -m "feat: close native business route reachability"`

### Task 5: Contract, configuration, and test-ready acceptance package

**Files:**
- Create: `docs/superpowers/contracts/2026-08-29-miniapp-acquisition-facade.md`
- Create: `docs/superpowers/runbooks/2026-08-29-full-native-acceptance.md`
- Modify: `docs/superpowers/verification/2026-08-28-full-native-miniapp-acceptance.md`
- Test: `test/native-api-contract.test.js`
- Test: `test/full-native-security-scan.test.js`
- Test: `test/full-native-route-scan.test.js`
- Test: backend API/security tests affected by the facade

**Interfaces:**
- Consumes: the final miniapp and backend contracts from Tasks 1–4.
- Produces: a deterministic acceptance runbook for WeChat Developer Tools and test devices, including environment variables, callback/base URL requirements, seeded test-data identifiers, expected status transitions, logout/session retention checks, and release blockers.

- [ ] **Step 1: Write failing contract assertions**

  Assert the facade paths, required fields, role restrictions, configuration key presence/absence, route inventory, and absence of secrets in tracked files and generated source.

- [ ] **Step 2: Run focused contract/security scans to verify the expected failure**

  Run `node --test test/native-api-contract.test.js test/full-native-security-scan.test.js test/full-native-route-scan.test.js` and the backend focused tests. Expected: failure until the new facade and documentation are represented.

- [ ] **Step 3: Implement the contract and runbook**

  Document only non-secret configuration names and redacted URL shapes. Include exact Developer Tools steps for importing `D:\codex\worktrees\cdms-weixin-full-native-finish`, setting the request合法域名, logging in as doctor/patient, exercising each route, and recording API/network evidence. Mark physical BLE and production IoT integration as manual acceptance items, not automated claims.

- [ ] **Step 4: Run final verification**

  Run `node --test`; run `mvn -q test` from the backend module; run a JavaScript syntax sweep excluding bundled SDKs; run route/security/config scans; inspect `git diff --check`; and verify both worktrees contain only intended changes and no secret-like files.

- [ ] **Step 5: Commit**

  `git add docs test && git commit -m "docs: add full native acceptance package"`

### Task 6: Review and publish feature branches for user acceptance

**Files:**
- No production files; inspect all commits and worktree diffs.

- [ ] **Step 1: Perform whole-branch review**

  Compare both feature branches with their recorded bases, verify the plan checklist, inspect security-sensitive code manually, and resolve all load-bearing findings before publication.

- [ ] **Step 2: Run fresh verification immediately before publication**

  Repeat the complete miniapp and backend test commands and record exact counts and exit codes.

- [ ] **Step 3: Push only feature branches**

  Push `feature/full-native-finish` from `D:\codex\worktrees\cdms-weixin-full-native-finish` and `feature/cdms-miniapp-native-finish` from `D:\codex\worktrees\cdms-miniapp-native-finish`. Do not merge or modify `master` until the user completes acceptance.

- [ ] **Step 4: Provide acceptance handoff**

  Report commit SHAs, test evidence, exact import paths, environment/config prerequisites, manual test cases, and any items that require the user’s server or IoT environment. The branch is ready for user acceptance; “merged to master” is reserved for the user’s explicit post-acceptance instruction.
