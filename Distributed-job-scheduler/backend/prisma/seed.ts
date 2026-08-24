import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import {
  ExecutionStatus,
  JobStatus,
  LogLevel,
  OrganizationRole,
  Prisma,
  PrismaClient,
  RetryStrategy,
  WorkerStatus
} from "@prisma/client";

const processEnvironment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const databaseUrl = processEnvironment?.DATABASE_URL;
if (!databaseUrl) throw new Error("DATABASE_URL is required to run the seed.");

const adapter = new PrismaPg({ connectionString: databaseUrl });
const prisma = new PrismaClient({ adapter });
const seedNow = new Date("2027-01-15T12:00:00.000Z");
const retryEligibleAt = new Date("2027-01-15T12:05:00.000Z");
const scheduledAt = new Date("2027-01-16T09:00:00.000Z");
const apiKeyExpiresAt = new Date("2028-01-15T12:00:00.000Z");

const developmentPasswordHash =
  "$2b$12$Zwa1qNB3SXvbfNsdJRy.cObcu0UjRddwYn21GhFopcZuC8ml20qI6";

type SeedOrganization = {
  name: string;
  users: Array<{ email: string; name: string; role: OrganizationRole }>;
};

type SeedJob = {
  key: string;
  queueId: string;
  status: JobStatus;
  jobType: string;
  payload: Prisma.InputJsonObject;
  priority: number;
  scheduledAt: Date;
  maxAttempts: number;
  attemptCount: number;
  claimedBy?: string;
  claimedAt?: Date;
  batchId?: string;
};

const organizations: SeedOrganization[] = [
  {
    name: "Codity Demo Org",
    users: [
      { email: "admin@codity.dev", name: "Codity Admin", role: OrganizationRole.OWNER },
      { email: "member@codity.dev", name: "Codity Member", role: OrganizationRole.MEMBER },
      { email: "ops@codity.dev", name: "Codity Operations", role: OrganizationRole.ADMIN }
    ]
  },
  {
    name: "Northstar Analytics",
    users: [
      { email: "owner@northstar.dev", name: "Northstar Owner", role: OrganizationRole.OWNER },
      { email: "analyst@northstar.dev", name: "Northstar Analyst", role: OrganizationRole.MEMBER },
      { email: "ops@northstar.dev", name: "Northstar Operations", role: OrganizationRole.ADMIN }
    ]
  }
];

const retryPolicies = [
  { name: "seed-fixed", strategy: RetryStrategy.FIXED, maxAttempts: 3, initialDelayMs: 5000, maxDelayMs: 30000, backoffMultiplier: 1 },
  { name: "seed-linear", strategy: RetryStrategy.LINEAR, maxAttempts: 4, initialDelayMs: 10000, maxDelayMs: 120000, backoffMultiplier: 1 },
  { name: "seed-exponential", strategy: RetryStrategy.EXPONENTIAL, maxAttempts: 5, initialDelayMs: 15000, maxDelayMs: 300000, backoffMultiplier: 2 }
];

async function findOrCreateOrganization(name: string) {
  const existing = await prisma.organization.findFirst({ where: { name } });
  if (existing) return { record: existing, createdNow: false };

  return {
    record: await prisma.organization.create({ data: { name, createdAt: seedNow, updatedAt: seedNow } }),
    createdNow: true
  };
}

async function findOrCreateRetryPolicy(policy: (typeof retryPolicies)[number]) {
  const existing = await prisma.retryPolicy.findFirst({
    where: { name: policy.name, strategy: policy.strategy }
  });
  if (existing) return existing;

  return prisma.retryPolicy.create({
    data: {
      ...policy,
      backoffMultiplier: policy.backoffMultiplier,
      jitter: policy.strategy !== RetryStrategy.FIXED,
      createdAt: seedNow,
      updatedAt: seedNow
    }
  });
}

async function findOrCreateScheduledJob(queueId: string, jobType: string, cronExpression: string, payload: Prisma.InputJsonObject) {
  const existing = await prisma.scheduledJob.findFirst({
    where: { queueId, jobType, cronExpression }
  });
  if (existing) return existing;

  return prisma.scheduledJob.create({
    data: { queueId, jobType, cronExpression, payload, nextRunAt: scheduledAt, enabled: true, createdAt: seedNow, updatedAt: seedNow }
  });
}

