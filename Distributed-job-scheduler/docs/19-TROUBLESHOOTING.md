# Troubleshooting

## Database

### Symptom
`/ready` returns 503 with a database failure.
### Possible Cause
PostgreSQL is unavailable, the URL is wrong, or migrations/schema are missing.
### Diagnosis
Inspect the readiness failure and database connection configuration.
### Resolution
Restore connectivity and apply the repository's expected Prisma schema/migration workflow.

## Redis

### Symptom
Readiness fails or queue depth reports zero.
### Possible Cause
Redis is unavailable; metrics deliberately zero the queue-depth gauge after a failed ping.
### Diagnosis
Check `REDIS_URL`, Redis health, and `/ready`.
### Resolution
Restore Redis. Job state remains in PostgreSQL; rate limiting fails open.

## Authentication

### Symptom
401 on protected API or WebSocket connection.
### Possible Cause
Expired/wrong token, wrong token type, malformed bearer/API-key syntax, or revoked/expired key.
### Diagnosis
Check access versus refresh token use and credential headers.
### Resolution
Refresh/login for HTTP; use an access JWT for `/ws`.

## Authorization

### Symptom
403 for a resource that exists.
### Possible Cause
The user is not a member of the resource's organization.
### Diagnosis
Trace project/queue ownership and `OrganizationMember` membership.
### Resolution
Use an authorized organization identity; resource existence is not a tenancy grant.

## Worker or Scheduler

### Symptom
Jobs remain queued or schedules do not advance.
### Possible Cause
No queue existed at bootstrap, database connectivity failed, queue is paused, or polling is not running.
### Diagnosis
Inspect worker rows, queue pause state, `/ready`, and scheduler logs.
### Resolution
Restore the process/dependencies and verify the queue. Remember that the default worker handler is synthetic and the default process does not launch heartbeat/recovery loops.

## Retry and DLQ

### Symptom
A failed job remains `FAILED`.
### Possible Cause
Failure recording is separate from retry/DLQ processing.
### Diagnosis
Check execution history and whether the relevant processor was invoked.
### Resolution
Invoke the retry processor while limits remain or the DLQ processor after exhaustion; promotion handles due `RETRY` rows.

## WebSockets

### Symptom
The dashboard does not update live.
### Possible Cause
Disconnected socket, invalid access token, missing queue subscription, or process-local hub boundary.
### Diagnosis
Inspect socket status and subscription messages, then refresh API state.
### Resolution
Allow reconnect; the frontend retries after 1.5 seconds. Use API reload as authoritative recovery.

## Frontend and Configuration

### Symptom
A page is empty or displays an unavailable control.
### Possible Cause
The backend intentionally exposes read-only functionality for schedules, retry policies, workers, or settings.
### Diagnosis
Compare the route with [API Documentation](09-API-DOCUMENTATION.md).
### Resolution
Use the implemented API surface; do not infer missing CRUD endpoints from the UI navigation.

### Symptom
Application starts with insecure authentication behavior.
### Possible Cause
`JWT_SECRET` is unset and the development fallback is active.
### Diagnosis
Inspect environment configuration.
### Resolution
Set a strong production secret and rotate tokens according to deployment policy.
