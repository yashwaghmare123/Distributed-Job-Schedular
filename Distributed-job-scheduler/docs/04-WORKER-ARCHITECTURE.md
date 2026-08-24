# Worker Architecture

## Worker Model

A `Worker` row records organization, name, status, configured concurrency, current count, startup/stop times, and the last heartbeat. `WorkerRuntime` is a polling execution loop bound to one queue and one worker ID. The runtime bootstrap creates or upserts a synthetic `app-runtime-<queue-prefix>` worker for every queue and gives it an always-success handler. There is no worker registration or worker creation API in the current HTTP surface.

## Atomic Job Claiming

The unsafe pattern is:

```text
SELECT an eligible job
application checks ownership/capacity
UPDATE the selected job as claimed
```

Two workers can select the same row between the `SELECT` and `UPDATE`, producing duplicate ownership unless the update is conditional and serialized. Application-level mutexes do not solve this across processes or hosts.

The implementation instead uses one PostgreSQL `ReadCommitted` transaction:

```sql
SELECT ...
FROM "Job"
WHERE "queueId" = $queue
  AND "status" = 'QUEUED'
  AND ("scheduledAt" IS NULL OR "scheduledAt" <= CURRENT_TIMESTAMP)
ORDER BY "priority" DESC, "createdAt" ASC
LIMIT 1
FOR UPDATE SKIP LOCKED;

UPDATE "Job"
SET "status" = 'CLAIMED', "claimedBy" = $worker, "claimedAt" = CURRENT_TIMESTAMP
WHERE "id" = $candidate;
```

`FOR UPDATE` locks the selected row until the transaction completes. `SKIP LOCKED` makes another worker skip that row and seek another candidate instead of waiting. Therefore PostgreSQL, not an application process, decides which worker owns a job.

```mermaid
sequenceDiagram
  participant W1 as Worker A
  participant DB as PostgreSQL
  participant W2 as Worker B
  W1->>DB: BEGIN; SELECT ... FOR UPDATE SKIP LOCKED
  W2->>DB: BEGIN; SELECT ... FOR UPDATE SKIP LOCKED
  DB-->>W1: Job J locked
  DB-->>W2: Next unlocked job, or no row
  W1->>DB: UPDATE J CLAIMED by A; COMMIT
  W2->>DB: UPDATE its selected row; COMMIT
```

The claimer orders priority descending and creation time ascending. It does not currently check queue pause, worker status, worker capacity, or queue concurrency. Those fields are persisted and exposed, but enforcement is a known limitation.

## Execution Path

1. Poll `claimNextJob` for the queue.
2. Verify the returned row is `CLAIMED` by this worker.
3. In a transaction, verify ownership again, change `CLAIMED -> RUNNING`, increment attempts, and create `JobExecution`.
4. Persist an execution-start log and publish `job.running`.
5. Invoke the handler.
6. In a transaction, mark the execution and job completed, or mark both failed with error details.
7. Clear claim fields and publish `job.completed` or `job.failed`.

Execution history is not discarded when a job is retried. Logs include start, completion, failure, and retry-related messages where an execution exists.

## Heartbeats and Recovery

The reusable recovery service records a heartbeat every 5 seconds by default and treats an online worker as stale after 20 seconds. It locks and rechecks the worker, marks it `OFFLINE`, resets its current count, returns `CLAIMED` jobs to `QUEUED` without incrementing attempts, and marks `RUNNING` jobs and active executions `FAILED` with `WORKER_STALE`.

The HTTP API exposes heartbeat submission and history. The current bootstrap does not start a heartbeat emission loop or stale-worker recovery loop automatically, so this mechanism exists as a service boundary but is not fully wired into the default process lifecycle.

## Shutdown

`WorkerRuntime.stop()` sets a stop flag and waits for the poll loop. Bootstrap shutdown stops all runtimes, waits for scheduler ticks, closes WebSockets and HTTP, disconnects Redis, and disconnects Prisma. A stop waits for the current handler because the runtime does not cancel handler promises.
