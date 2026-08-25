# Design Decisions

This document records the major engineering choices that are visible in the current codebase. It is intentionally grounded in the actual implementation rather than a generic background discussion.

## 1) PostgreSQL as the durable state store

Decision

- The core job scheduler persists all durable operational state in PostgreSQL.

Context

- The Prisma schema stores organizations, users, members, projects, queues, jobs, executions, logs, workers, heartbeats, scheduled jobs, DLQ entries, API keys, and queue depth snapshots.
- The runtime logic uses Prisma transactions for claim ownership, job execution state changes, retry scheduling, dead-letter creation, and worker recovery.

Reason

- PostgreSQL provides strong transactional semantics for multi-step state changes. The code relies on this to prevent duplicate claim decisions and to make retry/DLQ transitions consistent.

Trade-offs

- It adds database contention to the hot path but gives correctness for queue ownership and execution history.
- The app is dependent on a single durable database for the operational truth.

Alternative considered

- A purely in-memory queue or Redis-only task queue would be simpler but would not match the current job state, execution audit trail, or cross-worker coordination implemented here.

## 2) Redis as auxiliary infrastructure

Decision

- Redis exists for readiness checks and rate limiting rather than as the durable job queue.

Context

- `backend/src/lib/redis.ts` requires `REDIS_URL` and uses `redis-ping` checks in readiness.
- `backend/src/api/middleware/rateLimit.ts` uses Redis-backed limits for auth, read, write, and batch operations.

Reason

- The actual queue state is kept in PostgreSQL and is the source of truth. Redis is not used to hold active job ownership or execution status.

Trade-offs

- Redis is fast and effective for transient checks and rate limiting.
- It does not protect the durability guarantees of job state if PostgreSQL is unavailable.

Alternative considered

- Moving queue state into Redis would reduce DB load but would contradict the implemented use of Prisma and row-level transitions.

## 3) Prisma as the data access layer

Decision

- Prisma is the database abstraction and schema definition layer used by the backend.

Context

- `backend/prisma/schema.prisma` defines enums and models; `backend/src/lib/prisma.ts` creates a Prisma client bound to PostgreSQL.
- The backend uses Prisma queries, transactions, and raw SQL in the same implementation for complex claim and promotion logic.

Reason

- Prisma gives a typed schema model and centralizes migrations, relationships, and query handling.

Trade-offs

- It adds an ORM layer and requires careful transaction design when mixing Prisma and raw SQL.
- The project sometimes uses raw SQL for lock-sensitive operations and time-based predicates because those operations are the critical hot path.

Alternative considered

- Custom SQL only would reduce abstraction overhead but would be less maintainable and less type-safe for the current codebase.

## 4) Atomic job claiming

Decision

- Worker claim decisions are made atomically in PostgreSQL with row locking and `FOR UPDATE SKIP LOCKED`.

Context

- `claimNextJob()` selects eligible jobs from a queue, checks queue pause and concurrency, then updates the selected row in the same transaction.
- It operates under `ReadCommitted` isolation and includes `FOR UPDATE SKIP LOCKED` against the queue row and chosen job row.

Reason

- Multiple workers may poll the same queue concurrently. The implementation prevents two workers from claiming the same queued item.

Trade-offs

- The claim path is more complex and database-bound than a relaxed worker polling design.
- This is necessary for correctness in a multi-worker system.

Alternative considered

- Non-atomic claim assignment would allow duplicate execution and race conditions.

## 5) Bounded worker concurrency

Decision

- Each queue has a concurrency limit and each runtime worker respects it before claiming more jobs.

Context

- `Queue.concurrencyLimit` is stored in PostgreSQL.
- `claimNextJob()` counts active claims and running jobs in the queue before claiming the next row.
- `WorkerRuntime` also tracks `activeJobs` in memory and does not exceed its configured concurrency.

Reason

- A queue can only process a bounded number of jobs at a time; this prevents oversubscription and protects downstream resources.

Trade-offs

- Underutilization is possible when the queue is not busy enough or the concurrency is set low.
- A fixed limit is simpler to reason about than dynamic scheduling.

Alternative considered

- Unbounded worker fan-out would allow queue saturation and could overwhelm external systems or shared infrastructure.

## 6) Centralized retry calculation

Decision

- Retry delay calculation is centralized in `RetryProcessor.calculateRetryDelay()` and uses the queue’s policy metadata.

Context

- `RetryPolicy` includes `strategy`, `initialDelayMs`, `maxDelayMs`, `backoffMultiplier`, and `maxAttempts`.
- `scheduleFailedJob()` checks `attemptCount`, `maxAttempts`, and the policy max before changing state to `RETRY`.

Reason

- This keeps retry rules consistent across all queues and prevents duplicate logic in handlers or route-level code.

Trade-offs

- Retry semantics are coupled to the policy definitions and must be kept in sync with state transitions.
- The calculation uses the implementation’s exact formulas and cannot be silently reinterpreted by an API client.

Alternative considered

