# Performance and Scalability

## Hot Paths

The claim query is the primary execution hot path: filter by queue/status/due time, order by priority and creation time, lock one row, and update ownership. The composite status/schedule/priority/creation index supports that shape. Queue/status and claimed/status indexes support queue views and recovery. Execution, heartbeat, schedule, and DLQ indexes align with their time-ordered operational queries.

Workers can scale horizontally because `SKIP LOCKED` avoids waiting on already-claimed rows. PostgreSQL remains the contention point: many workers polling empty queues, hot queues, long transactions, and high write rates for execution/log/heartbeat history all increase load. Poll intervals trade database pressure against pickup latency.

## Scaling Boundaries

- **Workers:** multiple worker processes/hosts are compatible with atomic claims, but current runtime loops execute one claimed job at a time and do not enforce stored concurrency limits.
- **API:** API instances can share PostgreSQL, but process-local metrics and event bus state do not aggregate.
- **Scheduler:** persisted definitions survive restart, but there is no leader/lease to coordinate multiple scheduler instances.
- **WebSockets:** the hub is process-local. A load-balanced deployment needs sticky routing or shared pub/sub plus connection-aware authorization.
- **Redis:** currently supports rate-limit counters and readiness only. It can be scaled independently, but scaling it does not scale job claiming.
- **Batches:** transactional insertion is simple for moderate batches; large batches increase transaction duration and row creation cost.
- **Pagination:** APIs use bounded offset pagination. Deep offsets can become slower; cursor pagination is a future optimization.

## Capacity Risks and Improvements

Database connection pool sizing, index maintenance, retention of execution/log/heartbeat history, and bounded polling are likely first operational concerns. Improvements should preserve the current ownership contract: partition polling by queue, add explicit capacity predicates or leases, use cursor pagination, externalize metrics, and coordinate schedulers through a database lease or another durable leader mechanism. No benchmark numbers are asserted because the repository does not provide benchmark evidence.
