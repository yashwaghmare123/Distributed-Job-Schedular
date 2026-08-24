import test from "node:test";
import assert from "node:assert/strict";
import { PrismaClient, JobStatus, WorkerStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { claimNextJob } from "./jobClaimer.js";

function makeId(prefix: string, index: number) {
  return `${prefix}-${String(index).padStart(3, "0")}`;
}

function makePastDate(offsetMs: number) {
  return new Date(Date.now() - offsetMs);
}

function makeFutureDate(offsetMs: number) {
  return new Date(Date.now() + offsetMs);
}

async function ensureTestContext(prismaClient: PrismaClient) {
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

  const queue = await prismaClient.queue.upsert({
    where: { projectId_name: { projectId: project.id, name: "claimer-test-queue" } },
    update: { retryPolicyId: retryPolicy.id, defaultPriority: 0, concurrencyLimit: 10, isPaused: false },
    create: {
      projectId: project.id,
      name: "claimer-test-queue",
      description: "isolated concurrency test queue",
      defaultPriority: 0,
      concurrencyLimit: 10,
      isPaused: false,
      retryPolicyId: retryPolicy.id,
      createdAt: new Date(),
      updatedAt: new Date()
    }
  });

  const workerRecords = await Promise.all(
    Array.from({ length: 10 }, async (_, index) => {
      const name = `claimer-worker-${String(index + 1).padStart(2, "0")}`;
      const record = await prismaClient.worker.upsert({
        where: { organizationId_name: { organizationId: organization.id, name } },
        update: {
          status: WorkerStatus.ONLINE,
          concurrency: 4,
          currentJobCount: 0,
          lastHeartbeatAt: new Date()
        },
        create: {
          organizationId: organization.id,
          name,
          status: WorkerStatus.ONLINE,
          concurrency: 4,
          currentJobCount: 0,
          lastHeartbeatAt: new Date(),
          startedAt: new Date(),
          createdAt: new Date(),
          updatedAt: new Date()
        }
      });

      return record;
    })
  );

  return { organization, project, queue, workers: workerRecords };
}

test("two workers cannot both claim the same queued job", async () => {
  const context = await ensureTestContext(prisma);
  const now = new Date();
  const job = await prisma.job.create({
    data: {
      queueId: context.queue.id,
      jobType: "two-worker-test",
      payload: { scenario: "atomic-claim" },
      status: JobStatus.QUEUED,
      priority: 99,
      scheduledAt: new Date(now.getTime() - 60_000),
      maxAttempts: 3,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    }
  });

  try {
    const workerA = context.workers[0]!;
    const workerB = context.workers[1]!;
    const [winner, loser] = await Promise.all([
      claimNextJob(workerA.id, context.queue.id),
      claimNextJob(workerB.id, context.queue.id)
    ]);

    const successful = [winner, loser].filter(Boolean);
    assert.equal(successful.length, 1);
    assert.equal(successful[0]?.id, job.id);

    const persisted = await prisma.job.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.status, JobStatus.CLAIMED);
    assert.ok(persisted?.claimedBy === workerA.id || persisted?.claimedBy === workerB.id);
    assert.ok(persisted?.claimedAt instanceof Date);
  } finally {
    await prisma.job.deleteMany({ where: { queueId: context.queue.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { startsWith: "claimer-worker-" } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: "claimer-test-queue" } });
  }
});

