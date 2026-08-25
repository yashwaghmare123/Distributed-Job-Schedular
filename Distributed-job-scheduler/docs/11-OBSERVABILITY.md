# Observability

## Four Kinds of Operational Information

| Kind | Implementation | Use |
|---|---|---|
| Logs | JSON-line logger with request context and recursive credential-like redaction | Explain what happened in a process/request |
| Current state | `Job`, `Worker`, `Queue`, and schedule rows | Answer what is true now |
| Historical execution data | `JobExecution`, `JobLog`, `WorkerHeartbeat`, DLQ records | Explain attempts, timing, errors, and health history |
| Queue-depth history | `QueueDepthSnapshot` rows captured from real queue state on scheduler ticks | Show queue depth only from the point snapshot collection began |
| Metrics | Process-local registry exposed at `/metrics` | Trend counters/gauges within one process lifetime |

## Structured Logs

HTTP logs include request ID, method, route, status, and duration. Job logs attach to an execution and include level, message, timestamp, and optional JSON metadata. Worker, scheduler, retry, and recovery paths also emit process logs or persisted execution logs. Credential-like fields are redacted by the logger; payload handling should still be treated as application-sensitive because payloads are opaque JSON.

## Metrics

The actual registered names are:

- `jobs_created_total`
- `jobs_completed_total`
- `jobs_failed_total`
- `jobs_retried_total`
- `jobs_dead_lettered_total`
- `active_workers`
- `queue_depth`
- `job_execution_duration_ms`
- `http_requests_total`
- `http_request_duration_ms`
- `http_errors_total`

`/metrics` returns HELP/TYPE lines and one numeric sample per name. Although two metrics are labeled histogram, the current registry stores only the last observed value; it does not emit Prometheus buckets, sums, or counts. Metrics are in-memory and reset when the process restarts. `queue_depth` counts `QUEUED`, `CLAIMED`, `RUNNING`, `RETRY`, and `SCHEDULED` jobs. A failed Redis ping forces this gauge to zero, which is a deliberate availability signal but not a database-derived queue count.

## Health and Readiness

`/health` is a static liveness-style response and does not prove dependencies are reachable. `/ready` checks PostgreSQL, Redis, and the attached WebSocket hub, returning component states and 503 with failure names when a configured dependency is unavailable. A WebSocket client connection state is separate from server readiness. Worker health is represented by status, last heartbeat, current count, and heartbeat history; stale online workers are handled by the recovery service when it is invoked.

`GET /projects/:projectId/queues/:queueId/metrics/history` returns bounded, chronological snapshots with real timestamps and queued/running/scheduled counts. Runtime startup captures the first real snapshot immediately, then the existing scheduler tick captures subsequent snapshots and includes newly created queues automatically. Snapshots are retained for 30 days and are never backfilled. `GET /projects/:projectId/metrics/worker-utilization` derives each attributed worker's utilization from persisted project executions or current job assignment, real RUNNING executions, and the worker's configured concurrency. Attributed workers with no running project jobs return `0%`; a project with no persisted attribution returns a null aggregate rather than inventing a worker or capacity.

## Diagnostic Workflow

Use request IDs to correlate an API response with JSON logs. Use a job detail plus its execution list to reconstruct attempts. Use `JobLog` for attempt-level messages, worker heartbeat history for liveness, `/metrics` for process-local signals, and `/ready` for dependency readiness. Treat WebSocket events as hints to refresh, not as historical evidence.
