import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionStatus, JobStatus, PrismaClient, WorkerStatus, type Job, type JobExecution } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { claimNextJob } from "./jobClaimer.js";
import { WorkerRuntime, WorkerOwnershipError } from "./workerRuntime.js";

async function ensureRuntimeTestContext(prismaClient: PrismaClient) {
  const organization = await prismaClient.organization.findFirst({ where: { name: "Codity Demo Org" } });
  if (!organization) {
    throw new Error("Missing seeded Codity Demo Org");
  }

  const project = await prismaClient.project.findFirst({
    where: { organizationId: organization.id, name: "Scheduler Demo" }
  });
  if (!project) {
    throw new Error("Missing seeded Scheduler Demo project");
  }

  const retryPolicy = await prismaClient.retryPolicy.findFirst({
    where: { name: "seed-fixed" }
  });
  if (!retryPolicy) {
    throw new Error("Missing seed-fixed retry policy");
  }

  const queueA = await prismaClient.queue.upsert({
    where: { projectId_name: { projectId: project.id, name: "worker-runtime-test-queue-a" } },
    update: { retryPolicyId: retryPolicy.id, defaultPriority: 0, concurrencyLimit: 10, isPaused: false },
    create: {
      projectId: project.id,
      name: "worker-runtime-test-queue-a",
      description: "worker runtime queue A",
      defaultPriority: 0,
      concurrencyLimit: 10,
      isPaused: false,
      retryPolicyId: retryPolicy.id,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  const queueB = await prismaClient.queue.upsert({
    where: { projectId_name: { projectId: project.id, name: "worker-runtime-test-queue-b" } },
    update: { retryPolicyId: retryPolicy.id, defaultPriority: 0, concurrencyLimit: 10, isPaused: false },
    create: {
      projectId: project.id,
      name: "worker-runtime-test-queue-b",
      description: "worker runtime queue B",
      defaultPriority: 0,
      concurrencyLimit: 10,
      isPaused: false,
      retryPolicyId: retryPolicy.id,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  const workerA = await prismaClient.worker.upsert({
    where: { organizationId_name: { organizationId: organization.id, name: "worker-runtime-a" } },
    update: { status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0, lastHeartbeatAt: new Date() },
    create: {
      organizationId: organization.id,
      name: "worker-runtime-a",
      status: WorkerStatus.ONLINE,
      concurrency: 2,
      currentJobCount: 0,
      lastHeartbeatAt: new Date(),
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  const workerB = await prismaClient.worker.upsert({
    where: { organizationId_name: { organizationId: organization.id, name: "worker-runtime-b" } },
    update: { status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0, lastHeartbeatAt: new Date() },
    create: {
      organizationId: organization.id,
      name: "worker-runtime-b",
      status: WorkerStatus.ONLINE,
      concurrency: 2,
      currentJobCount: 0,
      lastHeartbeatAt: new Date(),
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  const runtimeWorker = await prismaClient.worker.upsert({
    where: { organizationId_name: { organizationId: organization.id, name: "worker-runtime-loop" } },
    update: { status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0, lastHeartbeatAt: new Date() },
    create: {
      organizationId: organization.id,
      name: "worker-runtime-loop",
      status: WorkerStatus.ONLINE,
      concurrency: 2,
      currentJobCount: 0,
      lastHeartbeatAt: new Date(),
      startedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  return { organization, project, queueA, queueB, workerA, workerB, runtimeWorker };
}

async function createQueuedJob(queueId: string, jobType: string, payload: Record<string, unknown>, priority = 10) {
  const now = new Date();
  return prisma.job.create({
    data: {
      queueId,
      jobType,
      payload: payload as any,
      status: JobStatus.QUEUED,
      priority,
      scheduledAt: new Date(now.getTime() - 60_000),
      maxAttempts: 3,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    }
  });
}

test("successful execution transitions a claimed job to completed and records one execution", async () => {
  const context = await ensureRuntimeTestContext(prisma);
  const runtime = new WorkerRuntime({
    workerId: context.workerA.id,
    queueId: context.queueA.id,
    pollIntervalMs: 1,
    handler: async () => undefined
  });

  const job = await createQueuedJob(context.queueA.id, "success-job", { scenario: "success" });

  try {
    const claimed = await claimNextJob(context.workerA.id, context.queueA.id);
    assert.ok(claimed);
    assert.equal(claimed?.status, JobStatus.CLAIMED);

    await runtime.executeJob(claimed!);

    const persisted = await prisma.job.findUnique({
      where: { id: job.id },
      include: { executions: true }
    });

    assert.ok(persisted);
    assert.equal(persisted?.status, JobStatus.COMPLETED);
    assert.equal(persisted?.attemptCount, 1);
    assert.equal(persisted?.executions.length, 1);

    const execution = persisted?.executions[0] as JobExecution | undefined;
    assert.ok(execution);
    assert.equal(execution?.jobId, job.id);
    assert.equal(execution?.workerId, context.workerA.id);
    assert.equal(execution?.attemptNumber, 1);
    assert.equal(execution?.status, ExecutionStatus.COMPLETED);
    assert.ok(execution?.startedAt instanceof Date);
    assert.ok(execution?.completedAt instanceof Date);
    assert.equal(persisted?.attemptCount, persisted?.executions.length);
  } finally {
    await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: context.queueA.id } } } });
    await prisma.jobExecution.deleteMany({ where: { job: { queueId: context.queueA.id } } });
    await prisma.job.deleteMany({ where: { queueId: context.queueA.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { in: ["worker-runtime-a", "worker-runtime-b", "worker-runtime-loop"] } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: { in: ["worker-runtime-test-queue-a", "worker-runtime-test-queue-b"] } } });
  }
});

test("failed execution transitions a claimed job to failed and records the failure status", async () => {
  const context = await ensureRuntimeTestContext(prisma);
  const runtime = new WorkerRuntime({
    workerId: context.workerA.id,
    queueId: context.queueA.id,
    pollIntervalMs: 1,
    handler: async () => {
      throw new Error("intentional failure");
    }
  });

  const job = await createQueuedJob(context.queueA.id, "failure-job", { scenario: "failure" });

  try {
    const claimed = await claimNextJob(context.workerA.id, context.queueA.id);
    assert.ok(claimed);
    await runtime.executeJob(claimed!);

    const persisted = await prisma.job.findUnique({
      where: { id: job.id },
      include: { executions: true }
    });

    assert.ok(persisted);
    assert.equal(persisted?.status, JobStatus.FAILED);
    assert.equal(persisted?.attemptCount, 1);
    assert.equal(persisted?.executions.length, 1);

    const execution = persisted?.executions[0] as JobExecution | undefined;
    assert.ok(execution);
    assert.equal(execution?.attemptNumber, 1);
    assert.equal(execution?.status, ExecutionStatus.FAILED);
    assert.equal(execution?.workerId, context.workerA.id);
    assert.ok(execution?.startedAt instanceof Date);
    assert.ok(execution?.completedAt instanceof Date);
    assert.equal(execution?.errorMessage, "intentional failure");
    assert.equal(persisted?.attemptCount, persisted?.executions.length);
  } finally {
    await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: context.queueA.id } } } });
    await prisma.jobExecution.deleteMany({ where: { job: { queueId: context.queueA.id } } });
    await prisma.job.deleteMany({ where: { queueId: context.queueA.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { in: ["worker-runtime-a", "worker-runtime-b", "worker-runtime-loop"] } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: { in: ["worker-runtime-test-queue-a", "worker-runtime-test-queue-b"] } } });
  }
});

test("a worker continues after a failed job and can execute another job in the same queue", async () => {
  const context = await ensureRuntimeTestContext(prisma);
  const runtime = new WorkerRuntime({
    workerId: context.runtimeWorker.id,
    queueId: context.queueA.id,
    pollIntervalMs: 1,
    handler: async (job: Job) => {
      if (job.jobType === "broken-job") {
        throw new Error("broken-job");
      }
      return undefined;
    }
  });

  const failingJob = await createQueuedJob(context.queueA.id, "broken-job", { scenario: "continue-after-failure" });
  const succeedingJob = await createQueuedJob(context.queueA.id, "good-job", { scenario: "continue-after-success" });

  try {
    const firstClaim = await claimNextJob(context.runtimeWorker.id, context.queueA.id);
    assert.ok(firstClaim);
    await runtime.executeJob(firstClaim!);

    const secondClaim = await claimNextJob(context.runtimeWorker.id, context.queueA.id);
    assert.ok(secondClaim);
    await runtime.executeJob(secondClaim!);

    const firstPersisted = await prisma.job.findUnique({ where: { id: failingJob.id }, include: { executions: true } });
    const secondPersisted = await prisma.job.findUnique({ where: { id: succeedingJob.id }, include: { executions: true } });

    assert.equal(firstPersisted?.status, JobStatus.FAILED);
    assert.equal(secondPersisted?.status, JobStatus.COMPLETED);
    assert.equal(firstPersisted?.attemptCount, 1);
    assert.equal(secondPersisted?.attemptCount, 1);
    assert.equal(firstPersisted?.executions.length, 1);
    assert.equal(secondPersisted?.executions.length, 1);
    assert.equal(firstPersisted?.executions[0]?.status, ExecutionStatus.FAILED);
    assert.equal(secondPersisted?.executions[0]?.status, ExecutionStatus.COMPLETED);
  } finally {
    await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: context.queueA.id } } } });
    await prisma.jobExecution.deleteMany({ where: { job: { queueId: context.queueA.id } } });
    await prisma.job.deleteMany({ where: { queueId: context.queueA.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { in: ["worker-runtime-a", "worker-runtime-b", "worker-runtime-loop"] } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: { in: ["worker-runtime-test-queue-a", "worker-runtime-test-queue-b"] } } });
  }
});