test("100 jobs across 10 workers are all claimed exactly once", async () => {
  const context = await ensureTestContext(prisma);
  const seedTime = new Date();
  const jobs = await Promise.all(
    Array.from({ length: 100 }, (_, index) => {
      const createdAt = new Date(seedTime.getTime() - index * 1000);
      return prisma.job.create({
        data: {
          queueId: context.queue.id,
          jobType: `bulk-test-${makeId("job", index)}`,
          payload: { n: index },
          status: JobStatus.QUEUED,
          priority: index % 7,
          scheduledAt: makePastDate(60_000),
          maxAttempts: 3,
          attemptCount: 0,
          createdAt,
          updatedAt: createdAt
        }
      });
    })
  );

  try {
    const claims = await Promise.all(
      Array.from({ length: 100 }, (_, index) => {
        const worker = context.workers[index % context.workers.length]!;
        return claimNextJob(worker.id, context.queue.id);
      })
    );

    const successfulClaims = claims.filter((job): job is NonNullable<typeof job> => job !== null);
    const uniqueJobIds = new Set(successfulClaims.map((job) => job.id));
    const duplicateJobIds = successfulClaims.length - uniqueJobIds.size;
    const testWorkerIds = context.workers.map((worker) => worker.id);

    assert.equal(successfulClaims.length, 100);
    assert.equal(uniqueJobIds.size, 100);
    assert.equal(duplicateJobIds, 0);

    const remaining = await prisma.job.count({ where: { queueId: context.queue.id, status: JobStatus.QUEUED } });
    assert.equal(remaining, 0);

    const jobsClaimedOutsideTestQueue = await prisma.job.count({
      where: {
        queueId: { not: context.queue.id },
        status: JobStatus.CLAIMED,
        claimedBy: { in: testWorkerIds }
      }
    });
    assert.equal(jobsClaimedOutsideTestQueue, 0);

    for (const job of successfulClaims) {
      const persisted = await prisma.job.findUnique({ where: { id: job.id } });
      assert.equal(persisted?.status, JobStatus.CLAIMED);
      assert.ok(persisted?.claimedBy && context.workers.some((worker) => worker.id === persisted.claimedBy));
    }
  } finally {
    await prisma.job.deleteMany({ where: { queueId: context.queue.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { startsWith: "claimer-worker-" } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: "claimer-test-queue" } });
  }
});

test("scheduled jobs are gated by database time and priority ordering is preserved", async () => {
  const context = await ensureTestContext(prisma);
  const now = new Date();

  const dueJob = await prisma.job.create({
    data: {
      queueId: context.queue.id,
      jobType: "due-job",
      payload: { kind: "due" },
      status: JobStatus.QUEUED,
      priority: 5,
      scheduledAt: new Date(now.getTime() - 60_000),
      maxAttempts: 2,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    }
  });

  const futureJob = await prisma.job.create({
    data: {
      queueId: context.queue.id,
      jobType: "future-job",
      payload: { kind: "future" },
      status: JobStatus.QUEUED,
      priority: 100,
      scheduledAt: new Date(now.getTime() + 60_000),
      maxAttempts: 2,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    }
  });

  const higherPriority = await prisma.job.create({
    data: {
      queueId: context.queue.id,
      jobType: "priority-job",
      payload: { kind: "priority" },
      status: JobStatus.QUEUED,
      priority: 20,
      scheduledAt: new Date(now.getTime() - 60_000),
      maxAttempts: 2,
      attemptCount: 0,
      createdAt: new Date(now.getTime() - 30_000),
      updatedAt: new Date(now.getTime() - 30_000)
    }
  });

  try {
    const worker = context.workers[0]!;
    const claimed = await claimNextJob(worker.id, context.queue.id);
    assert.ok(claimed);
    assert.equal(claimed?.id, higherPriority.id);
    assert.equal(claimed?.status, JobStatus.CLAIMED);

    const futureClaim = await prisma.job.findUnique({ where: { id: futureJob.id } });
    assert.equal(futureClaim?.status, JobStatus.QUEUED);

    const dueStillQueued = await prisma.job.findUnique({ where: { id: dueJob.id } });
    assert.equal(dueStillQueued?.status, JobStatus.QUEUED);
  } finally {
    await prisma.job.deleteMany({ where: { queueId: context.queue.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { startsWith: "claimer-worker-" } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: "claimer-test-queue" } });
  }
});

test("transaction rollback restores the job when the worker FK is invalid", async () => {
  const context = await ensureTestContext(prisma);
  const now = new Date();
  const job = await prisma.job.create({
    data: {
      queueId: context.queue.id,
      jobType: "rollback-test",
      payload: { scenario: "fk-rollback" },
      status: JobStatus.QUEUED,
      priority: 1,
      scheduledAt: new Date(now.getTime() - 60_000),
      maxAttempts: 2,
      attemptCount: 0,
      createdAt: now,
      updatedAt: now
    }
  });

  try {
    await assert.rejects(
      () => claimNextJob("00000000-0000-0000-0000-000000000000", context.queue.id),
      /Foreign key constraint violated|violates foreign key|constraint failed/i
    );

    const persisted = await prisma.job.findUnique({ where: { id: job.id } });
    assert.equal(persisted?.status, JobStatus.QUEUED);
    assert.equal(persisted?.claimedBy, null);
  } finally {
    await prisma.job.deleteMany({ where: { queueId: context.queue.id } });
    await prisma.worker.deleteMany({ where: { organizationId: context.organization.id, name: { startsWith: "claimer-worker-" } } });
    await prisma.queue.deleteMany({ where: { projectId: context.project.id, name: "claimer-test-queue" } });
  }
});
