import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionStatus, JobStatus, Prisma, RetryStrategy, WorkerStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { claimNextJob } from "./jobClaimer.js";
import { WorkerRuntime } from "./workerRuntime.js";
import { RetryProcessor, calculateRetryDelay } from "./retryProcessor.js";

const processor = new RetryProcessor();
const names = ["retry-step7-fixed", "retry-step7-linear", "retry-step7-exponential", "retry-step7-other"];

type Context = Awaited<ReturnType<typeof createContext>>;

async function createContext() {
  const organization = await prisma.organization.findFirstOrThrow({ where: { name: "Codity Demo Org" } });
  const project = await prisma.project.findFirstOrThrow({ where: { organizationId: organization.id, name: "Scheduler Demo" } });
  const policies = await Promise.all([
    prisma.retryPolicy.create({ data: { name: `step7-fixed-${Date.now()}`, strategy: RetryStrategy.FIXED, maxAttempts: 9, initialDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 1, jitter: false } }),
    prisma.retryPolicy.create({ data: { name: `step7-linear-${Date.now()}`, strategy: RetryStrategy.LINEAR, maxAttempts: 9, initialDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 1, jitter: false } }),
    prisma.retryPolicy.create({ data: { name: `step7-exponential-${Date.now()}`, strategy: RetryStrategy.EXPONENTIAL, maxAttempts: 9, initialDelayMs: 100, maxDelayMs: 10_000, backoffMultiplier: 3, jitter: false } })
  ]);
  const queues = await Promise.all(policies.map((policy, index) => prisma.queue.create({
    data: {
      projectId: project.id,
      name: `${names[index]}-${Date.now()}-${index}`,
      description: "Step 7 isolated retry test queue",
      defaultPriority: 0,
      concurrencyLimit: 10,
      isPaused: false,
      retryPolicyId: policy.id
    }
  })));
  const worker = await prisma.worker.create({
    data: {
      organizationId: organization.id,
      name: `retry-step7-worker-${Date.now()}`,
      status: WorkerStatus.ONLINE,
      concurrency: 2,
      currentJobCount: 0
    }
  });
  return { organization, project, policies, queues, worker };
}

async function cleanup(context: Context) {
  const queueIds = context.queues.map((queue) => queue.id);
  await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: { in: queueIds } } } } });
  await prisma.jobExecution.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
  await prisma.job.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.worker.deleteMany({ where: { id: context.worker.id } });
  await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.retryPolicy.deleteMany({ where: { id: { in: context.policies.map((policy) => policy.id) } } });
}

async function createJob(context: Context, queueIndex = 0, status: JobStatus = JobStatus.FAILED, attemptCount = 1, scheduledAt = new Date(Date.now() - 1_000), maxAttempts = 4) {
  return prisma.job.create({
    data: {
      queueId: context.queues[queueIndex]!.id,
      jobType: "step7-retry-test",
      payload: { step: 7 },
      status,
      priority: 10,
      scheduledAt,
      maxAttempts,
      attemptCount,
      idempotencyKey: `${Date.now()}-${Math.random()}`
    }
  });
}

async function createFailedExecution(context: Context, jobId: string, attemptNumber = 1) {
  return prisma.jobExecution.create({
    data: {
      jobId,
      workerId: context.worker.id,
      attemptNumber,
      status: ExecutionStatus.FAILED,
      startedAt: new Date(Date.now() - 200),
      completedAt: new Date(Date.now() - 100),
      durationMs: 100,
      errorMessage: "previous failure",
      errorCode: "STEP7_TEST_FAILURE"
    }
  });
}

test("FAILED -> RETRY schedules backoff without creating an execution", async () => {
  const context = await createContext();
  const job = await createJob(context);
  const execution = await createFailedExecution(context, job.id);
  try {
    const before = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
    const result = await processor.scheduleFailedJob(job.id, context.queues[0]!.id);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { executions: true } });
    assert.equal(result.scheduled, true);
    assert.equal(persisted.status, JobStatus.RETRY);
    assert.equal(persisted.attemptCount, 1);
    assert.equal(persisted.executions.length, 1);
    assert.equal(persisted.executions[0]!.id, execution.id);
    assert.equal(persisted.executions[0]!.status, ExecutionStatus.FAILED);
    assert.ok(persisted.scheduledAt.getTime() >= before[0]!.now.getTime() + 90);
    assert.equal(persisted.queueId, context.queues[0]!.id);
  } finally { await cleanup(context); }
});