test("worker runtime only executes jobs from its configured queue", async () => {
  const context = await ensureRuntimeTestContext(prisma);
  const queueAJob = await createQueuedJob(context.queueA.id, "queue-a-job", { queue: "A" }, 50);
  const queueBJob = await createQueuedJob(context.queueB.id, "queue-b-job", { queue: "B" }, 99);
  const runtime = new WorkerRuntime({
    workerId: context.runtimeWorker.id,
    queueId: context.queueA.id,
    pollIntervalMs: 1,
    handler: async () => undefined
  });

  try {
    const next = await runtime.runOnce();
    assert.ok(next);
    assert.equal(next?.queueId, context.queueA.id);

    const persistedA = await prisma.job.findUnique({ where: { id: queueAJob.id }, include: { executions: true } });
    const persistedB = await prisma.job.findUnique({ where: { id: queueBJob.id }, include: { executions: true } });

    assert.equal(persistedA?.status, JobStatus.COMPLETED);
    assert.equal(persistedA?.attemptCount, 1);
    assert.equal(persistedA?.executions.length, 1);
    assert.equal(persistedB?.status, JobStatus.QUEUED);
    assert.equal(persistedB?.executions.length, 0);
  } finally {
    await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: { in: [context.queueA.id, context.queueB.id] } } } } });
    await prisma.jobExecution.deleteMany({ where: { job: { queueId: { in: [context.queueA.id, context.queueB.id] } } } });
    await prisma.job.deleteMany({ where: { queueId: { in: [context.queueA.id, context.queueB.id] } } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { in: ["worker-runtime-a", "worker-runtime-b", "worker-runtime-loop"] } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: { in: ["worker-runtime-test-queue-a", "worker-runtime-test-queue-b"] } } });
  }
});

