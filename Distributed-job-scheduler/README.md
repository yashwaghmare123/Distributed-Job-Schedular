# Distributed Job Scheduler

Production-inspired distributed job scheduling platform for reliably executing asynchronous background jobs across multiple workers.

This is an engineering-focused control plane and runtime, not only a CRUD dashboard. The implementation covers distributed job execution, concurrency control, atomic job claiming, reliability and retries, worker coordination, observability, REST API design, relational database design, and a full-stack operations dashboard.

> **Status:** Core scheduling and execution paths are implemented. The default runtime uses synthetic queue workers, some operational APIs are read-only or absent, and the limitations below are part of the current scope.

## Table of Contents

- [Executive Overview](#executive-overview)
- [Key Engineering Highlights](#key-engineering-highlights)
- [System Architecture](#system-architecture)
- [Job Lifecycle](#job-lifecycle)
- [Core Features](#core-features)
- [Database Design](#database-design)
- [Atomic Job Claiming](#atomic-job-claiming)
- [Worker Architecture](#worker-architecture)
- [Retry and DLQ](#retry-and-dlq)
- [API Overview](#api-overview)
- [Dashboard](#dashboard)
- [Observability](#observability)
- [Security](#security)
- [Testing](#testing)
- [Documentation and Deliverables](#documentation-and-deliverables)
- [Setup](#setup)
- [Project Structure](#project-structure)
- [Design Trade-offs](#design-trade-offs)
- [Bonus / Advanced Features](#bonus--advanced-features)
- [Current Implementation Status](#current-implementation-status)

## Executive Overview

```text
User -> Project -> Queue -> Job -> Scheduler / Worker -> Execution
                                                    |-> Completed
                                                    |-> Retry
                                                    `-> Dead Letter Queue
```

Users create projects and queues, then submit durable JSON jobs with priority, eligibility times, attempt limits, and optional idempotency keys. PostgreSQL persists the job before a queue-specific runtime worker can claim it. The scheduler promotes due work and recurring occurrences; workers claim, execute, and record each attempt.

The design favors explicit state transitions and durable evidence over feature count. PostgreSQL is the source of truth for job ownership, execution history, logs, schedules, workers, and DLQ entries. Redis is auxiliary infrastructure for readiness and rate limiting, not the job queue or state store.

## Key Engineering Highlights

### Reliability

- Atomic job claiming in a PostgreSQL transaction
- Explicit job state machine with legal transition checks
- Retry processor with job and policy attempt limits
- Idempotent dead-letter processing with diagnostic entries
- Worker heartbeat records and stale-worker recovery services
- Graceful runtime shutdown that drains workers and closes dependencies
- Transactional rollback for batches, recurring materialization, and DLQ creation

### Concurrency

- Queue pause and queue concurrency are checked by the claim path
- Worker runtime bounds active local executions by configured concurrency
- `FOR UPDATE SKIP LOCKED` prevents duplicate claim decisions
- Conditional retry updates and unique idempotency constraints handle races

### Scheduling

- Immediate, delayed, and one-time scheduled jobs
- Recurring cron definitions validated with `cron-parser`
- Transactional recurring occurrence materialization
- Transactional batch creation with child jobs
- Descending priority ordering for eligible queued jobs

### Retry System

- Fixed, linear, and exponential delays
- Job and policy maximum attempt checks
- Maximum delay cap
- `FAILED -> RETRY -> QUEUED` orchestration
- Jitter is represented in the schema but is not applied by the calculator

### Observability

- Attempt-level execution records, timestamps, durations, workers, and errors
- Execution-attached job logs and redacted JSON request logs
- Heartbeat history and stale-worker state
- Queue-depth snapshots retained for 30 days
- Project queue-history and worker-utilization APIs
- Process-local Prometheus-style metrics at `/metrics`
- Liveness/readiness at `/health` and `/ready`
- Authenticated WebSocket lifecycle and worker events

### Security and Access

- bcrypt passwords, JWT access/refresh tokens, and hashed API keys
- Organization membership isolation and OWNER/ADMIN project management
- Zod validation and structured errors
- Helmet, CORS, 1 MB JSON limit, request IDs, and Redis-backed rate limits

## System Architecture

The backend process bootstraps the HTTP API, WebSocket hub, scheduler, retry/DLQ processors, and one synthetic runtime worker per existing queue. There is no separate scheduler daemon or standalone worker binary in this repository.

```mermaid
flowchart TB
    User[User] --> Frontend[Next.js operations dashboard]
    Frontend --> API[Express REST API]
    Frontend <--> WS[Authenticated WebSocket /ws]
    API --> Auth[JWT or API-key auth]
    API --> Validation[Zod validation and membership authorization]
    Auth --> DB[(PostgreSQL / Prisma)]
    Validation --> DB
    Runtime[Backend runtime bootstrap] --> Scheduler[Scheduler polling loop]
    Runtime --> Retry[Retry processor]
    Runtime --> DLQ[Dead-letter processor]
    Runtime --> Workers[Queue-specific WorkerRuntime]
    Workers --> Claim[Atomic claim and execution]
    Claim --> Handlers[Registered local job handlers]
    Scheduler --> DB
    Retry --> DB
    DLQ --> DB
    Claim --> DB
    DB --> Events[In-process event bus]
    Events --> WS
    Events --> Metrics[Process metrics and queue snapshots]
    Metrics --> DB
    API --> Redis[(Redis)]
    Runtime --> Redis
    Redis -. readiness and rate limiting .-> API
```

## Job Lifecycle

```mermaid
stateDiagram-v2
    [*] --> QUEUED: immediate or due
    [*] --> SCHEDULED: future scheduledAt
    SCHEDULED --> QUEUED: scheduler promotion
    QUEUED --> CLAIMED: worker claim
    CLAIMED --> RUNNING: ownership check and attempt start
    RUNNING --> COMPLETED: handler succeeds
    RUNNING --> FAILED: handler or stale-worker failure
    FAILED --> RETRY: attempts remain
    RETRY --> QUEUED: retry deadline due
    FAILED --> DEAD_LETTER: attempts exhausted
    DEAD_LETTER --> QUEUED: explicit DLQ requeue
    QUEUED --> CANCELLED: cancel request
    SCHEDULED --> CANCELLED: cancel request
    CLAIMED --> CANCELLED: cancel request
    RUNNING --> CANCELLED: cancel request
    RETRY --> CANCELLED: cancel request
```

| State | Meaning |
|---|---|
| `QUEUED` | Eligible for a worker claim when due and not paused. |
| `SCHEDULED` | Persisted but not yet eligible. |
| `CLAIMED` | A worker owns the job; execution has not started. |
| `RUNNING` | An attempt is active. |
| `COMPLETED` | The handler succeeded. |
| `FAILED` | The latest attempt failed; retry or DLQ processing may follow. |
| `RETRY` | A retry deadline is stored in `scheduledAt`. |
| `DEAD_LETTER` | The effective attempt limit was exhausted and a DLQ entry exists. |
| `CANCELLED` | A cancellable job was explicitly cancelled. |

For `maxAttempts = 3`: `Attempt 1 -> failure -> retry`, `Attempt 2 -> failure -> retry`, `Attempt 3 -> failure -> DEAD_LETTER`. The worker records failure as `FAILED`; the bootstrap scheduler invokes retry or DLQ processing on its polling cycle.

## Core Features

| Capability | Status | Implementation |
|---|---|---|
| Authentication | Implemented | Register, login, refresh, bcrypt passwords, JWT access/refresh tokens. |
| Project management | Implemented | Organization-scoped create, list, update, and guarded deletion. |
| Multiple queues per project | Implemented | Queue names are unique within a project. |
| Queue priority | Implemented | Default priority and descending priority claim ordering. |
| Queue concurrency | Implemented | Claim path checks active queue jobs against `concurrencyLimit`; no horizontal coordination. |
| Retry policies | Implemented | Three strategies exist and are readable; policy CRUD is not exposed. |
| Pause/resume | Implemented | Pausing blocks claims and scheduler promotion without deleting jobs. |
| Immediate jobs | Implemented | Jobs without a future `scheduledAt` begin `QUEUED`. |
| Delayed jobs | Implemented | Future `scheduledAt` creates `SCHEDULED` and is later promoted. |
| Scheduled jobs | Implemented | One-time scheduling and due promotion exist. |
| Recurring jobs |  Implemented| Cron definitions and materialization exist; definition CRUD is incomplete. |
| Batch jobs | Implemented| Transactional creation and child viewing exist; live execution rollups are incomplete. |
| Worker runtime | Implemented | Synthetic local workers are bootstrapped per queue; external registration is absent. |
| Heartbeats |Implemented | API and recovery service exist; no default dedicated reaper loop. |
| Graceful shutdown | Implemented | Workers drain/stop and HTTP, WebSocket, Redis, and Prisma close. |
| Automatic retry | Implemented | Bootstrap processes failed jobs on scheduler ticks; runtime does not retry inline. |
| DLQ | Implemented | Processor, listing, and requeue exist; promotion depends on orchestration. |
| Execution logs | Implemented | Persisted execution logs plus structured request logs. |
| Dashboard | Implemented | Next.js project, queue, job, worker, execution, DLQ, metric, and health views. |
| Metrics | Implemented | Real process/project metrics; process registry resets and histogram names are last-value observations. |
| WebSocket | Implemented | Authenticated subscriptions and events; delivery is process-local and best-effort. |

## Database Design

The normalized Prisma model contains `Organization`, `User`, `OrganizationMember`, `Project`, `Queue`, `RetryPolicy`, `Job`, `JobBatch`, `JobExecution`, `JobLog`, `Worker`, `WorkerHeartbeat`, `ScheduledJob`, `DeadLetterEntry`, `ApiKey`, and `QueueDepthSnapshot`.

UUID primary keys and foreign keys express tenant, project, queue, worker, execution, and schedule ownership. Important indexes cover membership, project/queue ownership, job eligibility and priority, claim status, execution history, worker liveness, schedule due times, DLQ state, and queue-depth ranges. Composite uniqueness protects organization/resource names, queue idempotency keys, execution attempt numbers, and one DLQ entry per job.

Jobs contain status, priority, `scheduledAt`, claim ownership, attempt counters, idempotency, timestamps, and optional batch/parent relationships. Execution rows preserve attempt-level status, worker, timestamps, duration, and errors. Restrictive deletes protect active operational relationships; dependent history and snapshots use cascading deletes, while optional ownership references use `SetNull` where defined.

See the [ER diagram](docs/ER-DIAGRAM.md) and [database design](docs/02-DATABASE-DESIGN.md).

## Atomic Job Claiming

`claimNextJob()` runs in a `READ COMMITTED` transaction. It locks the queue row, rejects paused queues, checks active `CLAIMED`/`RUNNING` jobs, selects the highest-priority due `QUEUED` job, and updates it with `status = CLAIMED`, `claimedBy`, and `claimedAt`. The candidate query uses `FOR UPDATE SKIP LOCKED`, so competing workers cannot both receive the same claim result.

```mermaid
sequenceDiagram
    participant A as Worker A
    participant B as Worker B
    participant DB as PostgreSQL
    A->>DB: Lock queue and select due job
    B->>DB: Compete for the same queue
    DB-->>A: Lock acquired, update to CLAIMED
    DB-->>B: Locked row skipped, no claim
```

The runtime verifies ownership again before moving the job to `RUNNING` and creating `JobExecution`. See `backend/src/core/jobClaimer.ts` and `backend/src/core/workerRuntime.ts`.

## Worker Architecture

Startup discovers existing queues and upserts a synthetic `app-runtime-<queue-prefix>` worker for each one. `WorkerRuntime` polls, respects local active-work capacity, invokes the transactional claim path, verifies ownership, increments attempts, creates an execution, resolves a registered local handler, persists completion/failure and logs, emits events, records heartbeats, and drains active work on shutdown.

Built-in public handlers are `generate_report`, `process_data`, and `send_notification`; an internal intentional-failure handler supports lifecycle testing. Unknown job types fail with `UNSUPPORTED_JOB_TYPE`.

| Setting | Default | Environment variable |
|---|---:|---|
| Scheduler polling | `5000 ms` | `SCHEDULER_POLL_INTERVAL_MS` |
| Worker polling | `250 ms` | `WORKER_POLL_INTERVAL_MS` |
| Worker concurrency | `1` | `WORKER_CONCURRENCY` |
| Heartbeat interval | `5000 ms` | `WORKER_HEARTBEAT_INTERVAL_MS` |
| Stale heartbeat timeout | `20000 ms` | No environment override is defined. |

The default bootstrap does not provide worker registration/status-management APIs or start a dedicated stale-worker reaper loop. See [Worker Architecture](docs/04-WORKER-ARCHITECTURE.md).

## Retry and DLQ

`RetryProcessor` checks both job and queue-policy attempt limits. Eligible failures become `RETRY` with a database-time backoff deadline; due retries become `QUEUED` without changing prior execution history.

| Strategy | Calculation before cap |
|---|---|
| Fixed | `initialDelayMs` |
| Linear | `initialDelayMs * attemptCount` |
| Exponential | `initialDelayMs * backoffMultiplier^(attemptCount - 1)` |

Each delay is capped at `maxDelayMs`. `DeadLetterProcessor` transactionally changes exhausted `FAILED` jobs to `DEAD_LETTER` and creates one entry with reason, error, attempts, last worker, and timestamps. The API can explicitly requeue an active entry and records `requeuedAt` while preserving history. See [Retry & DLQ](docs/07-RETRY-AND-DLQ.md).

## API Overview

The Express JSON API uses bearer access JWTs for protected routes and also accepts HTTP API keys. List responses generally use `{ data, pagination }`; errors use structured `code`, `message`, and optional validation `details`.

| Category | Surface |
|---|---|
| Authentication | Register, login, refresh, API-key creation. |
| Projects | Organization-scoped list and OWNER/ADMIN create/update/delete. |
| Queues | Create/list/update, pause state, priority, concurrency, retry-policy selection. |
| Jobs | Create immediate/delayed jobs, filter, paginate, inspect, cancel, request retry, view executions. |
| Scheduled jobs | Create recurring definitions and list them. |
| Batch jobs | Transactionally create child jobs and filter jobs by batch. |
| Executions | Paginated attempt history with job and worker context. |
| Workers | List organization workers, record heartbeat, view heartbeat history. |
| DLQ | List entries and explicitly requeue. |
| Metrics | Process metrics, queue-depth history, project worker utilization. |
| Health/readiness | `/health`, dependency-aware `/ready`, and request IDs. |

Zod validates bodies, UUIDs, dates, pagination, queue bounds, attempt limits, and batch input. Helmet, CORS, a 1 MB JSON limit, centralized errors, request logging, and Redis-backed auth/read/write/batch rate limits are applied. Worker registration, schedule-definition CRUD, and retry-policy CRUD are not public APIs. See [docs/API.md](docs/API.md) and [docs/09-API-DOCUMENTATION.md](docs/09-API-DOCUMENTATION.md).

## Dashboard

The Next.js frontend is an authenticated operational read model over the API and does not connect directly to Prisma.

- **Projects and queues:** select project context; create, inspect, filter, sort, pause/resume, and edit queue configuration.
- **Jobs:** filter and paginate the ledger; create immediate, delayed, scheduled, recurring, and batch work; inspect metadata and payloads; cancel or request retry where allowed.
- **Job details:** inspect lifecycle state, attempts, worker assignment, timings, errors, retry policy, logs, and live activity.
- **Scheduled, executions, workers, and DLQ:** list real records, inspect heartbeat history, and requeue active DLQ entries.
- **Metrics and health:** view persisted project measurements, process metrics, dependency readiness, and WebSocket status.

The client reconnects WebSockets, restores subscriptions, filters events by project/organization, and refreshes authoritative API data. Settings explicitly report that no editable settings endpoint exists. Charts show no fabricated values when persisted data is absent. See [Frontend Dashboard](docs/12-FRONTEND-DASHBOARD.md).

## Observability

| Information | Source | Behavior |
|---|---|---|
| Current state | Jobs, queues, workers, schedules | Current lifecycle, ownership, capacity, and configuration. |
| Execution history | Executions, logs, DLQ, heartbeats | Attempts, timing, errors, logs, terminal failures, and liveness. |
| Queue history | `QueueDepthSnapshot` | Real queued/running/scheduled counts captured at startup and scheduler ticks; retained 30 days. |
| Process metrics | In-memory registry at `/metrics` | Job/request counters, gauges, and last observations. |

Events include job queued/claimed/running/completed/failed/retry/dead-lettered and worker heartbeat/offline/recovered notifications. WebSocket delivery is live and process-local, not a durable event log. `/ready` checks PostgreSQL, Redis, and WebSocket server attachment; `/health` is static liveness. Metrics reset on restart, and histogram-named metrics do not currently emit buckets, sums, or counts. See [Observability](docs/11-OBSERVABILITY.md).

## Security

Passwords are bcrypt-hashed. Access tokens last 15 minutes, refresh tokens 7 days, and refresh rechecks the user. API keys are returned only at creation, stored as SHA-256 hashes, and checked for expiry/revocation. Resource queries enforce organization membership through project/queue relationships; project management requires OWNER or ADMIN, while most other writes use organization membership rather than fine-grained RBAC.

Input validation, structured errors, Helmet, CORS, request IDs, credential-redacting logs, and Redis fixed-window limits are implemented. WebSockets accept access JWTs in the `token` query parameter, not API keys. Frontend tokens use `sessionStorage`; rate-limit failure is fail-open after authentication. Production must replace the development JWT fallback, protect dependencies, narrow CORS, and terminate TLS. See [Security](docs/13-SECURITY.md).

## Testing

Backend tests exist but `backend/package.json` still defines the placeholder `npm test` script (`echo "Error: no test specified" && exit 1`). This README does not claim that the full suite passes.

The checked-in backend tests cover state transitions, atomic claiming, worker execution, retries, DLQ idempotency, cron scheduling, batches, heartbeats and recovery, API auth/authorization/pagination/idempotency, readiness, metrics, rate limits, WebSocket authorization/fan-out, and runtime bootstrap. Frontend Vitest/Testing Library tests cover authentication views, protected routing, job creation/detail, scheduled and execution views, dashboard errors/live events, reconnect/subscriptions, tenancy filtering, and the frontend secret/database boundary.

Run the configured frontend tests:

```bash
cd frontend
npm test
```

See [Testing](docs/TESTING.md) and [Testing Strategy](docs/16-TESTING-STRATEGY.md) for the complete inventory and gaps.

## Documentation and Deliverables

| Deliverable | Location |
|---|---|
| Architecture | [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) |
| ER Diagram | [docs/ER-DIAGRAM.md](docs/ER-DIAGRAM.md) |
| API Documentation | [docs/API.md](docs/API.md) |
| Design Decisions | [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md) |
| Testing | [docs/TESTING.md](docs/TESTING.md) |
| Configuration | [docs/CONFIGURATION.md](docs/CONFIGURATION.md) |
| Worker Architecture | [docs/04-WORKER-ARCHITECTURE.md](docs/04-WORKER-ARCHITECTURE.md) |
| Job Lifecycle | [docs/03-JOB-LIFECYCLE.md](docs/03-JOB-LIFECYCLE.md) |
| Retry & DLQ | [docs/07-RETRY-AND-DLQ.md](docs/07-RETRY-AND-DLQ.md) |
| Observability | [docs/11-OBSERVABILITY.md](docs/11-OBSERVABILITY.md) |
| Deployment & Setup | [docs/17-DEPLOYMENT-AND-SETUP.md](docs/17-DEPLOYMENT-AND-SETUP.md) |
| Known Limitations | [docs/20-KNOWN-LIMITATIONS.md](docs/20-KNOWN-LIMITATIONS.md) |

## Setup

### Prerequisites

- Node.js compatible with the checked-in Next.js 16 and Prisma dependencies
- Docker Desktop, or reachable PostgreSQL and Redis instances
- PostgreSQL and Redis connectivity

Docker Compose provisions PostgreSQL 17 and Redis 7 Alpine only. It exposes PostgreSQL at `localhost:5433` and Redis at `localhost:6379`.

### Start dependencies

```bash
docker compose up -d postgres redis
```

### Backend

Create `backend/.env`:

```dotenv
DATABASE_URL="postgresql://scheduler:scheduler_password@localhost:5433/job_scheduler?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="replace-with-a-strong-secret"
PORT=3000
```

Install, generate, migrate, and seed:

```bash
cd backend
npm install
npx prisma generate
npx prisma migrate dev
npm run seed
```

Start the complete backend runtime:

```bash
npm run dev
```

`npm start` is the production-style script. For deployment migrations, use `npx prisma migrate deploy`.

### Frontend

Create `frontend/.env.local`:

```dotenv
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
NEXT_PUBLIC_WS_URL=ws://localhost:3000/ws
```

Install and run:

```bash
cd frontend
npm install
npm run dev
```

Available production scripts are `npm run build` and `npm run start`; linting is `npm run lint`.

Backend variables include `DATABASE_URL`, `REDIS_URL`, `JWT_SECRET`, `PORT`, `DB_POOL_MAX`, `SCHEDULER_POLL_INTERVAL_MS`, `WORKER_POLL_INTERVAL_MS`, `WORKER_CONCURRENCY`, `WORKER_HEARTBEAT_INTERVAL_MS`, and `RATE_LIMIT_*` settings. The frontend reads `NEXT_PUBLIC_API_BASE_URL` and `NEXT_PUBLIC_WS_URL`. Defaults are listed in [Configuration](docs/CONFIGURATION.md).

## Project Structure

```text
Distributed-job-scheduler/
├── backend/
│   ├── prisma/{schema.prisma,seed.ts,migrations/}
│   ├── src/{api,core,events,lib,server.ts,*.test.ts}
│   ├── package.json
│   └── prisma.config.ts
├── frontend/
│   ├── app/
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   ├── test/
│   └── package.json
├── docs/
├── docker-compose.yml
├── DESIGN_DECISIONS.md
└── README.md
```

## Design Trade-offs

| Decision | Why | Trade-off |
|---|---|---|
| PostgreSQL durable state | Transactions and constraints make ownership, lifecycle, and history auditable. | The hot path depends on database availability and locks. |
| Redis auxiliary role | Rate limiting and readiness do not require Redis to own jobs. | Redis failure affects readiness and rate-limit behavior. |
| Database-backed claiming | `FOR UPDATE SKIP LOCKED` makes concurrent ownership explicit. | Claiming is more database-bound than a relaxed polling design. |
| Shared backend bootstrap | Local deployment keeps scheduler, workers, and API together. | No independent worker process, leader election, or horizontal coordination. |
| Separate retry and DLQ processors | Retryable work and permanent quarantine have different semantics. | Orchestration must invoke processors; they are not a workflow engine. |
| Separate execution records | Current job state and attempt audit history remain distinct. | More writes and a future retention requirement. |
| WebSocket live hints | The dashboard is responsive while API reads remain authoritative. | No durable replay/acknowledgment or multi-instance fan-out. |

See [DESIGN_DECISIONS.md](DESIGN_DECISIONS.md) and [docs/DESIGN-DECISIONS.md](docs/DESIGN-DECISIONS.md).

## Bonus / Advanced Features

| Feature | Status | Boundary |
|---|---|---|
| API keys | Implemented | Hashed, expirable, revocable HTTP credentials; JWT only for WebSockets. |
| Redis rate limiting | Implemented | Auth/read/write/batch windows; fails open if Redis is unavailable. |
| WebSocket subscriptions | Implemented | Authorized queue/job lifecycle events; process-local delivery. |
| Queue-depth history | Implemented | Real snapshots and history API; no backfill, 30-day cleanup. |
| Worker utilization | Implemented | Derived from persisted project execution/assignment data. |
| Cron recurrence | Implemented | Validated definitions and materialization; no definition CRUD. |
| Batch jobs | Implemented | Transactional creation/viewing; execution-driven counter rollups incomplete. |


## Current Implementation Status

### Core Requirements

- **Implemented:** durable projects, queues, jobs, executions, state transitions, immediate/delayed/scheduled work, priority, pause controls, atomic claims, local worker execution, retry strategies, DLQ processing/API, authenticated REST, and operational frontend views.
- **Partial:** recurring administration, retry-policy administration, batch counters, external worker lifecycle, worker-boundary failure orchestration, heartbeat/reaper orchestration, metric durability, and WebSocket durability.
- **Not implemented:** external worker registration, scheduler leader election, multi-instance event fan-out, shared metrics aggregation, and complete organization/member administration.

### Engineering Quality

- **Concurrency:** PostgreSQL locking, conditional updates, uniqueness constraints, and concurrent claim tests.
- **Reliability:** state machine, transactional rollback, retry/DLQ processors, execution history, and recovery service.
- **Observability:** request IDs, redacted logs, execution logs, heartbeats, snapshots, metrics, readiness, and live events.
- **Testing:** focused backend integration/concurrency tests and frontend acceptance/security tests are checked in; backend package wiring remains incomplete.
- **Documentation:** architecture, data model, lifecycle, worker, scheduler, retry/DLQ, API, security, observability, setup, testing, and limitations documentation exists.
- **Maintainability:** API, scheduler, worker, retry, DLQ, events, and cross-cutting libraries are separated.



