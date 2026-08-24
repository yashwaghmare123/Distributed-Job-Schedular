import { JobStatus, Prisma, type Job, type JobBatch } from "@prisma/client";
import { prisma } from "../lib/prisma.js";

export type JobBatchItem = {
  jobType: string;
  payload: Prisma.InputJsonValue;
  priority?: number;
  scheduledAt?: Date;
  maxAttempts?: number;
  idempotencyKey?: string;
};

export type CreatedJobBatch = JobBatch & { jobs: Job[] };

export type JobBatchCreatorOptions = {
  afterJobCreate?: (index: number) => void | Promise<void>;
};

export class InvalidJobBatchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "InvalidJobBatchError";
  }
}

export async function createJobBatch(
  queueId: string,
  jobs: readonly JobBatchItem[],
  options: JobBatchCreatorOptions = {}
): Promise<CreatedJobBatch> {
  validateBatchInput(jobs);

  return prisma.$transaction(async (tx) => {
    const queue = await tx.queue.findUnique({
      where: { id: queueId },
      include: { retryPolicy: true }
    });
    if (!queue) {
      throw new InvalidJobBatchError(`Queue ${queueId} was not found.`);
    }

    const now = new Date();
    const batch = await tx.jobBatch.create({
      data: {
        queueId: queue.id,
        totalJobs: jobs.length,
        completedJobs: 0,
        failedJobs: 0,
        pendingJobs: jobs.length,
        createdAt: now,
        updatedAt: now
      }
    });

    const createdJobs: Job[] = [];
    for (const [index, item] of jobs.entries()) {
      const scheduledAt = item.scheduledAt ?? now;
      const status = scheduledAt.getTime() > now.getTime() ? JobStatus.SCHEDULED : JobStatus.QUEUED;
      const createdJob = await tx.job.create({
        data: {
          queueId: queue.id,
          batchId: batch.id,
          jobType: item.jobType,
          payload: item.payload,
          status,
          priority: item.priority ?? queue.defaultPriority,
          scheduledAt,
          maxAttempts: item.maxAttempts ?? queue.retryPolicy.maxAttempts,
          attemptCount: 0,
          idempotencyKey: item.idempotencyKey ?? null,
          claimedBy: null,
          claimedAt: null,
          createdAt: now,
          updatedAt: now
        }
      });
      createdJobs.push(createdJob);
      await options.afterJobCreate?.(index);
    }

    return { ...batch, jobs: createdJobs };
  }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
}

function validateBatchInput(jobs: readonly JobBatchItem[]): void {
  if (!Array.isArray(jobs) || jobs.length === 0) {
    throw new InvalidJobBatchError("jobs must be a non-empty array.");
  }

  jobs.forEach((job, index) => {
    if (!job || typeof job.jobType !== "string" || job.jobType.trim().length === 0) {
      throw new InvalidJobBatchError(`jobs[${index}].jobType must be a non-empty string.`);
    }
    if (job.payload === undefined) {
      throw new InvalidJobBatchError(`jobs[${index}].payload is required.`);
    }
    if (job.priority !== undefined && !Number.isSafeInteger(job.priority)) {
      throw new InvalidJobBatchError(`jobs[${index}].priority must be a safe integer.`);
    }
    if (job.maxAttempts !== undefined && (!Number.isSafeInteger(job.maxAttempts) || job.maxAttempts < 1)) {
      throw new InvalidJobBatchError(`jobs[${index}].maxAttempts must be a positive safe integer.`);
    }
    if (job.scheduledAt !== undefined && Number.isNaN(job.scheduledAt.getTime())) {
      throw new InvalidJobBatchError(`jobs[${index}].scheduledAt must be a valid Date.`);
    }
  });
}