test("worker ownership is enforced and a foreign worker cannot execute a claimed job", async () => {
  const context = await ensureRuntimeTestContext(prisma);
  const job = await createQueuedJob(context.queueA.id, "ownership-job", { scenario: "ownership" });
  const claimed = await claimNextJob(context.workerA.id, context.queueA.id);

  const runtime = new WorkerRuntime({
    workerId: context.workerB.id,
    queueId: context.queueA.id,
    pollIntervalMs: 1,
    handler: async () => undefined
  });

  try {
    assert.ok(claimed);
    assert.equal(claimed?.claimedBy, context.workerA.id);

    await assert.rejects(() => runtime.executeJob(claimed!), (error) => {
      assert.ok(error instanceof WorkerOwnershipError);
      return true;
    });

    const persisted = await prisma.job.findUnique({ where: { id: job.id }, include: { executions: true } });
    assert.equal(persisted?.status, JobStatus.CLAIMED);
    assert.equal(persisted?.claimedBy, context.workerA.id);
    assert.equal(persisted?.attemptCount, 0);
    assert.equal(persisted?.executions.length, 0);
  } finally {
    await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: context.queueA.id } } } });
    await prisma.jobExecution.deleteMany({ where: { job: { queueId: context.queueA.id } } });
    await prisma.job.deleteMany({ where: { queueId: context.queueA.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { in: ["worker-runtime-a", "worker-runtime-b", "worker-runtime-loop"] } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: { in: ["worker-runtime-test-queue-a", "worker-runtime-test-queue-b"] } } });
  }
});
