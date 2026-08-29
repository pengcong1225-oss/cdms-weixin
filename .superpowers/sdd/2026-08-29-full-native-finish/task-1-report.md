# Task 1 Report: Doctor workspace native entry closure, fix round 1

## Scope

- Task brief: `D:\codex\worktrees\cdms-weixin-full-native-finish\.superpowers\sdd\2026-08-29-full-native-finish\task-1-brief.md`
- Worktree: `D:\codex\worktrees\cdms-weixin-full-native-finish`
- Previous implementation under review: `e8055f5`
- Fix-round commit target: `fix: keep doctor patient context out of urls`

## Review findings addressed

- Removed `patientId` from doctor workspace navigation URLs for patient-scoped entries.
- Removed query-derived fallback from `resolveCurrentPatientId`; doctor workspace no longer accepts `query.patientId` or `query.id`.
- Switched patient-context transfer in doctor workspace to transient in-memory app state via `getApp().globalData.currentPatientId`.
- Updated the allowed Task 1 tests to assert both halves of the contract: no patient identifier in URLs, and transient patient context retained in app memory.
- Reverted `test/patient-pages.test.js` to its pre-task state and preserved its fixed-index compatibility by restoring the scale-station entry to index `1` through the allowed Task 1 implementation and tests.

## Files changed in this round

- `miniprogram/pages/doctor/workspace/index.js`
- `miniprogram/pages/doctor/workspace/index.wxml`
- `test/workspace-entry.test.js`
- `test/native-route-contract.test.js`
- `test/patient-pages.test.js` reverted to pre-task state

## TDD record

### 1. Red

Command:

```powershell
node --test test/workspace-entry.test.js test/native-route-contract.test.js
```

Observed result:

```text
✖ doctor workspace source closes native entry placeholders and keeps patient routes context-safe
✖ doctor workspace ignores query-derived patient context and keeps patient urls clean
✖ doctor workspace navigates native entries without patientId in urls and uses transient patient context
```

Failure matched the review:

- source still referenced `query.patientId` / `query.id`
- patient-scoped navigation still emitted `?patientId=...`
- transient app-memory context was not being asserted or preserved by the focused tests

### 2. Green

Command:

```powershell
node --test test/workspace-entry.test.js test/native-route-contract.test.js
```

Observed result:

```text
ℹ tests 9
ℹ pass 9
ℹ fail 0
```

Focused coverage now proves:

- doctor workspace source contains no query-derived patient-context fallback
- no doctor workspace route URL contains `patientId`
- transient patient context is stored only in `getApp().globalData.currentPatientId`
- the scale-station compatibility slot remains at entry index `1`

## Full verification

Initial fresh full-suite run after the scoped fix exposed the expected compatibility regression outside the allowed test files:

- `test/patient-pages.test.js`
- failure: `doctor workspace opens the native body-composition station`
- cause: the reverted pre-task test still depends on station entry index `1`

Minimal allowed correction:

- restored the doctor workspace entry order so `station` is again index `1`
- added an explicit compatibility assertion in `test/workspace-entry.test.js`

Final fresh command:

```powershell
node --test
```

Final observed result:

```text
ℹ tests 99
ℹ pass 99
ℹ fail 0
```

## Implementation notes

- `buildEntryUrl` now always returns the native page path without appending sensitive identifiers.
- `persistTransientPatientContext` writes patient context only to in-memory app global state and clears it for non-patient-scoped entries.
- `resolveCurrentPatientId` now accepts only existing transient/session context, not route query values.
- `index.wxml` now renders a state-panel message derived from whether a transient patient context currently exists.

## Git status before commit

```text
M  miniprogram/pages/doctor/workspace/index.js
M  miniprogram/pages/doctor/workspace/index.wxml
M  test/native-route-contract.test.js
M  test/patient-pages.test.js
M  test/workspace-entry.test.js
```

## Concerns

- Patient-scoped destination pages still read patient context from their own query/session logic. This round removes the doctor-workspace URL leak and preserves transient context in memory exactly as requested, but those destination pages are outside the Task 1 allowed-file boundary and were not changed here.

## Cleanup note

