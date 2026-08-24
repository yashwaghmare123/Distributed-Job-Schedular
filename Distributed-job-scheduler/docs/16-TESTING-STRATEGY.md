# Testing Strategy

The repository contains focused backend tests and frontend Vitest tests. This document describes what the test categories establish; it does not claim a test run or a passing result.

## Correctness Properties

| Property | Evidence area | What it proves |
|---|---|---|
| No double claiming | `jobClaimer` and locking tests | Concurrent claimers cannot own the same locked row |
| Atomic ownership | Worker runtime tests | A worker verifies ownership before starting an attempt |
| Retry correctness | Retry processor tests | Strategies, caps, attempt limits, and due promotion behave consistently |
| DLQ correctness | DLQ processor tests | Exhaustion creates one diagnostic entry and processing is idempotent |
| Worker recovery | Heartbeat/recovery tests | Stale claimed/running work is handled according to state |
| Batch creation | Batch/API tests | Non-empty transactional creation and defaults are preserved |
| Scheduling | Scheduler tests | Cron validation, materialization, next-run advancement, and promotion |
| Authorization | API/security tests | Tenant isolation, resource access, and role restrictions |

## Test Layers

- Unit tests cover state-machine transitions, retry delay mathematics, validation, and focused core behavior.
- Integration-style tests exercise Prisma-backed claiming, worker execution, recovery, API lifecycle, readiness, Redis/rate limits, and WebSocket fan-out.
- API tests cover authentication, tenancy, idempotency, validation, pagination/filtering, batch creation, DLQ, heartbeats, and structured errors.
- Concurrency/recovery tests target row locks, concurrent heartbeats, retry/DLQ idempotency, and stale workers.
- Scheduling tests cover delayed/recurring eligibility and cron progression.
- WebSocket tests cover access, subscription authorization, lifecycle ordering, fan-out, and invalid messages.
- Frontend acceptance tests cover auth redirects, protected shell behavior, views, error states, live events, reconnect behavior, tenancy filtering, and absence of database imports.

## Gaps to Keep Visible

The test inventory demonstrates reusable processor and recovery behavior, but documentation must distinguish that from default bootstrap behavior. The current implementation still needs stronger end-to-end verification for enforced queue concurrency, automatic handler-failure-to-retry/DLQ orchestration, heartbeat/recovery loops in bootstrap, live batch counter rollups, multi-instance WebSocket delivery, and production metrics aggregation.