async function findOrCreateBatch(queueId: string) {
  // queueId is the intentional development identity because JobBatch has no name field.
  const existing = await prisma.jobBatch.findFirst({ where: { queueId } });
  if (existing) return existing;

  return prisma.jobBatch.create({
    data: { queueId, totalJobs: 0, completedJobs: 0, failedJobs: 0, pendingJobs: 0, createdAt: seedNow, updatedAt: seedNow }
  });
}

async function upsertJob(job: SeedJob) {
  return prisma.job.upsert({
    where: { queueId_idempotencyKey: { queueId: job.queueId, idempotencyKey: job.key } },
    update: {
      status: job.status,
      jobType: job.jobType,
      payload: job.payload,
      priority: job.priority,
      scheduledAt: job.scheduledAt,
      maxAttempts: job.maxAttempts,
      attemptCount: job.attemptCount,
      claimedBy: job.claimedBy ?? null,
      claimedAt: job.claimedAt ?? null,
      batchId: job.batchId ?? null
    },
    create: {
      queueId: job.queueId,
      idempotencyKey: job.key,
      status: job.status,
      jobType: job.jobType,
      payload: job.payload,
      priority: job.priority,
      scheduledAt: job.scheduledAt,
      maxAttempts: job.maxAttempts,
      attemptCount: job.attemptCount,
      claimedBy: job.claimedBy ?? null,
      claimedAt: job.claimedAt ?? null,
      batchId: job.batchId ?? null,
      createdAt: seedNow,
      updatedAt: seedNow
    }
  });
}

async function findOrCreateExecution(data: {
  jobId: string;
  workerId: string;
  attemptNumber: number;
  status: ExecutionStatus;
  startedAt: Date;
  completedAt: Date | null;
  durationMs: number;
  errorMessage: string | null;
  errorCode: string | null;
}) {
  const existing = await prisma.jobExecution.findUnique({
    where: { jobId_attemptNumber: { jobId: data.jobId, attemptNumber: data.attemptNumber } }
  });
  if (existing) return { record: existing, createdNow: false };

  return {
    record: await prisma.jobExecution.create({
      data: { ...data, createdAt: seedNow }
    }),
    createdNow: true
  };
}

const developmentApiKeyHashes = {
  codity: "3ae5b82fd069531e06cdd606f2818a410b5ae52b148a0b75c27d689875d0a60f",
  northstar: "6ee4450cc1c49b75af01dc7a13f23bd1f3a92bec3900518dc24040e0549b1e72"
};

