# Design Decisions

This document records why the current architecture is shaped as it is and where the trade-offs remain visible.

## PostgreSQL as Source of Truth

### Context
Jobs need durable state, relational tenancy, history, and transactional ownership.
### Alternatives
In-memory queues, Redis-only state, or a separate broker plus database projection.
### Chosen Approach
Persist current state, schedules, attempts, logs, workers, and DLQ records in PostgreSQL.
### Reasoning
One durable authority makes restart and audit behavior understandable and lets the database serialize ownership.
### Trade-offs
Database throughput and lock contention become central scaling limits.
### Consequences
All derived views and WebSocket events must defer to database state.

## Row Locks and `SKIP LOCKED`

### Context
Multiple workers must compete without double claiming.
### Alternatives
Application mutexes, optimistic updates, or a broker.
### Chosen Approach
`FOR UPDATE SKIP LOCKED` in a `ReadCommitted` claim transaction.
### Reasoning
The database serializes rows across processes and lets workers skip work already being claimed.
### Trade-offs
The claim query is PostgreSQL-specific and requires careful indexes and transaction boundaries.
### Consequences
Ownership is explicit in `claimedBy` and `claimedAt`.

## Separate Workers and Scheduler

### Context
Eligibility calculation and handler execution have different cadence and failure behavior.
### Alternatives
One monolithic loop or external managed scheduler.
### Chosen Approach
`Scheduler` promotes/materializes; `WorkerRuntime` claims/executes.
### Reasoning
The boundaries are independently testable and let execution scale separately from timing coordination.
### Trade-offs
Bootstrap wiring must coordinate both loops; the current scheduler has no distributed lease.
### Consequences
Restart behavior is driven from persisted rows.

## Separate Execution History and JSON Payloads

### Context
A job has one current projection but potentially many attempts and heterogeneous inputs.
### Alternatives
Overwrite the job row or create type-specific tables.
### Chosen Approach
`JobExecution` per attempt; JSON payload/metadata.
### Reasoning
History remains queryable and payload evolution does not require schema migrations.
### Trade-offs
JSON content has weaker relational validation and execution history grows without a retention subsystem.
### Consequences
Operational views combine current job state with attempt history.

## Queue Configuration, Priority, and Concurrency

### Context
Pause, defaults, retry policy, and work partitioning apply at queue scope.
### Alternatives
Global settings or per-job-only configuration.
### Chosen Approach
Relational `Queue`, copied job priority, queue retry-policy relation, stored concurrency limit.
### Reasoning
Configuration is discoverable and defaults are materialized into a cheap claim row.
### Trade-offs
The current claimer does not enforce queue or worker concurrency, so stored configuration overstates runtime control.
### Consequences
This is documented as a gap rather than a guarantee.

## Configurable Retry and DLQ

### Context
Transient failures need delay; persistent failures must leave the normal flow.
### Alternatives
Immediate retry, infinite retry, or silent discard.
### Chosen Approach
Fixed/linear/exponential policy, max delay/attempts, and diagnostic DLQ entry.
### Reasoning
Backoff limits load and DLQ creates an operator boundary.
### Trade-offs
Jitter is modeled but unused, and failure-to-retry/DLQ orchestration is not automatic in bootstrap.
### Consequences
Processor invocation is an operational integration responsibility.

## Heartbeats, Idempotency, WebSockets, and Batches

### Context
Workers can disappear, clients need current changes, repeated submissions happen, and related jobs need a group identity.
### Chosen Approach
Heartbeat history plus stale recovery, queue-scoped idempotency keys, authorized in-process WebSockets, and transactional batch creation.
### Reasoning
Each feature addresses a distinct ambiguity: liveness, duplicate intent, notification latency, and grouped creation.
### Trade-offs
Heartbeat recovery is not launched by default, WebSockets do not replay, and batch counters are not rolled up after creation.
### Consequences
The implementation provides useful primitives with explicit production-hardening work remaining.

## Metrics and Scaling

### Context
Operators need signals without making metrics the state store.
### Chosen Approach
Separate process-local metric registry and `/metrics` text endpoint.
### Reasoning
Low coupling keeps metrics failures away from job correctness.
### Trade-offs
Metrics reset on restart, lack real histogram buckets, and do not aggregate across instances.
### Consequences
Horizontal deployment needs external metrics and pub/sub infrastructure.
