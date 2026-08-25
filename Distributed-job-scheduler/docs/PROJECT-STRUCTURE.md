# Project Structure

This repository is organized around a backend service and a frontend dashboard. The implementation is split between persistent operational data in PostgreSQL and runtime orchestration in the Node.js backend process.

## Top-level structure

```text
Distributed-job-scheduler/
├── backend/
│   ├── prisma/
│   │   ├── schema.prisma
│   │   ├── seed.ts
│   │   └── migrations/
│   ├── src/
│   │   ├── api/
│   │   ├── core/
│   │   ├── events/
│   │   ├── lib/
│   │   ├── server.ts
│   │   └── *.test.ts
│   ├── package.json
│   ├── prisma.config.ts
│   └── tsconfig.json
├── frontend/
│   ├── app/
│   ├── components/
│   ├── hooks/
│   ├── lib/
│   ├── test/
│   ├── package.json
│   ├── next.config.ts
│   ├── tsconfig.json
│   └── vitest.config.ts
├── docs/
├── docker-compose.yml
├── DESIGN_DECISIONS.md
├── README.md
└── .gitignore
```

## backend/

This folder holds the scheduler backend implementation.

### backend/prisma/

Responsible for durable schema and database setup.

- `schema.prisma` — the PostgreSQL schema for all application entities
- `seed.ts` — seed logic used by Prisma
- `migrations/` — database migration history

### backend/src/api/

Responsible for HTTP entry points and API behavior.

- `index.ts` — app bootstrap, middleware registration, health/readiness/metrics routes, and route mounting
- `routes/auth.ts` — register/login/refresh and API key creation
- `routes/projects.ts` — project CRUD operations
- `routes/queues.ts` — queue, job, scheduled job, execution, worker, and DLQ routes
- `middleware/auth.ts` — JWT and API key authentication
- `middleware/rateLimit.ts` — request throttling behavior
- `lib/auth.ts` — JWT and password helpers
- `lib/apiKeys.ts` — API key generation and hashing
- `lib/errors.ts` — centralized HTTP error handling
- `lib/validation.ts` — request parsing and validation helpers

### backend/src/core/

Responsible for queue orchestration, worker execution, state transitions, retry, and dead-letter logic.

- `jobClaimer.ts` — atomic queue claiming logic
- `jobStateMachine.ts` — permitted job state transition map
- `workerRuntime.ts` — worker runtime, polling, execution, and completion/failure handling
- `workerRecovery.ts` — stale-worker recovery and heartbeat logic
- `scheduler.ts` — cron scheduling and job promotion
- `retryProcessor.ts` — retry scheduling and delay computation
- `deadLetterProcessor.ts` — DLQ entry creation and expired job handling
- `jobHandlers.ts` — registered job handler definitions and default handlers
- `jobBatchCreator.ts` — batch job creation logic

### backend/src/events/

Responsible for event bus and live update delivery.

- `eventBus.ts` — in-process event publication and metric updates
- `eventTypes.ts` — event schema types
- `websocketHub.ts` — authenticated WebSocket subscription and broadcast engine
- `websocket.test.ts` — WebSocket behavior tests

### backend/src/lib/

Cross-cutting runtime dependencies.

- `prisma.ts` — Prisma client configured with a PostgreSQL pool
- `redis.ts` — Redis client used for readiness and rate limiting
- `metrics.ts` — metric registry and queue depth snapshots
- `logger.ts` — request logging
- `readiness.ts` — health and readiness checks

### backend/src/server.ts

The runtime bootstrap file:

- starts the HTTP server
- attaches the WebSocket hub
- creates the scheduler and retry/DLQ processors
- starts one worker runtime per queue
- handles shutdown and graceful cleanup

## frontend/

This folder contains the Next.js dashboard.

### frontend/app/

The app router pages.

- `login/`, `register/` — auth screens
- `(app)/` — authenticated shell and pages for projects, queues, jobs, workers, DLQ, metrics, and settings
- `page.tsx` — root redirect to the app shell

### frontend/components/

Presenter components such as charts and shell layout.

- `MetricCharts.tsx`
- `OverviewMetrics.tsx`
- `Pagination.tsx`
- `Shell.tsx`

### frontend/hooks/

Frontend-side state hooks.

- `useScheduler.ts` — scheduler state access for the dashboard UI

### frontend/lib/

Frontend domain and API helpers.

- `api.ts` — API client wrapper and project-scoped query helpers
- `projectContext.tsx` — project state and context
- `socket.ts` — WebSocket event handling in the client
- `types.ts` — TypeScript resource models

### frontend/test/

Frontend tests written with Testing Library and Vitest.

## docs/

Repository-level implementation documentation.

- `README.md` — documentation index
- `ARCHITECTURE.md` — deployment and runtime architecture
- `ER-DIAGRAM.md` — Prisma model relationships
- `API.md` — route-by-route API documentation
- `DESIGN-DECISIONS.md` — engineering rationale
- `TESTING.md` — actual tests and required gap coverage
- `PROJECT-STRUCTURE.md` — repository layout
- `CONFIGURATION.md` — environment variables
- `GLOSSARY.md` — project terminology

## Root-level artifacts

- `docker-compose.yml` — only PostgreSQL and Redis services are defined
- `DESIGN_DECISIONS.md` — a separate project-level design note already present in the repository root
- `README.md` — top-level setup and developer instructions