- Per-queue ad hoc retry logic would be harder to audit and more error-prone.

## 7) Dead Letter Queue separation

Decision

- Permanent failures are separated from transient retry state into `DeadLetterEntry` rows.

Context

- `DeadLetterProcessor.processDeadLetter()` checks the job’s current status and attempt counts before creating a DB record.
- The actual job status becomes `DEAD_LETTER` when the retry budget is exhausted.

Reason

- A DLQ preserves the fact that a job failed permanently while still leaving the job record and executions auditable.

Trade-offs

- The system keeps historical failure context but also needs additional cleanup and requeue flows to recover from a DLQ.
- A DLQ is intentionally a terminal operational state unless manually requeued.

Alternative considered

- Dropping exhausted jobs or rewriting them in place would reduce information but would hide the terminal failure reason and execution history.

## 8) WebSocket-based live updates

Decision

- The runtime emits job and worker events and the dashboard listens through a WebSocket endpoint.

Context

- `eventBus` publishes events with organization, project, queue, and job metadata.
- `WebSocketHub` validates JWT tokens and only delivers messages to authorized clients.

Reason

- The frontend needs near-real-time updates without polling every resource continuously.

Trade-offs

- WebSockets require connection management and additional auth checks.
- Delivery is best-effort and dependent on a healthy server session; the implementation does not guarantee event persistence beyond the current runtime.

Alternative considered

- Server-side polling only would be simpler but would not provide the real-time behavior implemented here.

## 9) Project isolation and authorization

Decision

- Access is enforced by organization membership rather than a separate project-member table.

Context

- `OrganizationMember` stores the user-to-organization mapping and role.
- Routes check membership on the organization of the project or queue before returning records.

Reason

- The implementation uses organization roles and membership as the working security boundary. Every project-scoped API request must be authorized against that relationship.

Trade-offs

- This is simple and matches the schema, but it does not provide nested project-specific permission scoping beyond the organization boundary.

Alternative considered

- A separate project-member model would increase complexity without matching the actual schema design.

## 10) Queue pause and concurrency trade-offs

Decision

- Queue pause and concurrency are explicit state fields on `Queue`.

Context

- `Queue.isPaused` blocks claiming in `claimNextJob()` and scheduler promotion checks.
- `Queue.concurrencyLimit` blocks additional claims when the active claim count is reached.

Reason

- Operations can temporarily stop a queue while preserving state and allowing later resumption without deleting jobs.

Trade-offs

- Pause and concurrency are coarse-grained controls; they are not per-worker or per-execution dynamic policies.
- This makes operational control simple but less granular than a multi-tier queue scheduler.

Alternative considered

- More complex queue priority classes or dynamic autoscaling would require additional model and runtime features not present here.

## 11) Scheduler polling trade-offs

Decision

- The scheduler is implemented as a polling loop rather than a fully event-driven scheduler.

Context

- `backend/src/server.ts` sets an interval and repeatedly calls `scheduler.promoteDueScheduledJobs()`, `retryProcessor.promoteDueRetries()`, and `materializeDueScheduledJob()`.

Reason

- This is a straightforward, durable implementation that uses the database as the source of truth and avoids a separate scheduling service.

Trade-offs

- Polling introduces latency and periodic database reads.
- It is simpler to operate than a distributed scheduler topology and matches the current architecture.

Alternative considered

- An event-driven scheduler with external schedulers or message buses would provide lower-latency trigger semantics but is not represented in the codebase.

## 12) Worker organization scope

Decision

- Workers are scoped to the organization, not to a single project.

Context

- `Worker` has `organizationId` and is unique on `(organizationId, name)`.
- Queues are project-scoped, but worker runtimes are created per queue and may be reused across queues under the same organization.

Reason

- The code bootstraps one worker runtime per queue but stores worker metadata at the organization level. This is a shared operational resource, not a project-owned one.

Trade-offs

- Organization-level workers simplify shared operational monitoring and reuse.
- It is less granular than a strict per-project worker model.

Alternative considered

- A per-project worker record would be more explicit in some designs, but it does not match the schema or runtime code here.

## 13) Metrics and history visibility

Decision

- The application only shows metrics and history that are backed by persisted data or runtime state.

Context

- `captureQueueDepthSnapshots()` inserts into `QueueDepthSnapshot` and the API reads those records for queue depth history.
- `/metrics` exposes an in-memory registry populated by events and runtime metrics.
- Readiness checks surface unavailable conditions instead of fabricated values.

Reason

- The application reports only values it can compute from the live database or current process state.

Trade-offs

- Some metrics are intentionally unavailable or zero-valued when dependencies fail.
- This is more honest than pretending a metric exists when no durable or live data is available.

Alternative considered

- Fabricated historical series or placeholder values would make dashboards look complete but would be misleading.

## Summary

The current codebase is designed around a durable PostgreSQL state model, a polling scheduler, atomic claims, and explicit retry/DLQ transitions. The key trade-off is correctness and traceability over a more distributed or event-driven orchestration model.
