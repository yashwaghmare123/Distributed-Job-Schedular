# API Documentation

This document describes the actual HTTP API implemented in the backend routes under `backend/src/api/routes` and `backend/src/api/index.ts`.

## Authentication model

The backend accepts two auth mechanisms:

- Bearer JWT via `Authorization: Bearer <accessToken>`
- API key via `x-api-key` header or `Authorization: ApiKey <secret>`

The auth middleware sets `request.user` with:

```json
{
  "id": "uuid",
  "email": "user@example.com",
  "organizationIds": ["uuid1", "uuid2"]
}
```

The JWT payload includes `sub`, `email`, `type`, and `orgIds`.

## App-level endpoints

### GET /health

Purpose: Return service health status.

Authentication: None.

Response:

```json
{ "status": "ok" }
```

### GET /ready

Purpose: Check readiness of database, Redis, and WebSocket.

Authentication: None.

Success response:

```json
{
  "status": "ok",
  "database": "ready",
  "redis": "ready",
  "websocket": "ready"
}
```

Failure response:

```json
{
  "status": "error",
  "error": "PostgreSQL unavailable, Redis unavailable",
  "database": "unavailable",
  "redis": "unavailable",
  "websocket": "not_configured"
}
```

### GET /metrics

Purpose: Return Prometheus-style text metrics from the in-memory registry.

Authentication: None.

Response: plain text in the form:

```text
# HELP jobs_created_total Total jobs created
# TYPE jobs_created_total counter
jobs_created_total 3
```

### GET /job-handlers

Purpose: Return registered job handlers that are not flagged as internal.

Authentication: Required (`requireAuth`).

Success response:

```json
{
  "data": [
    {
      "type": "generate_report",
      "label": "Generate Report",
      "description": "Validates report rows and builds a deterministic report summary locally.",
      "payloadExample": {
        "title": "Monthly Sales Report",
        "rows": [
          { "product": "A", "sales": 100 }
        ]
      }
    }
  ]
}
```

### WebSocket /ws

Purpose: Live subscription updates for organization-scoped queue or job events.

Authentication: Required via URL token: `/ws?token=<accessToken>`.

Message examples:

```json
{ "type": "ready" }
```

Subscription payload:

```json
{
  "type": "subscribe",
  "queueId": "uuid",
  "jobId": "uuid"
}
```

The hub validates access to the queue or job before accepting subscriptions.

## Authentication routes

### POST /auth/register

Purpose: Create a new user and a default owner organization.

Authentication: None.

Request body:

```json
{
  "name": "Alice",
  "email": "alice@example.com",
  "password": "Password123!"
}
```

Success response:

```json
{
  "user": {
    "id": "uuid",
    "email": "alice@example.com",
    "name": "Alice"
  },
  "accessToken": "jwt",
  "refreshToken": "jwt"
}
```

Errors:

- `409 CONFLICT` if the email already exists
- `401 UNAUTHORIZED` for invalid input or hash failures

### POST /auth/login

Purpose: Authenticate a user and issue tokens.

Authentication: None.

Request body:

```json
{
  "email": "alice@example.com",
  "password": "Password123!"
}
```

Success response: same shape as register.

### POST /auth/refresh

Purpose: Exchange a refresh token for a new access token and refresh token.

Authentication: None.

Request body:

```json
{ "refreshToken": "jwt" }
```

Success response:

```json
{
  "accessToken": "jwt",
  "refreshToken": "jwt"
}
```

### POST /auth/api-keys

Purpose: Create a new API key for the authenticated user’s first available organization.

Authentication: Required.

Request body:

```json
{
  "name": "automation-key",
  "expiresAt": "2026-12-31T00:00:00.000Z"
}
```

Success response:

```json
{
  "id": "uuid",
  "name": "automation-key",
  "organizationId": "uuid",
  "expiresAt": "2026-12-31T00:00:00.000Z",
  "createdAt": "2026-01-01T00:00:00.000Z",
  "apiKey": "generated-secret"
}
```

## Project routes

### GET /projects

Purpose: List projects available to the authenticated user’s organization memberships.

Authentication: Required.

Query: page, limit.

Success response:

```json
{
  "data": [
    {
      "id": "uuid",
      "organizationId": "uuid",
      "name": "Project A",
      "description": "optional",
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "hasMore": false,
    "total": 1,
    "totalPages": 1
  }
}
```

### POST /projects

Purpose: Create a project.

Authentication: Required.

Authorization: only organization `OWNER` or `ADMIN` users may create projects.

Request body:

```json
{
  "name": "Project A",
  "description": "Optional description"
}
```

Success response: the created project row.

### PATCH /projects/:id

Purpose: Update a project.

Authentication: Required.

Authorization: only `OWNER` or `ADMIN` in the organization.

Request body:

```json
{
  "name": "Renamed project",
  "description": null
}
```

### DELETE /projects/:id

Purpose: Delete a project.

Authentication: Required.

Authorization: only `OWNER` or `ADMIN`.

Notes: returns `409 CONFLICT` if the project still contains queues.

## Queue routes

### GET /projects/:projectId/queues

Purpose: List queues inside a project.

Authentication: Required.

Project scope: requires the user to be a member of the project’s organization.

Success response:

```json
{
  "data": [
    {
      "id": "uuid",
      "projectId": "uuid",
      "name": "email-queue",
      "description": null,
      "defaultPriority": 0,
      "concurrencyLimit": 5,
      "isPaused": false,
      "retryPolicyId": "uuid",
      "retryPolicy": {
        "id": "uuid",
        "name": "seed-fixed",
        "strategy": "FIXED",
        "maxAttempts": 3,
        "initialDelayMs": 5000,
        "maxDelayMs": 30000,
        "backoffMultiplier": "1",
        "jitter": false
      },
      "createdAt": "2026-01-01T00:00:00.000Z",
      "updatedAt": "2026-01-01T00:00:00.000Z"
    }
  ],
  "pagination": {
    "page": 1,
    "limit": 20,
    "hasMore": false,
    "total": 1,
    "totalPages": 1
  }
}
```

### POST /projects/:projectId/queues

Purpose: Create a queue in a project.

Authentication: Required.

Request body:

```json
{
  "name": "email-queue",
  "description": "Optional description",
  "defaultPriority": 0,
  "concurrencyLimit": 5,
  "isPaused": false,
  "retryPolicyId": "uuid"
}
```

### GET /projects/:projectId/queues/:queueId/metrics/history

Purpose: List persisted queue depth snapshots for a queue in a time window.

Authentication: Required.

Query: `hours` (1-720, default 24).

Success response:

```json
{
  "data": [
    {
      "id": "uuid",
      "queueId": "uuid",
      "projectId": "uuid",
      "capturedAt": "2026-01-01T00:00:00.000Z",
      "queuedCount": 1,
      "runningCount": 0,
      "scheduledCount": 2
    }
  ]
}
```

### GET /projects/:projectId/metrics/worker-utilization

Purpose: Compute worker utilization for a project.

Authentication: Required.

Success response:

```json
{
  "workers": [
    {
      "workerId": "uuid",
      "workerName": "runtime-worker-1234",
      "runningJobs": 1,
      "concurrency": 2,
      "utilization": 50,
      "lastHeartbeat": "2026-01-01T00:00:00.000Z",
      "status": "ONLINE"
    }
  ],
  "aggregateUtilization": 25
}
```

### PATCH /queues/:id

Purpose: Update queue configuration.

Authentication: Required.

Allowed fields:

- `defaultPriority`
- `isPaused`
- `concurrencyLimit`
- `retryPolicyId`
- `name`
- `description`

## Job routes

### POST /queues/:id/jobs

Purpose: Create a single job.

Authentication: Required.

Request body:

```json
{
  "jobType": "generate_report",
  "payload": {
    "title": "Sales",
    "rows": [
      { "product": "A", "sales": 100 }
    ]
  },
  "priority": 10,
  "scheduledAt": "2026-06-20T12:00:00.000Z",
  "maxAttempts": 5,
  "idempotencyKey": "unique-key"
}
```

Notes:

- `scheduledAt` is optional; if omitted, the job is created immediately as `QUEUED`
- `Idempotency-Key` can also be provided as a request header
- If an idempotency conflict occurs, the endpoint returns the existing job record with `200 OK`

Success response: the created `Job` row.

### POST /queues/:id/jobs/batch

Purpose: Create a batch of jobs.

Authentication: Required.

Request body:

```json
{
  "jobs": [
    {
      "jobType": "process_data",
      "payload": { "items": [1, 2, 3] },
      "priority": 1,
      "maxAttempts": 3
    }
  ]
}
```

Success response: a `JobBatch` row plus `jobs` array.

### GET /jobs

Purpose: List jobs in the user’s organization, optionally filtered by project or queue.

Authentication: Required.

Supported query filters:

- `projectId`
- `status`
- `queueId`
- `jobType`
- `priority`
- `batchId`
- `page`
- `limit`

### GET /jobs/:id

