# Reliability and Fault Tolerance

## Guarantees and Semantics

The system provides durable job state, transactional claim ownership, preserved execution attempts, and recovery primitives. Its execution model is **at least once** at the boundary of external effects: a worker may complete an external action and crash before recording completion, after which recovery or a retry can cause another attempt. Exactly-once external side effects require cooperation from the side-effecting system, such as an idempotency key or transactional outbox.

## Failure Matrix

| Failure scenario | Detection | Recovery | Final state |
|---|---|---|---|
| Worker crashes after claim, before start | Stale heartbeat recovery finds `CLAIMED` ownership | Clear claim and return job to queue; attempt count is unchanged | `QUEUED` |
| Worker crashes during execution | Stale recovery finds `RUNNING` job and active execution | Mark execution failed with `WORKER_STALE`; clear claim | `FAILED` |
| Database unavailable | API/worker transaction errors; readiness checks PostgreSQL | Caller retries or service restarts; no in-memory job authority exists | Durable rows remain unchanged or transaction rolls back |
| Handler repeatedly fails | Failed execution and attempt count | Retry processor schedules backoff until limits; DLQ processor handles exhaustion | `RETRY`, then `DEAD_LETTER` when processed |
| Scheduler restarts | Persisted `ScheduledJob.nextRunAt` and concrete jobs | Next process resumes polling from PostgreSQL | Due work remains discoverable |
| Duplicate submission | Queue-scoped unique idempotency constraint | API returns existing row when key conflict is recognized | One job row for that key |
| WebSocket disconnects | Client close/error and socket reconnect logic | Frontend reconnects after 1.5 seconds and restores queue subscriptions; refetches state | Database state unaffected |
| Redis unavailable | Readiness failure and Redis ping check | Rate limiting fails open; queue-depth metric is forced to zero | Jobs remain in PostgreSQL |
| API process shutdown | Signal handler | Stop runtimes, await scheduler tasks, close WebSocket/HTTP, disconnect clients | In-flight handler is awaited; persisted claim recovery depends on heartbeat service |

## Concurrency Safety

`FOR UPDATE SKIP LOCKED` prevents two concurrent claim transactions from selecting the same locked row. Ownership is checked again before starting an execution. The unique `(jobId,attemptNumber)` constraint protects attempt identity. Recovery locks and rechecks stale workers before changing their jobs, allowing concurrent recovery callers to converge safely.

The queue's `concurrencyLimit` and worker `concurrency` are stored configuration, but the current claimer does not count active work or enforce either limit. The current runtime also polls one job at a time per runtime loop. This is a reliability and capacity limitation, not a hidden guarantee.

## Transaction Boundaries

- Registration creates user, organization, and owner membership atomically.
- Batch creation creates the batch and all child jobs atomically.
- Claim selection and ownership update share a transaction.
- Starting an execution updates the job and creates its attempt record atomically.
- Completion/failure updates job and execution atomically.
- Stale recovery changes worker, owned jobs, executions, and recovery logs within a transaction.
- DLQ requeue changes the job and marks the DLQ entry in one transaction.

Handler execution is deliberately outside these database transactions. This limits lock duration but leaves the classic crash window between external work and durable completion.

## Operational Reality

The default bootstrap calls schedule and retry promotion but does not automatically call `scheduleFailedJob` or the DLQ processor after a handler failure. It also does not launch heartbeat emission or stale-worker reaping. These services and tests establish the intended recovery mechanisms, but deployment wiring must invoke them for the full operational loop.
