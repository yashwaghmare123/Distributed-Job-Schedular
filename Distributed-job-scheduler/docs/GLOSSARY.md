# Glossary

This glossary uses the terminology implemented in the current codebase and database schema.

## Project

A project belongs to an organization and contains queues. Projects are the general container for scheduling and operational work in a tenant context.

## Queue

A queue is a project-scoped work stream with a name, optional description, default priority, concurrency limit, pause state, and retry policy.

## Job

A job is the execution unit in the queue. It has a `jobType`, `payload`, `status`, `priority`, `scheduledAt`, attempt metadata, and optional idempotency key.

## Worker

A worker is an organization-scoped runtime process that claims jobs for a queue. It records a status (`ONLINE`, `OFFLINE`, `DRAINING`, `STOPPED`), concurrency, heartbeat timestamps, and current job count.

## Scheduler

The scheduler component is the polling loop that promotes due scheduled jobs and due retry jobs, and materializes recurring jobs from `ScheduledJob` definitions.

## Execution

An execution is a single attempt of a job on a worker. It is created as a `JobExecution` row with `attemptNumber`, status, timestamps, and optional error details.

## Attempt

An attempt is a single execution of a given job. The `Job.attemptCount` field increments when the worker moves the job from `CLAIMED` to `RUNNING`.

## Retry

A retry is a temporary transition from `FAILED` back to `RETRY` with an updated `scheduledAt` based on the queue’s retry policy. Retries are later promoted back to `QUEUED` when due.

## Backoff

Backoff is the delay applied before a failed job is eligible to run again. The implementation supports `FIXED`, `LINEAR`, and `EXPONENTIAL` strategies.

## DLQ

DLQ stands for dead-letter queue, implemented as a `DeadLetterEntry` row. A job enters the DLQ when it has exhausted its retry budget and is marked `DEAD_LETTER`.

## Heartbeat

A heartbeat records the worker’s online state and current job count. The worker runtime and `WorkerRecovery` class use heartbeats to determine stale workers.

## Claim

A claim is the ownership transfer from a `QUEUED` job to a specific worker. The claim is stored in `Job.claimedBy` and `Job.claimedAt`.

## Concurrency

Concurrency is the number of jobs a queue or worker may actively process at the same time. Queue-level concurrency is enforced in `claimNextJob()`, while worker runtime concurrency is enforced in `WorkerRuntime`.

## Scheduled Job

A scheduled job is a cron-driven definition stored in `ScheduledJob`. It is materialized into a concrete `Job` record when due.

## Recurring Job

A recurring job is represented by a `ScheduledJob` row with a cron expression and next scheduled run time. The scheduler materializes it periodically.

## Batch Job

A batch job is a group of jobs recorded in a single `JobBatch` row. Each job in the batch may be scheduled separately or created immediately.

## Job Handler

A job handler is a function registered in `jobHandlers.ts` that processes a specific `jobType` and returns success or failure information.

## WebSocket

The WebSocket layer is the real-time event channel implemented in `WebSocketHub`. It authenticates incoming clients with a JWT and emits queue/job events to authorized subscribers.

## Queue Depth

Queue depth is a count of queued, claimed, retry, and scheduled jobs in a queue. The system persists snapshots in `QueueDepthSnapshot` and exposes historical views through a metrics route.