test("future RETRY jobs are not promoted", async () => {
  const context = await createContext();
  const job = await createJob(context, 0, JobStatus.RETRY, 1, new Date(Date.now() + 60_000));
  try {
    const result = await processor.promoteDueRetries(context.queues[0]!.id);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.deepEqual(result.promotedJobIds, []);
    assert.equal(persisted.status, JobStatus.RETRY);
    assert.equal(persisted.attemptCount, 1);
    assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 0);
  } finally { await cleanup(context); }
});

test("due RETRY jobs become QUEUED without changing attempts", async () => {
  const context = await createContext();
  const job = await createJob(context, 0, JobStatus.RETRY, 2, new Date(Date.now() - 1_000));
  try {
    const result = await processor.promoteDueRetries(context.queues[0]!.id);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.deepEqual(result.promotedJobIds, [job.id]);
    assert.equal(persisted.status, JobStatus.QUEUED);
    assert.equal(persisted.attemptCount, 2);
    assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 0);
    assert.equal((await claimNextJob(context.worker.id, context.queues[0]!.id))?.id, job.id);
  } finally { await cleanup(context); }
});

test("maxed jobs remain FAILED and are not moved to DLQ", async () => {
  const context = await createContext();
  const scheduledAt = new Date(Date.now() - 1_000);
  const job = await createJob(context, 0, JobStatus.FAILED, 4, scheduledAt, 4);
  try {
    const result = await processor.scheduleFailedJob(job.id, context.queues[0]!.id);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    assert.equal(result.scheduled, false);
    assert.equal(persisted.status, JobStatus.FAILED);
    assert.equal(persisted.attemptCount, 4);
    assert.equal(persisted.scheduledAt.getTime(), scheduledAt.getTime());
    assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: job.id } }), 0);
  } finally { await cleanup(context); }
});

test("retry promotion followed by Step 5 and Step 6 creates attempt two", async () => {
  const context = await createContext();
  const job = await createJob(context, 0, JobStatus.FAILED, 1, new Date(Date.now() - 1_000), 3);
  await createFailedExecution(context, job.id);
  const runtime = new WorkerRuntime({ workerId: context.worker.id, queueId: context.queues[0]!.id, handler: async () => undefined });
  try {
    await processor.scheduleFailedJob(job.id, context.queues[0]!.id);
    await prisma.job.update({ where: { id: job.id }, data: { scheduledAt: new Date(Date.now() - 1_000) } });
    await processor.promoteDueRetries(context.queues[0]!.id);
    const claimed = await claimNextJob(context.worker.id, context.queues[0]!.id);
    assert.ok(claimed);
    await runtime.executeJob(claimed!);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { executions: { orderBy: { attemptNumber: "asc" } } } });
    assert.equal(persisted.attemptCount, 2);
    assert.equal(persisted.executions.length, 2);
    assert.deepEqual(persisted.executions.map((execution) => execution.attemptNumber), [1, 2]);
    assert.equal(persisted.executions[0]!.status, ExecutionStatus.FAILED);
    assert.equal(persisted.executions[1]!.status, ExecutionStatus.COMPLETED);
    assert.equal(persisted.status, JobStatus.COMPLETED);
  } finally { await cleanup(context); }
});