- Cleanup audit on 2026-08-29 confirmed `test/patient-pages.test.js` is identical to its pre-Task-1 state from `5970f3b` and remains outside the staged set.
- Cleanup audit also confirmed the fix-round commit diff against `5970f3b` contains only the allowed Task 1 tracked files: `miniprogram/pages/doctor/workspace/index.js`, `miniprogram/pages/doctor/workspace/index.wxml`, `test/workspace-entry.test.js`, and `test/native-route-contract.test.js`.
- Fresh focused verification after cleanup should continue to prove that doctor-workspace navigation URLs do not contain `patientId` and that transient doctor patient context is retained only in app memory.

## Fix round 2: destination-page doctor context closure

### Scope

- Allowed destination-page changes used in this round:
  - `miniprogram/pages/followups/index.js`
  - `miniprogram/pages/monitoring/index.js`
  - `miniprogram/pages/reports/index.js`
- Focused tests updated in this round:
  - `test/followup-pages.test.js`
  - `test/monitoring-report-pages.test.js`
- Baseline guard retained:
  - `test/patient-pages.test.js` must remain byte-for-byte identical to commit `5970f3b`

### Root cause

- Doctor workspace now hands off patient context only through `getApp().globalData.currentPatientId`.
- The destination native pages for follow-ups, monitoring, and reports still resolved doctor scope only from `query.patientId` / `query.id`.
- As a result, doctor navigation from `/pages/doctor/workspace/index` reached those pages without any patient context, even though the transient in-memory handoff existed.

### TDD record

#### 1. Red

Command:

```powershell
node --test test/followup-pages.test.js test/monitoring-report-pages.test.js
```

Observed result:

```text
✖ doctor followup list consumes transient workspace patient context and clears the shared handoff
✖ monitoring page consumes transient doctor patient context and clears the shared handoff
✖ reports page consumes transient doctor patient context and clears the shared handoff
```

Failure matched the review:

- each destination page left doctor `patientId` empty when opened from workspace without query parameters
- the transient app-memory handoff was not consumed

#### 2. Green

Command:

```powershell
node --test test/followup-pages.test.js test/monitoring-report-pages.test.js
```

Observed result:

```text
ℹ tests 18
ℹ pass 18
ℹ fail 0
```

Focused coverage now proves:

- doctor follow-ups, monitoring, and reports pages accept explicit patient-scoped query parameters where they already did
- those pages also fall back to `getApp().globalData.currentPatientId` when entered from doctor workspace
- the transient handoff is cleared after page-local state is set, avoiding stale doctor context bleed
- patient-role behavior remains unchanged

### Implementation notes

- Added a small page-local `consumeDoctorPatientId` helper in each of the three destination pages.
- Resolution order for doctor scope is now:
  1. explicit `query.patientId` / `query.id` when already supported
  2. transient `getApp().globalData.currentPatientId`
- After resolution, each page deletes `globalData.currentPatientId` so later unrelated doctor entry does not silently reuse stale patient context.
- `followups/index.js` no longer mixes doctor page context with patient-session identifiers.

### Full verification

Baseline guard:

```powershell
git diff --exit-code 5970f3b -- test/patient-pages.test.js
```

Observed result:

```text
[exit 0]
```

Fresh full-suite command:

```powershell
node --test
```

Observed result:

```text
ℹ tests 102
ℹ pass 102
ℹ fail 0
```

### Concerns

- This round closes the doctor workspace handoff into the three destination index pages only. Downstream detail-page routing still follows each page's existing contract and was not expanded in this round.

### Ownership verification refresh

After taking over the fix-round task, I verified the current commit state and reran the red/green evidence.

RED was reproduced in a disposable detached worktree at `83c6daa` with only the focused test changes applied:

```powershell
node --test test/followup-pages.test.js test/monitoring-report-pages.test.js
```

Observed result:

```text
ℹ tests 18
ℹ pass 15
ℹ fail 3
```

The three failures were the expected doctor transient-context assertions for followups, monitoring, and reports.

GREEN was rerun from the real worktree at the fix commit:

```powershell
node --test test/followup-pages.test.js test/monitoring-report-pages.test.js
```

Observed result:

```text
ℹ tests 18
ℹ pass 18
ℹ fail 0
```

Full suite was rerun from the same fix commit:

```powershell
node --test
```

Observed result:

```text
ℹ tests 102
ℹ pass 102
ℹ fail 0
```
