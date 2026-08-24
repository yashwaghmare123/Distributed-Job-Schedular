# Distributed Job Scheduler - Technical Documentation

This documentation describes the implementation in this repository as it exists today. PostgreSQL is the durable source of truth for tenants, queues, jobs, executions, logs, workers, schedules, and DLQ entries. Redis is auxiliary infrastructure for readiness and rate limiting; it is not the job queue or state store.

## Recommended Reading Order

1. [Architecture](01-ARCHITECTURE.md)
2. [Database Design](02-DATABASE-DESIGN.md)
3. [Job Lifecycle](03-JOB-LIFECYCLE.md)
4. [Worker Architecture](04-WORKER-ARCHITECTURE.md)
5. [Reliability](06-RELIABILITY-AND-FAULT-TOLERANCE.md)
6. [Retry and DLQ](07-RETRY-AND-DLQ.md)
7. [Scheduler](05-SCHEDULER.md)
8. [API](09-API-DOCUMENTATION.md)
9. [Frontend](12-FRONTEND-DASHBOARD.md)
10. [Testing](16-TESTING-STRATEGY.md)
11. [Design Decisions](14-DESIGN-DECISIONS.md)
12. [Evaluation Traceability](21-EVALUATION-TRACEABILITY.md)

## Documentation Map

| Area | Document |
|---|---|
| System architecture | [01-ARCHITECTURE.md](01-ARCHITECTURE.md) |
| Persistence and relationships | [02-DATABASE-DESIGN.md](02-DATABASE-DESIGN.md) |
| Job states and transitions | [03-JOB-LIFECYCLE.md](03-JOB-LIFECYCLE.md) |
| Workers and atomic claiming | [04-WORKER-ARCHITECTURE.md](04-WORKER-ARCHITECTURE.md) |
| Delayed and recurring scheduling | [05-SCHEDULER.md](05-SCHEDULER.md) |
| Failure handling | [06-RELIABILITY-AND-FAULT-TOLERANCE.md](06-RELIABILITY-AND-FAULT-TOLERANCE.md) |
| Backoff and dead letters | [07-RETRY-AND-DLQ.md](07-RETRY-AND-DLQ.md) |
| Batch jobs | [08-BATCH-JOBS.md](08-BATCH-JOBS.md) |
| HTTP contract | [09-API-DOCUMENTATION.md](09-API-DOCUMENTATION.md) |
| Live events | [10-WEBSOCKET-AND-REALTIME.md](10-WEBSOCKET-AND-REALTIME.md) |
| Logs, state, and metrics | [11-OBSERVABILITY.md](11-OBSERVABILITY.md) |
| Operational dashboard | [12-FRONTEND-DASHBOARD.md](12-FRONTEND-DASHBOARD.md) |
| Security model | [13-SECURITY.md](13-SECURITY.md) |
| Architectural rationale | [14-DESIGN-DECISIONS.md](14-DESIGN-DECISIONS.md) |
| Scaling analysis | [15-PERFORMANCE-AND-SCALABILITY.md](15-PERFORMANCE-AND-SCALABILITY.md) |
| Verification approach | [16-TESTING-STRATEGY.md](16-TESTING-STRATEGY.md) |
| Local deployment topology | [17-DEPLOYMENT-AND-SETUP.md](17-DEPLOYMENT-AND-SETUP.md) |
| Evaluator walkthrough | [18-DEMO-GUIDE.md](18-DEMO-GUIDE.md) |
| Diagnosis guide | [19-TROUBLESHOOTING.md](19-TROUBLESHOOTING.md) |
| Honest scope boundary | [20-KNOWN-LIMITATIONS.md](20-KNOWN-LIMITATIONS.md) |
| Requirement mapping | [21-EVALUATION-TRACEABILITY.md](21-EVALUATION-TRACEABILITY.md) |

## Central Engineering Story

Jobs are persisted before they are eligible for work. Workers compete through a PostgreSQL transaction using `FOR UPDATE SKIP LOCKED`, so the database makes the ownership decision. Execution attempts are recorded separately from the current job row. Failures can be scheduled for retry, exhausted failures can be represented in the DLQ, heartbeats provide a recovery signal, the scheduler materializes recurring definitions into concrete jobs, and WebSockets publish authorized lifecycle events to the dashboard.

The limitations document is part of the contract: queue concurrency enforcement, jitter application, automatic retry/DLQ processing, batch counter rollups, and externally registered workers are not complete in the current implementation.
