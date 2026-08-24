# Frontend Dashboard

The Next.js dashboard is an operational read model over the backend API. It does not connect to Prisma or become a second source of truth. The shared hook loads jobs, workers, projects, and queues, subscribes to discovered queues, stores recent events, and refetches after accepted events.

## Views

| Route | Purpose and visible state | Actions and live behavior |
|---|---|---|
| `/dashboard` | Status counts, recent jobs, online workers, event feed | Refresh; live events trigger refetch |
| `/projects` and `/projects/:id` | Projects and queues in a project | Create project; inspect queues |
| `/queues` and `/queues/:id` | Queue names, pause/configuration fields, project context | Create/inspect queues |
| `/jobs` | Paginated/filterable job list | Filter and open details |
| `/jobs/new` | Immediate/delayed job form with JSON payload, priority, attempts, idempotency key | Submit job |
| `/jobs/batch` | Batch creation form | Submit generated child jobs |
| `/jobs/:id` | Job metadata, status, attempts, executions, lifecycle events | Retry/cancel where supported |
| `/executions` | Historical attempt list | Filter/inspect execution records |
| `/scheduled` | Recurring schedule definitions | Read-only listing |
| `/dlq` | Dead-letter entries and associated jobs | Requeue |
| `/workers` and `/workers/:id` | Worker status, count, heartbeat history | Inspect health; no registration API |
| `/metrics` | Raw metrics text | Refresh/view |
| `/health` | Health, readiness, and metrics status | Inspect dependency state |
| `/api-keys` | API key metadata and one-time secret display | Create key |
| `/settings` | Explicit unavailable-settings state | No editable settings API exists |

Loading, empty, and error states are represented in shared shell components. A protected route redirects unauthenticated users to login. The API client stores tokens in `sessionStorage`, refreshes expired access tokens, and sends bearer authentication.

## Live State Mapping

The dashboard shows the `Job.status` projection, `attemptCount`, `maxAttempts`, worker status/count, persisted executions, DLQ entries, and health responses. It receives lifecycle events over `/ws`, filters them to known authorized resources, prepends recent events, and reloads current API state. This makes the UI responsive while preserving PostgreSQL as the authority.

Live updates are best-effort. The socket client reconnects after 1.5 seconds and restores queue subscriptions. A lost event does not permanently define the UI because reload obtains current state. The dashboard is an operational visibility surface, not a complete administrative control plane: worker lifecycle management, schedule CRUD, retry-policy CRUD, organization administration, and reliable batch rollups are absent or read-only in the current backend.
