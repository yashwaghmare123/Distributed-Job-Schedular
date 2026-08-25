# Testing

This repository contains test files in both the backend and frontend, but the documentation below is intentionally honest about what is present and what the code does not currently cover.

## Actual test files in the repository

### Backend tests

The following files are present under `backend/src`:

- `api/api.test.ts`
- `api/heartbeat.test.ts`
- `api/observability.test.ts`
- `api/rateLimit.test.ts`
- `api/readModels.test.ts`
- `core/deadLetterProcessor.test.ts`
- `core/jobBatchCreator.test.ts`
- `core/jobClaimer.test.ts`
- `core/retryProcessor.test.ts`
- `core/scheduler.test.ts`
- `core/workerRecovery.test.ts`
- `core/workerRuntime.test.ts`
- `events/websocket.test.ts`
- `gapfill.test.ts`
- `runtimeBootstrap.test.ts`

### Frontend tests

The following files are present under `frontend/test`:

- `acceptance.test.tsx`
- `dashboard.test.tsx`
- `security.test.ts`
- `setup.ts`

## Actual project script state

`backend/package.json` has a `test` script set to:

```json
"test": "echo \"Error: no test specified\" && exit 1"
```

This means the backend package does not currently define a working in-repo test command. The frontend package does define:

```json
"test": "vitest run"
```

The repository therefore contains test files, but they are not all wired into a single backend test command and this document does not claim they passed.

## Critical functionality that should be covered by automated tests

### Authentication

What should be tested

- Register creates a new user and owner organization
- Login verifies the password and issues tokens
- Refresh rotates access and refresh tokens
- Invalid JWTs fail with `401 UNAUTHORIZED`
- API keys with expiration or revocation are rejected

Expected behavior

- Successful authentication returns access and refresh tokens
- Invalid credentials or stale tokens return structured auth errors

Critical edge cases

- expired refresh token
- invalid `type` claim
- no organization membership for the user
- API key used with wrong hash or revoked record

### Authorization and project isolation

What should be tested

- Organization members can access their own organization’s resources
- Users not in the organization are rejected with `403 FORBIDDEN`
- Project creation requires `OWNER` or `ADMIN`
- Queue creation and job listing respect project organization access
- WebSocket subscriptions are rejected if the token does not match the target organization

Expected behavior

- Cross-org access is denied at every route boundary
- Project-scoped queries filter by `organizationId` membership

Critical edge cases

- user belongs to multiple organizations
- project not found
- queue belongs to a different project
- unauthorized queue subscription

### Project CRUD

What should be tested

- project creation with description and validation errors
- project update with partial payloads
- project deletion when no queues exist
- project deletion rejected when queues remain
- admin/owner enforcement for project management

Expected behavior

- only `OWNER` or `ADMIN` can manage projects
- queue count blocks deletion as implemented in `projects.ts`

### Queue creation, pause, and concurrency

What should be tested

- queue creation within a valid project
- invalid `retryPolicyId` returns `404 NOT_FOUND`
- update of `defaultPriority`, `isPaused`, `concurrencyLimit`, and `retryPolicyId`
- queue pause blocks new claim decisions
- concurrency limit prevents more than `concurrencyLimit` active jobs in a queue

Expected behavior

- `isPaused` changes are honored by the claim query
- active jobs count against the queue limit using `status IN (CLAIMED, RUNNING)`

Critical edge cases

- queue is paused and a retry should not be promoted
- concurrency limit reached exactly at the threshold
- invalid queue update payload

### Atomic job claiming

What should be tested

- one worker claims a job while another worker attempts the same queue
- `FOR UPDATE SKIP LOCKED` behavior is exercised by multiple workers
- claims are rejected when the queue is paused
- jobs scheduled in the future do not claim until due time

Expected behavior

- only one worker can claim the selected row
- the second worker sees no claimable job

Critical edge cases

- due time exactly at `CURRENT_TIMESTAMP`
- `claimedBy` mismatch on stale claim
- concurrency limit blocks additional claims

### Immediate jobs, delayed jobs, and scheduled jobs

What should be tested

- immediate create -> `QUEUED` if `scheduledAt` is not in the future
- delayed create -> `SCHEDULED` when `scheduledAt` is future-dated
- repeated scheduled job materialization updates `nextRunAt`
- scheduler promotion from `SCHEDULED` to `QUEUED` when due
- scheduled jobs with `enabled = false` remain inactive

Expected behavior

- due jobs are promoted without changing scheduling metadata except `nextRunAt`
- `idempotencyKey` prevents duplicate queued records within the queue

Critical edge cases

- invalid cron expression
- next run already due at the time of materialization
- same schedule materialized concurrently

### Recurring and batch jobs

What should be tested

- `ScheduledJob` creation validates cron expression and `nextRunAt`
- recurring run materialization creates a new `Job` row with the correct `idempotencyKey`
- batch creation creates a single `JobBatch` and multiple child jobs
- batch input validation rejects empty arrays and invalid payloads

