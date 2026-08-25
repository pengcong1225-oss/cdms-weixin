# Miniapp IoT Session Recovery Design

## Scope

Fix the patient miniapp upload path only. Do not deploy, restart services, or change the IoT/CDMS server implementations in this task.

## Confirmed behavior

- Historical queued health batches do not need to be preserved.
- Each patient-scoped upload queue keeps only the newest batch.
- A failed upload remains as the newest retryable batch until a newer sync replaces it.
- When the IoT upload returns HTTP 401 for a logged-in patient, discard the cached wearable token, renew the same wearable session through the authenticated CDMS endpoint, update the queued batch to the renewed session, and retry once.
- Do not retry a second 401 and do not attempt automatic Manager handoff reuse for doctor sessions.
- Preserve HTTP status and response details on request errors so callers can distinguish authentication failures.

## Acceptance criteria

1. Enqueuing two batches for one patient leaves only the second batch.
2. An HTTP 401 exposes `statusCode === 401` and the response payload on the error.
3. Patient upload flow renews the existing session ID and succeeds after one 401.
4. A second 401 is returned to the caller without a renewal loop and the latest batch remains queued.
5. Existing project tests and JavaScript syntax checks remain green.