Purpose: Get a single job including executions and any DLQ entry.

Authentication: Required.

Success response includes:

- queue and project information
- current job row
- ordered execution history
- logs for each execution
- dead-letter entry when present

### GET /jobs/:id/executions

Purpose: List execution records for a job.

Authentication: Required.

Success response:

```json
{
  "data": [
    {
      "id": "uuid",
      "jobId": "uuid",
      "workerId": "uuid",
      "attemptNumber": 1,
      "status": "FAILED",
      "startedAt": "2026-01-01T00:00:00.000Z",
      "completedAt": "2026-01-01T00:00:00.100Z",
      "durationMs": 100,
      "errorMessage": "previous failure",
      "errorCode": "STEP7_TEST_FAILURE",
      "logs": []
    }
  ]
}
```

### POST /jobs/:id/retry

Purpose: Trigger retry scheduling for a failed job using the retry processor.

Authentication: Required.

Success response:

```json
{
  "job": { "id": "uuid", "status": "RETRY" },
  "scheduled": true,
  "delayMs": 15000
}
```

### POST /jobs/:id/cancel

Purpose: Cancel a queued, scheduled, claimed, running, or retry job.

Authentication: Required.

Valid current states from the implementation:

- `QUEUED`
- `SCHEDULED`
- `CLAIMED`
- `RUNNING`
- `RETRY`

The route sets the job status to `CANCELLED` and clears claim ownership.

## Scheduled job routes

### POST /queues/:id/scheduled-jobs

Purpose: Register a cron-based recurring schedule.

Authentication: Required.

Request body:

```json
{
  "jobType": "generate_report",
  "payload": { "title": "Daily report" },
  "cronExpression": "0 9 * * *",
  "nextRunAt": "2026-06-20T09:00:00.000Z",
  "enabled": true
}
```

Success response: the created `ScheduledJob` row.

### GET /scheduled-jobs

Purpose: List scheduled jobs scoped by project and organization.

Authentication: Required.

The response adds derived fields:

- `lastRunAt`
- `runCount`
- `status` as `Enabled` or `Disabled`

## Execution and worker routes

### GET /executions

Purpose: List execution records and associated job/worker metadata.

Authentication: Required.

### GET /workers

Purpose: List workers in the user’s organizations.

Authentication: Required.

Response includes worker metadata and the most recent job assignment summary.

### GET /workers/:id/heartbeats

Purpose: Retrieve heartbeat history for a worker.

Authentication: Required.

### POST /workers/:id/heartbeat

Purpose: Record a heartbeat for an active worker.

Authentication: Required.

Request body:

```json
{ "currentJobCount": 1 }
```

Success response includes `worker` and `heartbeat` sub-objects.

## DLQ routes

### GET /dlq

Purpose: List dead-letter entries.

Authentication: Required.

### POST /dlq/:id/requeue

Purpose: Requeue a dead-letter item.

Authentication: Required.

Behavior:

- verifies the dead-letter entry is still active
- sets the underlying job to `QUEUED`
- clears claim ownership
- records `requeuedAt`

Success response:

```json
{
  "message": "Job requeued from DLQ.",
  "job": {
    "id": "uuid",
    "status": "QUEUED"
  }
}
```

## Retry policies

### GET /retry-policies

Purpose: List seeded/default retry policies.

Authentication: Required.

The route ensures default policies are created if there are no existing rows:

- `seed-fixed`
- `seed-linear`
- `seed-exponential`

Each policy includes:

- `name`
- `strategy`
- `maxAttempts`
- `initialDelayMs`
- `maxDelayMs`
- `backoffMultiplier`
- `jitter`

## Errors and status codes

The error format is structured by `apiErrorHandler` and includes a stable object shape:

```json
{
  "error": {
    "code": "VALIDATION_ERROR",
    "message": "Invalid queue request",
    "details": [
      { "path": "body.name", "message": "Required" }
    ]
  }
}
```

Common codes observed in the implementation:

- `UNAUTHORIZED`
- `FORBIDDEN`
- `NOT_FOUND`
- `CONFLICT`
- `VALIDATION_ERROR`

## Actual route registration

The app registers routes in `backend/src/api/index.ts`:

- `/auth` -> auth router
- `/projects` -> project router
- all remaining API routes from `queues.ts`

This means the queue API is mounted at the top level and not under a base `/api` prefix.

## Notes on scope and authorization

Every project-scoped query and write route verifies the following:

1. The project or queue exists.
2. The user is a member of the relevant organization.
3. The route checks the organization membership before allowing access.

This is the current authorization boundary used by the implementation.