Expected behavior

- each batch job has the batch association and default queue values
- scheduled batch jobs follow the same queue state model as non-batch jobs

Critical edge cases

- invalid job item with missing `jobType`
- invalid `priority` or `maxAttempts`
- zero-length batch

### Worker execution and heartbeat

What should be tested

- worker heartbeat updates `lastHeartbeatAt` and `currentJobCount`
- stale worker detection restores claimed jobs to `QUEUED`
- stale running jobs are marked `FAILED` with `WORKER_STALE`
- graceful shutdown transitions a worker to `DRAINING` and then `STOPPED`

Expected behavior

- heartbeats keep a worker `ONLINE`
- stale detection resets ownership and marks active execution failed

Critical edge cases

- worker has both `CLAIMED` and `RUNNING` jobs at recovery time
- heartbeat record is rejected for `STOPPED` or `DRAINING` workers

### Job lifecycle

What should be tested

- `QUEUED -> CLAIMED -> RUNNING -> COMPLETED`
- `QUEUED -> CLAIMED -> RUNNING -> FAILED -> RETRY -> QUEUED -> CLAIMED -> RUNNING`
- `FAILED -> DEAD_LETTER` when retry budget is exhausted
- `CANCELLED` transition restrictions for invalid states

Expected behavior

- all job status transitions follow `jobStateMachine.ts`
- `attemptCount` increments on actual execution
- execution history remains linked to the same job record

Critical edge cases

- retry scheduling should not modify the existing execution history
- already terminal jobs cannot be cancelled
- retry is blocked when attempts hit max threshold

### Retry strategies

What should be tested

- `FIXED` delay equals `initialDelayMs`
- `LINEAR` delay equals `initialDelayMs * attemptCount`
- `EXPONENTIAL` delay equals `initialDelayMs * backoffMultiplier^(attemptCount - 1)`
- max delay cap is enforced
- retry is rejected when policy max or job max attempts is reached

Expected behavior

- `RetryProcessor.scheduleFailedJob()` schedules `RETRY` only when eligible
- due retry jobs are promoted to `QUEUED` only when `scheduledAt <= CURRENT_TIMESTAMP`

Critical edge cases

- attempt count 0 is invalid for delay calculation
- queue-local isolation of retry promotion
- policy max attempt check before `DEAD_LETTER`

### DLQ promotion and requeue

What should be tested

- failed jobs are dead-lettered after max attempts are exceeded
- DLQ entry records reason, last worker, and failure count
- requeue from DLQ sets the job back to `QUEUED`
- requeueing a stale DLQ item fails with `409 CONFLICT`

Expected behavior

- the job is marked `DEAD_LETTER` and the entry is unique per job
- `requeuedAt` is populated only on successful requeue

Critical edge cases

- duplicate DLQ creation attempts
- requeue of an already requeued job
- requeue while status is not `DEAD_LETTER`

### Execution logs and observability

What should be tested

- log entries are created at execution start, completion, and failure/retry transitions
- `/health` and `/ready` reflect runtime health
- `/metrics` exposes the text metrics registry values
- queue depth snapshots are persisted and queryable by history route
- worker utilization metrics are aggregated correctly per project

Expected behavior

- readiness reports PostgreSQL, Redis, and WebSocket availability separately
- queue history returns persisted records for the given time range

Critical edge cases

- Redis unavailable leads to degraded readiness and queue depth fallback behavior
- WebSocket not configured or detached
- empty project with no workers

### WebSocket events

What should be tested

- token-based auth is required for `/ws`
- only organization members receive events for accessible queues or jobs
- a queue subscription receives job lifecycle events for that queue
- a job subscription receives job state changes for that job
- unauthorized queue or job ids return a forbidden message

Expected behavior

- broadcast is filtered by organization and subscription context
- event payload includes the proper `type`, `organizationId`, and status change metadata

Critical edge cases

- no queue or job subscription
- invalid JSON message
- disconnection cleanup

### Metrics authorization and scope

What should be tested

- project metrics endpoints are restricted to the user’s organization membership
- queue history endpoints deny access for foreign organizations
- job and worker listings exclude records outside user orgs

Expected behavior

- no cross-project visibility when `request.user.organizationIds` does not include the organization

Critical edge cases

- resource belongs to project in another org
- user belongs to multiple orgs and requests data from one org only

## Test coverage required

The following critical areas are not documented as having implementation-provided, project-wide automated coverage in the code or scripts currently checked in:

- comprehensive auth matrix across all user types and API keys
- full project isolation checks for every route family
- queue pause/resume and concurrency boundary tests at the runtime level
- complete recurring job scheduler lifecycle coverage
- automated maximum-attempt and DLQ policy validation across all retry strategies
- end-to-end WebSocket broadcast authorization and subscription filtering
- full metrics and readiness regression coverage for all unhealthy states

This README-level documentation is intentionally explicit: those tests are required but are not currently represented in the repo’s package scripts or the files inspected here.
