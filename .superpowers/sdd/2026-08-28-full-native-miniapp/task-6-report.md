Task 6 report

Completed scope:

- Added native monitoring summary, trend, and alert pages backed by server APIs.
- Added native standard report listing/detail pages with in-memory short-lived access URL handling only.
- Added native AI report read, generate, and confirm flows for patient and organization scopes.
- Updated the patient 360 page with monitoring and report shortcuts.
- Preserved the existing auth, design, patient, followup, and Task 5 behavior.

Server-authoritative and URL lifecycle rules:

- Monitoring pages render server summary/trends/alerts only.
- No wearable rule engine logic was copied into the client.
- AI confirmation sends only `confirmed` and `doctorRemark`.
- Short-lived access URLs are used only in memory for native download/open/preview and are not routed, stored, logged, copied, or embedded in WebViews.

Tests run:

- Focused Task 6 suite: `node --test test/monitoring-api.test.js test/report-api.test.js test/monitoring-report-pages.test.js`
- Full suite: `node --test`
- Syntax checks: `node --check` across `miniprogram/**/*.js`
- Diff hygiene: `git diff --check`

Results:

- Focused Task 6 suite passed.
- Full suite passed: 76 tests, 0 failures.
- Syntax checks passed.
- `git diff --check` passed with line-ending normalization warnings only.

Commit:

- SHA: `648f635a0238d6933453a2d9a5f4b2c429afa8fe`
- Message: `feat: add native monitoring and reports`

Files changed:

- `miniprogram/app.json`
- `miniprogram/pages/monitoring/index.js`
- `miniprogram/pages/monitoring/index.json`
- `miniprogram/pages/monitoring/index.wxml`
- `miniprogram/pages/monitoring/index.wxss`
- `miniprogram/pages/patient-360/index.js`
- `miniprogram/pages/patient-360/index.json`
- `miniprogram/pages/patient-360/index.wxml`
- `miniprogram/pages/reports/detail.js`
- `miniprogram/pages/reports/detail.json`
- `miniprogram/pages/reports/detail.wxml`
- `miniprogram/pages/reports/detail.wxss`
- `miniprogram/pages/reports/index.js`
- `miniprogram/pages/reports/index.json`
- `miniprogram/pages/reports/index.wxml`
- `miniprogram/pages/reports/index.wxss`
- `miniprogram/utils/monitoring-api.js`
- `miniprogram/utils/report-api.js`
- `test/monitoring-api.test.js`
- `test/monitoring-report-pages.test.js`
- `test/report-api.test.js`

Concerns:

- `git diff --check` emitted line-ending normalization warnings for a few modified files. They are non-blocking and did not affect the verified tests or syntax checks.

Round 1 review fixes:

- Fixed the monitoring trend WXML contract by adding the explicit `wx:for-item="point"` binding so inner trend rows render correctly.
- Fixed report attachment handling so the page only exposes and requests attachments when a real `fileId` is present; `reportId` is no longer used as a file identifier.
- Added regressions for the monitoring WXML binding and the report attachment contract/guard.

Round 1 verification:

- Focused Task 6 suite: `node --test test/monitoring-api.test.js test/report-api.test.js test/monitoring-report-pages.test.js`
- Full suite: `node --test`
- Syntax checks: `node --check` across `miniprogram/**/*.js` and `test/**/*.js`
- Diff hygiene: `git diff --check`
