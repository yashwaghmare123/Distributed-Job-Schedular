# Known Limitations

This list is intentionally explicit so architectural guarantees are not overstated.

- Queue `concurrencyLimit` and worker `concurrency` are stored/configured but not enforced by the current claim path.
- The default worker runtime is synthetic, one per existing queue, and uses an always-success handler; there is no external worker registration protocol.
- `WorkerRecovery` provides heartbeat/stale recovery services, but the default bootstrap does not launch heartbeat emission or stale-worker reaping loops.
- Handler failures are recorded as `FAILED`; automatic invocation of retry scheduling and DLQ processing is not wired into the default worker completion path.
- Retry jitter is represented by a boolean field but is not applied to delay calculations.
- The DLQ processor is reusable and idempotent, but failed jobs do not enter DLQ without processor invocation.
- Batch counters are initialized transactionally and are not updated by job execution transitions; live batch rollup is incomplete.
- There is no public CRUD API for recurring schedule definitions or retry policies.
- There is no worker creation, registration, status-management, or shutdown API.
- WebSocket event delivery is process-local, has no durable replay/acknowledgment, and does not accept API keys.
- Metrics are process-local and reset on restart. Histogram-named metrics are last-value observations, not bucketed histograms.
- Multiple API/WebSocket instances require shared event fan-out and external metrics aggregation; neither is implemented here.
- Multiple active schedulers are not coordinated by a lease or leader election mechanism.
- Exactly-once external side effects are not guaranteed. A crash between handler side effect and completion persistence can lead to repeat execution.
- Execution, log, and heartbeat retention/compaction is not represented by a lifecycle policy.
- API list pagination is offset-based; cursor pagination is not implemented.
- Frontend token storage uses `sessionStorage`, and the dashboard is not a complete organization/member administration control plane.

These are implementation boundaries or future hardening areas, not claims that the project is incorrect. The reusable core services and tests still demonstrate the intended database, state-machine, retry, recovery, and authorization patterns where documented.