test("all supported backoff strategies use the actual policy values", async () => {
  const context = await createContext();
  const expected = [100, 200, 100 * 3 ** 2];
  const jobs = await Promise.all(context.policies.map((_, index) => createJob(context, index, JobStatus.FAILED, index + 1)));
  await Promise.all(jobs.map((job) => createFailedExecution(context, job.id)));
  try {
    for (let index = 0; index < jobs.length; index += 1) {
      const policy = context.policies[index]!;
      const job = jobs[index]!;
      assert.equal(calculateRetryDelay(policy, index + 1), expected[index]);
      const before = await prisma.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      await processor.scheduleFailedJob(job.id, context.queues[index]!.id);
      const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
      const actualDelay = persisted.scheduledAt.getTime() - before[0]!.now.getTime();
      assert.ok(Math.abs(actualDelay - expected[index]!) <= 100);
      assert.ok(actualDelay <= policy.maxDelayMs);
    }
  } finally { await cleanup(context); }
});

test("retry processing is queue-isolated", async () => {
  const context = await createContext();
  const queueAJob = await createJob(context, 0, JobStatus.RETRY, 1, new Date(Date.now() - 1_000));
  const queueBJob = await createJob(context, 1, JobStatus.RETRY, 1, new Date(Date.now() - 1_000));
  try {
    const result = await processor.promoteDueRetries(context.queues[0]!.id);
    const a = await prisma.job.findUniqueOrThrow({ where: { id: queueAJob.id } });
    const b = await prisma.job.findUniqueOrThrow({ where: { id: queueBJob.id } });
    assert.deepEqual(result.promotedJobIds, [queueAJob.id]);
    assert.equal(a.status, JobStatus.QUEUED);
    assert.equal(b.status, JobStatus.RETRY);
    assert.equal(a.queueId, context.queues[0]!.id);
    assert.equal(b.queueId, context.queues[1]!.id);
  } finally { await cleanup(context); }
});

test("retry eligibility is controlled by PostgreSQL time", async () => {
  const context = await createContext();
  const job = await createJob(context, 0, JobStatus.RETRY, 1, new Date(Date.now() + 10_000));
  try {
    await processor.promoteDueRetries(context.queues[0]!.id);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status, JobStatus.RETRY);
    await prisma.$executeRaw`UPDATE "Job" SET "scheduledAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = ${job.id}::uuid`;
    await processor.promoteDueRetries(context.queues[0]!.id);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: job.id } })).status, JobStatus.QUEUED);
  } finally { await cleanup(context); }
});

test("retry transitions preserve failed execution history", async () => {
  const context = await createContext();
  const job = await createJob(context, 0, JobStatus.FAILED, 1);
  const execution = await createFailedExecution(context, job.id);
  try {
    await processor.scheduleFailedJob(job.id, context.queues[0]!.id);
    await prisma.$executeRaw`UPDATE "Job" SET "scheduledAt" = CURRENT_TIMESTAMP - INTERVAL '1 second' WHERE "id" = ${job.id}::uuid`;
    await processor.promoteDueRetries(context.queues[0]!.id);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { executions: true } });
    assert.equal(persisted.executions.length, 1);
    assert.equal(persisted.executions[0]!.id, execution.id);
    assert.equal(persisted.executions[0]!.status, ExecutionStatus.FAILED);
    assert.equal(persisted.attemptCount, 1);
  } finally { await cleanup(context); }
});

test("concurrent retry scheduling is conditional and produces one retry state", async () => {
  const context = await createContext();
  const job = await createJob(context);
  await createFailedExecution(context, job.id);
  try {
    const results = await Promise.all(Array.from({ length: 10 }, () => processor.scheduleFailedJob(job.id, context.queues[0]!.id)));
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { executions: true } });
    assert.equal(results.filter((result) => result.scheduled).length, 1);
    assert.equal(persisted.status, JobStatus.RETRY);
    assert.equal(persisted.attemptCount, 1);
    assert.equal(persisted.executions.length, 1);
  } finally { await cleanup(context); }
});

test("jittered backoff stays in safe integer millisecond values", () => {
  const originalRandom = Math.random;
  Math.random = () => 0.1;
  try {
    const policy = {
      strategy: RetryStrategy.EXPONENTIAL,
      initialDelayMs: 1,
      maxDelayMs: 128,
      backoffMultiplier: new Prisma.Decimal("2"),
      jitter: true
    };

    assert.equal(calculateRetryDelay(policy, 2), 1);
  } finally {
    Math.random = originalRandom;
  }
});
