# ER Diagram

The Prisma schema in `backend/prisma/schema.prisma` is the source of truth for the durable data model. The diagram below reflects the actual models and relationships implemented in the project.

```mermaid
erDiagram
    Organization ||--o{ OrganizationMember : members
    Organization ||--o{ Project : projects
    Organization ||--o{ Worker : workers
    Organization ||--o{ ApiKey : apiKeys

    User ||--o{ OrganizationMember : memberships

    Project ||--o{ Queue : queues
    Project ||--o{ QueueDepthSnapshot : snapshots

    RetryPolicy ||--o{ Queue : queues

    Queue ||--o{ Job : jobs
    Queue ||--o{ JobBatch : batches
    Queue ||--o{ ScheduledJob : scheduledJobs
    Queue ||--o{ QueueDepthSnapshot : snapshots

    JobBatch ||--o{ Job : jobs

    Job ||--o| DeadLetterEntry : deadLetterEntry
    Job ||--o{ JobExecution : executions
    Job ||--o{ Job : childJobs
    Job }o--|| Job : parentJob
    Job }o--o| Worker : claimedWorker

    JobExecution ||--o{ JobLog : logs
    JobExecution }o--|| Worker : worker

    Worker ||--o{ WorkerHeartbeat : heartbeats
    Worker ||--o{ Job : claimedJobs
    Worker ||--o{ DeadLetterEntry : deadLetterEntries

    Organization {
        string id PK
        string name
        datetime createdAt
        datetime updatedAt
    }

    User {
        string id PK
        string email UK
        string passwordHash
        string name
        datetime createdAt
        datetime updatedAt
    }

    OrganizationMember {
        string id PK
        string organizationId FK
        string userId FK
        OrganizationRole role
        datetime createdAt
    }

    Project {
        string id PK
        string organizationId FK
        string name
        string description
        datetime createdAt
        datetime updatedAt
    }

    RetryPolicy {
        string id PK
        string name
        RetryStrategy strategy
        int maxAttempts
        int initialDelayMs
        int maxDelayMs
        Decimal backoffMultiplier
        bool jitter
        datetime createdAt
        datetime updatedAt
    }

    Queue {
        string id PK
        string projectId FK
        string name
        string description
        int defaultPriority
        int concurrencyLimit
        bool isPaused
        string retryPolicyId FK
        datetime createdAt
        datetime updatedAt
    }

    QueueDepthSnapshot {
        string id PK
        string queueId FK
        string projectId FK
        datetime capturedAt
        int queuedCount
        int runningCount
        int scheduledCount
    }

    JobBatch {
        string id PK
        string queueId FK
        int totalJobs
        int completedJobs
        int failedJobs
        int pendingJobs
        datetime createdAt
        datetime updatedAt
    }

    Job {
        string id PK
        string queueId FK
        string batchId FK
        string jobType
        Json payload
        JobStatus status
        int priority
        datetime scheduledAt
        string claimedBy FK
        datetime claimedAt
        int attemptCount
        int maxAttempts
        string idempotencyKey
        string parentJobId FK
        datetime createdAt
        datetime updatedAt
    }

    JobExecution {
        string id PK
        string jobId FK
        string workerId FK
        int attemptNumber
        ExecutionStatus status
        datetime startedAt
        datetime completedAt
        int durationMs
        string errorMessage
        string errorCode
        datetime createdAt
    }

    JobLog {
        string id PK
        string executionId FK
        LogLevel level
        string message
        Json metadata
        datetime createdAt
    }

    Worker {
        string id PK
        string organizationId FK
        string name
        WorkerStatus status
        int concurrency
        int currentJobCount
        datetime lastHeartbeatAt
        datetime startedAt
        datetime stoppedAt
        datetime createdAt
        datetime updatedAt
    }

    WorkerHeartbeat {
        string id PK
        string workerId FK
        WorkerStatus status
        int currentJobCount
        datetime recordedAt
    }

    ScheduledJob {
        string id PK
        string queueId FK
        string jobType
        Json payload
        string cronExpression
        datetime nextRunAt
        bool enabled
        datetime createdAt
        datetime updatedAt
    }

    DeadLetterEntry {
        string id PK
        string jobId FK
        string reason
        string errorMessage
        int attemptCount
        string lastWorkerId FK
        datetime failedAt
        datetime createdAt
        datetime requeuedAt
    }

    ApiKey {
        string id PK
        string organizationId FK
        string name
        string keyHash UK
        datetime lastUsedAt
        datetime expiresAt
        datetime revokedAt
        datetime createdAt
    }
```

## Important relationships and constraints

- `Organization 1 ─── N OrganizationMember`
- `User 1 ─── N OrganizationMember`
- `Organization 1 ─── N Project`
- `Project 1 ─── N Queue`
- `RetryPolicy 1 ─── N Queue`
- `Queue 1 ─── N Job`
- `Queue 1 ─── N JobBatch`
- `Queue 1 ─── N ScheduledJob`
- `Queue 1 ─── N QueueDepthSnapshot`
- `Job 1 ─── N JobExecution`
- `JobExecution 1 ─── N JobLog`
- `Worker 1 ─── N JobExecution`
- `Worker 1 ─── N WorkerHeartbeat`
- `Job 1 ─── 0..1 DeadLetterEntry`
- `Job` can reference a parent `Job` via `parentJobId`, creating a self-relation for child jobs.
- `Job` has a `claimedBy` foreign key to `Worker` and is marked as claimed by a worker in the claim flow.
- `OrganizationMember` enforces a unique pair of `(organizationId, userId)` and a role enum of `OWNER`, `ADMIN`, or `MEMBER`.
- `Queue` enforces a unique pair of `(projectId, name)`.
- `Job` enforces `queueId + idempotencyKey` uniqueness when `idempotencyKey` is present.
- `ScheduledJob` is keyed by `queueId` and the due time index, while `QueueDepthSnapshot` is captured per queue and time bucket.

## Notes

This schema does not include separate tenant tables beyond the organization model. Authorization is primarily organizational, and routes restrict project and queue access by checking the current user’s membership in the relevant organization.
