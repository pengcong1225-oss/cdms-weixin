# Miniapp IoT Session Recovery Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Prevent patient health uploads from remaining permanently blocked on an expired IoT token while keeping only the newest local upload batch.

**Architecture:** Keep request and queue primitives in `miniprogram/utils/api.js`. Keep patient-only session renewal orchestration in `miniprogram/utils/cdms-bridge.js`, using the existing authenticated CDMS wearable-session endpoint and renewing the same session ID. Retry the upload exactly once.

**Tech Stack:** WeChat mini program CommonJS JavaScript, Node.js `assert` focused tests.

**Spec:** `docs/superpowers/specs/2026-08-25-miniapp-iot-session-recovery-design.md`

## Global Constraints

- Do not deploy or restart any service.
- Do not preserve historical queued health batches.
- Do not auto-renew Manager handoff sessions.
- Do not retry more than once after an HTTP 401.

---

### Task 1: Latest-only queue and structured HTTP errors

**Files:**
- Modify: `miniprogram/utils/api.js`
- Create: `test/iot-upload-api.test.js`

**Interfaces:**
- Consumes: WeChat `wx.getStorageSync`, `wx.setStorageSync`, and `wx.request`.
- Produces: `enqueue(batch)` latest-only behavior and request errors with `statusCode`, `response`, and optional server `code`.

- [ ] **Step 1: Write the failing test**

Create a fake `wx` storage/request implementation and assert that two enqueues leave only the second batch. Make a 401 response and assert the rejected error carries status and payload.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/iot-upload-api.test.js`

Expected: FAIL because enqueue currently appends and request errors expose only their message.

- [ ] **Step 3: Write minimal implementation**

Change `enqueue` to write `[batch]`. Construct request errors with the HTTP response metadata while preserving existing error messages.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/iot-upload-api.test.js`

Expected: PASS.

### Task 2: Patient 401 session renewal

**Files:**
- Modify: `miniprogram/utils/cdms-bridge.js`
- Create: `test/iot-session-recovery.test.js`

**Interfaces:**
- Consumes: `api.createPatientWearableSession(deviceRef, sessionId)`, `api.flushQueue(...)`, and app global patient auth context.
- Produces: patient-only one-time renewal of the same wearable session and retry of the latest queued batch.

- [ ] **Step 1: Write the failing test**

Stub the API boundary before loading the bridge. Assert that a first 401 renews `session-old`, retries with the new token, updates the queued batch session ID, and clears the cache. Add a second-401 case proving no loop and retained latest batch.

- [ ] **Step 2: Run test to verify it fails**

Run: `node test/iot-session-recovery.test.js`

Expected: FAIL because the bridge currently returns the first 401 without renewal.

- [ ] **Step 3: Write minimal implementation**

Add wearable-session cache clearing and patient session renewal. Catch only HTTP 401 in `enqueueAndFlush`, renew with the previous session ID, replace the queued batch, and retry once.

- [ ] **Step 4: Run test to verify it passes**

Run: `node test/iot-session-recovery.test.js`

Expected: PASS.

### Task 3: Regression verification and handoff

**Files:**
- Modify: `D:/codex/docs/task-log.md`

**Interfaces:**
- Consumes: all focused test scripts and mini program JavaScript sources.
- Produces: verified local branch with no deployment.

- [ ] **Step 1: Run all focused tests**

Run every `test/*.test.js` with Node.

- [ ] **Step 2: Run syntax verification**

Run `node --check` for all non-vendored mini program JavaScript files, excluding the minified RWFit SDK.

- [ ] **Step 3: Review the diff and update task history**

Confirm only the approved patient upload behavior and supporting tests/docs changed, then record the local branch and verification result in `D:/codex/docs/task-log.md`.

- [ ] **Step 4: Commit locally**

Commit the verified implementation on `fix/miniapp-iot-session-recovery`. Do not deploy.
