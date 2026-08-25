# Configuration

This document lists the environment variables that are actually used in the current implementation. It intentionally avoids exposing credentials and uses placeholders instead of real values.

## Environment variables by component

### Backend

| Variable | Purpose | Required | Example | Used by |
|---|---|---:|---|---|
| `DATABASE_URL` | PostgreSQL connection string for Prisma and the app database pool | Yes | `postgresql://scheduler:your-password@localhost:5433/job_scheduler?schema=public` | `backend/src/lib/prisma.ts`, Prisma CLI |
| `REDIS_URL` | Redis connection string used for readiness checks and rate limiting | Yes | `redis://localhost:6379` | `backend/src/lib/redis.ts` |
| `JWT_SECRET` | Secret used to sign and verify JWTs | Optional, defaults to `dev-secret-change-me` | `replace-with-a-strong-secret` | `backend/src/api/lib/auth.ts` |
| `PORT` | HTTP server port | Optional, defaults to `3000` | `3000` | `backend/src/server.ts` |
| `DB_POOL_MAX` | PostgreSQL pool maximum connections | Optional, defaults to `20` | `20` | `backend/src/lib/prisma.ts` |
| `SCHEDULER_POLL_INTERVAL_MS` | Scheduler loop polling interval | Optional, defaults to `5000` | `5000` | `backend/src/server.ts` |
| `WORKER_POLL_INTERVAL_MS` | Worker polling interval | Optional, defaults to `250` | `250` | `backend/src/server.ts` |
| `WORKER_CONCURRENCY` | Runtime worker concurrency per queue | Optional, defaults to `1` | `1` | `backend/src/server.ts` |
| `WORKER_HEARTBEAT_INTERVAL_MS` | Worker heartbeat interval | Optional, defaults to `5000` | `5000` | `backend/src/server.ts` |
| `RATE_LIMIT_AUTH_WINDOW_MS` | Auth rate-limit window | Optional, defaults to `60000` | `60000` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_AUTH_MAX_REQUESTS` | Auth request ceiling for the window | Optional, defaults to `10` | `10` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_READ_WINDOW_MS` | Read-route rate-limit window | Optional, defaults to `60000` | `60000` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_READ_MAX_REQUESTS` | Read route ceiling | Optional, defaults to `120` | `120` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_WRITE_WINDOW_MS` | Write-route rate-limit window | Optional, defaults to `60000` | `60000` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_WRITE_MAX_REQUESTS` | Write route ceiling | Optional, defaults to `60` | `60` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_BATCH_WINDOW_MS` | Batch route rate-limit window | Optional, defaults to `60000` | `60000` | `backend/src/api/middleware/rateLimit.ts` |
| `RATE_LIMIT_BATCH_MAX_REQUESTS` | Batch ceiling | Optional, defaults to `20` | `20` | `backend/src/api/middleware/rateLimit.ts` |

### Frontend

| Variable | Purpose | Required | Example | Used by |
|---|---|---:|---|---|
| `NEXT_PUBLIC_API_BASE_URL` | Base URL for fetch requests to the backend API | Yes | `http://localhost:3000` | `frontend/lib/api.ts` |

## Example backend `.env`

```bash
DATABASE_URL="postgresql://scheduler:your-password@localhost:5433/job_scheduler?schema=public"
REDIS_URL="redis://localhost:6379"
JWT_SECRET="replace-with-a-strong-secret"
PORT=3000
DB_POOL_MAX=20
SCHEDULER_POLL_INTERVAL_MS=5000
WORKER_POLL_INTERVAL_MS=250
WORKER_CONCURRENCY=1
WORKER_HEARTBEAT_INTERVAL_MS=5000
```

## Example frontend `.env.local`

```bash
NEXT_PUBLIC_API_BASE_URL=http://localhost:3000
```

## Notes

- The backend throws an error if `DATABASE_URL` is missing.
- The backend throws an error if `REDIS_URL` is missing.
- The frontend throws an error if `NEXT_PUBLIC_API_BASE_URL` is missing.
- The app does not currently define additional environment variables beyond those above.
- This configuration is the implemented behavior in the checked-in code, not a generalized deployment spec.