async function main() {
  const orgRecords = new Map<string, Awaited<ReturnType<typeof findOrCreateOrganization>>["record"]>();
  for (const organization of organizations) {
    const result = await findOrCreateOrganization(organization.name);
    orgRecords.set(organization.name, result.record);

    for (const user of organization.users) {
      const userRecord = await prisma.user.upsert({
        where: { email: user.email },
        update: { name: user.name, passwordHash: developmentPasswordHash },
        create: { email: user.email, name: user.name, passwordHash: developmentPasswordHash, createdAt: seedNow, updatedAt: seedNow }
      });
      await prisma.organizationMember.upsert({
        where: { organizationId_userId: { organizationId: result.record.id, userId: userRecord.id } },
        update: { role: user.role },
        create: { organizationId: result.record.id, userId: userRecord.id, role: user.role, createdAt: seedNow }
      });
    }
  }

  const policies = new Map<string, Awaited<ReturnType<typeof findOrCreateRetryPolicy>>>();
  for (const policy of retryPolicies) policies.set(policy.name, await findOrCreateRetryPolicy(policy));

  const projects = new Map<string, { id: string; organizationId: string }>();
  const queues = new Map<string, { id: string; organizationId: string }>();
  const projectSeeds = [
    { key: "codity-scheduler", org: "Codity Demo Org", name: "Scheduler Demo" },
    { key: "codity-notifications", org: "Codity Demo Org", name: "Notification Platform" },
    { key: "northstar-analytics", org: "Northstar Analytics", name: "Analytics Platform" }
  ];
  for (const projectSeed of projectSeeds) {
    const organization = orgRecords.get(projectSeed.org);
    if (!organization) throw new Error(`Missing organization ${projectSeed.org}`);
    const project = await prisma.project.upsert({
      where: { organizationId_name: { organizationId: organization.id, name: projectSeed.name } },
      update: { description: `Deterministic seed project: ${projectSeed.key}` },
      create: { organizationId: organization.id, name: projectSeed.name, description: `Deterministic seed project: ${projectSeed.key}`, createdAt: seedNow, updatedAt: seedNow }
    });
    projects.set(projectSeed.key, { id: project.id, organizationId: organization.id });

    for (const queueName of ["default", "email", "reports"]) {
      const policyName = queueName === "email" ? "seed-exponential" : queueName === "reports" ? "seed-linear" : "seed-fixed";
      const queue = await prisma.queue.upsert({
        where: { projectId_name: { projectId: project.id, name: queueName } },
        update: { retryPolicyId: policies.get(policyName)!.id, defaultPriority: queueName === "email" ? 10 : 0, concurrencyLimit: queueName === "reports" ? 2 : 5, isPaused: queueName === "reports" },
        create: { projectId: project.id, name: queueName, description: `${queueName} processing queue`, defaultPriority: queueName === "email" ? 10 : 0, concurrencyLimit: queueName === "reports" ? 2 : 5, isPaused: queueName === "reports", retryPolicyId: policies.get(policyName)!.id, createdAt: seedNow, updatedAt: seedNow }
      });
      queues.set(`${projectSeed.key}:${queueName}`, { id: queue.id, organizationId: organization.id });
    }
  }

  const workers = new Map<string, { id: string; organizationId: string }>();
  const workerSeeds = [
    { key: "codity-worker-1", org: "Codity Demo Org", status: WorkerStatus.ONLINE },
    { key: "codity-worker-2", org: "Codity Demo Org", status: WorkerStatus.DRAINING },
    { key: "northstar-worker-1", org: "Northstar Analytics", status: WorkerStatus.OFFLINE },
    { key: "northstar-worker-2", org: "Northstar Analytics", status: WorkerStatus.STOPPED }
  ];
  for (const workerSeed of workerSeeds) {
    const organization = orgRecords.get(workerSeed.org);
    if (!organization) throw new Error(`Missing organization ${workerSeed.org}`);
    const existing = await prisma.worker.findUnique({ where: { organizationId_name: { organizationId: organization.id, name: workerSeed.key } } });
    const worker = existing ?? await prisma.worker.create({
      data: { organizationId: organization.id, name: workerSeed.key, status: workerSeed.status, concurrency: 5, currentJobCount: 0, lastHeartbeatAt: seedNow, startedAt: seedNow, stoppedAt: workerSeed.status === WorkerStatus.STOPPED ? seedNow : null, createdAt: seedNow, updatedAt: seedNow }
    });
    if (existing) await prisma.worker.update({ where: { id: worker.id }, data: { status: workerSeed.status, lastHeartbeatAt: seedNow, stoppedAt: workerSeed.status === WorkerStatus.STOPPED ? seedNow : null } });
    workers.set(workerSeed.key, { id: worker.id, organizationId: organization.id });
    if (!existing) await prisma.workerHeartbeat.create({ data: { workerId: worker.id, status: workerSeed.status, currentJobCount: 0, recordedAt: seedNow } });
  }

  await findOrCreateScheduledJob(queues.get("codity-scheduler:default")!.id, "daily-summary", "0 9 * * *", { report: "daily-summary", tenant: "codity" });
  await findOrCreateScheduledJob(queues.get("codity-notifications:email")!.id, "email-digest", "0 */6 * * *", { template: "digest" });
  await findOrCreateScheduledJob(queues.get("northstar-analytics:reports")!.id, "analytics-refresh", "30 * * * *", { dataset: "events" });

  const codityBatch = await findOrCreateBatch(queues.get("codity-scheduler:default")!.id);
  const northstarBatch = await findOrCreateBatch(queues.get("northstar-analytics:default")!.id);
  const seedJobs: SeedJob[] = [
    { key: "seed-job-queued-01", queueId: queues.get("codity-scheduler:default")!.id, status: JobStatus.QUEUED, jobType: "send-email", payload: { recipient: "member@codity.dev" }, priority: 5, scheduledAt: seedNow, maxAttempts: 3, attemptCount: 0, batchId: codityBatch.id },
    { key: "seed-job-scheduled-01", queueId: queues.get("codity-scheduler:default")!.id, status: JobStatus.SCHEDULED, jobType: "generate-report", payload: { report: "weekly" }, priority: 2, scheduledAt, maxAttempts: 3, attemptCount: 0 },
    { key: "seed-job-claimed-01", queueId: queues.get("codity-notifications:email")!.id, status: JobStatus.CLAIMED, jobType: "send-email", payload: { recipient: "admin@codity.dev" }, priority: 8, scheduledAt: seedNow, maxAttempts: 3, attemptCount: 1, claimedBy: workers.get("codity-worker-1")!.id, claimedAt: seedNow },
    { key: "seed-job-running-01", queueId: queues.get("codity-notifications:email")!.id, status: JobStatus.RUNNING, jobType: "send-email", payload: { recipient: "ops@codity.dev" }, priority: 9, scheduledAt: seedNow, maxAttempts: 3, attemptCount: 1, claimedBy: workers.get("codity-worker-1")!.id, claimedAt: seedNow },
    { key: "seed-job-completed-01", queueId: queues.get("codity-scheduler:default")!.id, status: JobStatus.COMPLETED, jobType: "cleanup", payload: { scope: "temporary" }, priority: 1, scheduledAt: seedNow, maxAttempts: 1, attemptCount: 1, batchId: codityBatch.id },
    { key: "seed-job-failed-01", queueId: queues.get("codity-notifications:email")!.id, status: JobStatus.FAILED, jobType: "send-email", payload: { recipient: "failure@codity.dev" }, priority: 6, scheduledAt: seedNow, maxAttempts: 3, attemptCount: 1, claimedBy: workers.get("codity-worker-2")!.id, claimedAt: seedNow, batchId: codityBatch.id },
    { key: "seed-job-retry-01", queueId: queues.get("codity-scheduler:default")!.id, status: JobStatus.RETRY, jobType: "sync-provider", payload: { provider: "example" }, priority: 4, scheduledAt: retryEligibleAt, maxAttempts: 5, attemptCount: 1, batchId: codityBatch.id },
    { key: "seed-job-dead-letter-01", queueId: queues.get("northstar-analytics:default")!.id, status: JobStatus.DEAD_LETTER, jobType: "refresh-dataset", payload: { dataset: "events" }, priority: 3, scheduledAt: seedNow, maxAttempts: 2, attemptCount: 2, claimedBy: workers.get("northstar-worker-1")!.id, claimedAt: seedNow, batchId: northstarBatch.id },
    { key: "seed-job-cancelled-01", queueId: queues.get("northstar-analytics:reports")!.id, status: JobStatus.CANCELLED, jobType: "export-report", payload: { format: "csv" }, priority: 1, scheduledAt: seedNow, maxAttempts: 1, attemptCount: 0 }
  ];
  for (let index = 0; index < 4; index += 1) {
    seedJobs.push({ key: `seed-batch-job-0${index + 1}`, queueId: codityBatch.queueId, status: index === 0 ? JobStatus.COMPLETED : index === 1 ? JobStatus.FAILED : index === 2 ? JobStatus.RETRY : JobStatus.QUEUED, jobType: "batch-process", payload: { batchItem: index + 1 }, priority: 0, scheduledAt: index === 2 ? retryEligibleAt : seedNow, maxAttempts: 3, attemptCount: index < 3 ? 1 : 0, batchId: codityBatch.id });
  }
  for (const job of seedJobs) await upsertJob(job);

  const jobByKey = new Map<string, { id: string }>();
  for (const job of seedJobs) {
    const record = await prisma.job.findUniqueOrThrow({ where: { queueId_idempotencyKey: { queueId: job.queueId, idempotencyKey: job.key } } });
    jobByKey.set(job.key, record);
  }

  const executions = [
    { job: "seed-job-claimed-01", worker: "codity-worker-1", attemptNumber: 1, status: ExecutionStatus.CLAIMED, startedAt: seedNow, durationMs: 0 },
    { job: "seed-job-running-01", worker: "codity-worker-1", attemptNumber: 1, status: ExecutionStatus.RUNNING, startedAt: seedNow, durationMs: 1200 },
    { job: "seed-job-completed-01", worker: "codity-worker-1", attemptNumber: 1, status: ExecutionStatus.COMPLETED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:02.000Z"), durationMs: 2000 },
    { job: "seed-job-failed-01", worker: "codity-worker-2", attemptNumber: 1, status: ExecutionStatus.FAILED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:03.000Z"), durationMs: 3000, errorMessage: "Provider timeout", errorCode: "PROVIDER_TIMEOUT" },
    { job: "seed-job-retry-01", worker: "codity-worker-2", attemptNumber: 1, status: ExecutionStatus.FAILED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:04.000Z"), durationMs: 4000, errorMessage: "Temporary upstream failure", errorCode: "UPSTREAM_503" },
    { job: "seed-job-dead-letter-01", worker: "northstar-worker-1", attemptNumber: 1, status: ExecutionStatus.FAILED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:05.000Z"), durationMs: 5000, errorMessage: "Dataset unavailable", errorCode: "DATASET_UNAVAILABLE" },
    { job: "seed-job-dead-letter-01", worker: "northstar-worker-1", attemptNumber: 2, status: ExecutionStatus.FAILED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:06.000Z"), durationMs: 5000, errorMessage: "Dataset unavailable", errorCode: "DATASET_UNAVAILABLE" },
    { job: "seed-batch-job-01", worker: "codity-worker-1", attemptNumber: 1, status: ExecutionStatus.COMPLETED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:07.000Z"), durationMs: 7000 },
    { job: "seed-batch-job-02", worker: "codity-worker-2", attemptNumber: 1, status: ExecutionStatus.FAILED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:08.000Z"), durationMs: 8000, errorMessage: "Batch item failed", errorCode: "BATCH_FAILURE" },
    { job: "seed-batch-job-03", worker: "codity-worker-2", attemptNumber: 1, status: ExecutionStatus.FAILED, startedAt: seedNow, completedAt: new Date("2026-01-15T12:00:09.000Z"), durationMs: 9000, errorMessage: "Batch item retryable failure", errorCode: "BATCH_RETRY" }
  ];
  for (const executionSeed of executions) {
    const result = await findOrCreateExecution({ jobId: jobByKey.get(executionSeed.job)!.id, workerId: workers.get(executionSeed.worker)!.id, attemptNumber: executionSeed.attemptNumber, status: executionSeed.status, startedAt: executionSeed.startedAt, completedAt: executionSeed.completedAt ?? null, durationMs: executionSeed.durationMs, errorMessage: executionSeed.errorMessage ?? null, errorCode: executionSeed.errorCode ?? null });
    if (result.createdNow) {
      await prisma.jobLog.createMany({ data: [{ executionId: result.record.id, level: LogLevel.INFO, message: "execution started", metadata: { seed: true }, createdAt: seedNow }, ...(executionSeed.status === ExecutionStatus.FAILED ? [{ executionId: result.record.id, level: LogLevel.ERROR, message: executionSeed.errorMessage ?? "execution failed", metadata: { code: executionSeed.errorCode }, createdAt: seedNow }] : [{ executionId: result.record.id, level: LogLevel.INFO, message: "execution completed", metadata: { durationMs: executionSeed.durationMs }, createdAt: seedNow }])] });
    }
  }

  const deadLetterJob = jobByKey.get("seed-job-dead-letter-01");
  const existingDeadLetter = await prisma.deadLetterEntry.findUnique({ where: { jobId: deadLetterJob!.id } });
  if (!existingDeadLetter) {
    await prisma.deadLetterEntry.create({ data: { jobId: deadLetterJob!.id, reason: "retry_exhausted", errorMessage: "Dataset unavailable after retry exhaustion", attemptCount: 2, lastWorkerId: workers.get("northstar-worker-1")!.id, failedAt: new Date("2026-01-15T12:00:06.000Z"), createdAt: seedNow } });
  }

  for (const batch of [codityBatch, northstarBatch]) {
    const batchJobs = await prisma.job.findMany({ where: { batchId: batch.id }, select: { status: true } });
    const completedJobs = batchJobs.filter((job) => job.status === JobStatus.COMPLETED).length;
    const failedJobs = batchJobs.filter((job) => job.status === JobStatus.FAILED || job.status === JobStatus.DEAD_LETTER).length;
    await prisma.jobBatch.update({ where: { id: batch.id }, data: { totalJobs: batchJobs.length, completedJobs, failedJobs, pendingJobs: batchJobs.length - completedJobs - failedJobs } });
  }

  for (const [organizationName, organization] of orgRecords) {
    const existing = await prisma.apiKey.findFirst({ where: { organizationId: organization.id, name: "development-seed-key" } });
    if (!existing) {
      const keyHash = organizationName === "Codity Demo Org" ? developmentApiKeyHashes.codity : developmentApiKeyHashes.northstar;
      await prisma.apiKey.create({ data: { organizationId: organization.id, name: "development-seed-key", keyHash, expiresAt: apiKeyExpiresAt, createdAt: seedNow } });
    } else {
      const keyHash = organizationName === "Codity Demo Org" ? developmentApiKeyHashes.codity : developmentApiKeyHashes.northstar;
      await prisma.apiKey.update({ where: { id: existing.id }, data: { keyHash, expiresAt: apiKeyExpiresAt } });
    }
  }

  console.log("Deterministic development seed completed.");
}

main()
  .catch((error: unknown) => {
    console.error(error);
    throw error;
  })
  .finally(async () => prisma.$disconnect());