# API Documentation

The backend is an Express JSON API. Protected routes require an access JWT unless stated otherwise. Responses use JSON; list endpoints commonly return `{ "data": [...], "pagination": { "page", "limit", "hasMore" } }`. Default pagination is page 1, limit 25; limit is 1-100. Errors are structured with an HTTP status, `code`, `message`, and optional validation `details`.

## Authentication and Credentials

| Method | Endpoint | Purpose |
|---|---|---|
| POST | `/auth/register` | Creates a user, organization, and OWNER membership; body `name`, `email`, `password` (minimum 8); returns user, 15-minute access token, 7-day refresh token |
| POST | `/auth/login` | Body `email`, `password`; returns user and both tokens |
| POST | `/auth/refresh` | Body `refreshToken`; validates refresh type and user, then issues both tokens |
| POST | `/auth/api-keys` | Protected; body `name`, optional ISO `expiresAt`; returns metadata and plaintext key once |

Bearer syntax is `Authorization: Bearer <access-token>`. API routes also accept `X-API-Key: <key>` or `Authorization: ApiKey <key>`. API keys are hashed at rest and checked for revocation/expiry. WebSockets accept access JWTs only.

## Organizations, Projects, Queues, and Policies

| Method | Endpoint | Purpose and access |
|---|---|---|
| GET | `/projects` | Projects in the user's memberships |
| POST | `/projects` | Creates a project; OWNER/ADMIN only; body `name`, optional nullable `description` |
| GET | `/projects/:projectId/queues` | Queues for an authorized project |
| POST | `/projects/:projectId/queues` | Creates a queue; member access; body `name`, `description`, `defaultPriority`, `concurrencyLimit` 1-1000, `isPaused`, `retryPolicyId` |
| PATCH | `/queues/:id` | Updates queue name, description, default priority, pause flag, concurrency limit, or retry policy |
| GET | `/retry-policies` | Returns policy ID, name, strategy, and max attempts; read-only |

Duplicate project/queue names and missing foreign keys surface as structured database errors. Queue updates validate the envelope and numeric bounds; membership is checked against the queue's project organization.

## Jobs and Batches

| Method | Endpoint | Purpose and parameters |
|---|---|---|
| POST | `/queues/:id/jobs` | Creates a job. Body: `jobType`, `payload`, optional `priority`, ISO `scheduledAt`, `maxAttempts` 1-50, `idempotencyKey`; supports `Idempotency-Key` header. Future schedule creates `SCHEDULED`, otherwise `QUEUED`. |
| POST | `/queues/:id/jobs/batch` | Body `{jobs:[...]}` with the same item fields; non-empty; transactionally creates batch and children |
| GET | `/jobs` | Filters `status`, `queueId`, `jobType`, `priority`, `batchId`, plus `page` and `limit` |
| GET | `/jobs/:id` | Authorized job, queue/project, executions, and DLQ entry |
| GET | `/jobs/:id/executions` | Attempt history ordered by attempt number |
| POST | `/jobs/:id/retry` | Requests failed-job retry scheduling; may return unscheduled when limits are exhausted |
| POST | `/jobs/:id/cancel` | Cancels jobs in QUEUED, SCHEDULED, CLAIMED, RUNNING, or RETRY |

Example creation request:

```http
POST /queues/QUEUE_UUID/jobs
Authorization: Bearer ACCESS_TOKEN
Idempotency-Key: invoice-42
Content-Type: application/json

{"jobType":"invoice.generate","payload":{"invoiceId":"42"},"priority":10,"maxAttempts":3}
```

The response is the persisted job row. A duplicate idempotency request returns HTTP 200 with the existing row. Payload contents are accepted as JSON; envelope validation rejects invalid types, missing required fields, malformed UUIDs, bad dates, or out-of-range limits.

## Scheduling, Executions, Workers, DLQ

| Method | Endpoint | Purpose |
|---|---|---|
| GET | `/scheduled-jobs` | Paginated recurring definitions visible to the user's organizations |
| GET | `/executions` | Paginated execution history; filters `jobId`, `workerId`, `status` |
| GET | `/workers` | Workers in the user's organizations |
| GET | `/workers/:id/heartbeats` | Heartbeat history for an authorized worker |
| POST | `/workers/:id/heartbeat` | Records heartbeat; body `{currentJobCount}`; rejects STOPPED/DRAINING |
| GET | `/dlq` | DLQ entries, newest failures first |
| POST | `/dlq/:id/requeue` | Requeues an active DLQ entry transactionally |

There are no worker registration/status-management endpoints, retry-policy CRUD endpoints, or schedule-definition CRUD endpoints in the current API.

## Health and Metrics

| Method | Endpoint | Behavior |
|---|---|---|
| GET | `/health` | Static HTTP 200 `{status:"ok"}` |
| GET | `/ready` | 200 when PostgreSQL and Redis checks pass; otherwise 503 with failure names |
| GET | `/metrics` | Prometheus-style text for the process-local metrics registry |

Every request receives or propagates `X-Request-ID`; malformed input produces `400 VALIDATION_ERROR`, missing resources `404 NOT_FOUND`, authorization failures `403 FORBIDDEN`, invalid credentials `401 UNAUTHORIZED`, and state conflicts `409 CONFLICT` where applicable. Helmet, CORS, JSON body limit (1 MB), and Redis-backed rate limits are applied by the server.
