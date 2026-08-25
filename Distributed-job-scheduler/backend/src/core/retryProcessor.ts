import { ExecutionStatus, JobStatus, LogLevel, Prisma, RetryStrategy, type Job, type RetryPolicy } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { publishJobStateEvent } from "../events/eventBus.js";

export type RetryScheduleResult = {
  job: Job;
  scheduled: boolean;
  delayMs: number | null;
};

export type RetryPromotionResult = {
  promotedJobIds: string[];
};

export class RetryProcessor {
  async scheduleFailedJob(jobId: string, queueId: string): Promise<RetryScheduleResult> {
    assertValidTransition(JobStatus.FAILED, JobStatus.RETRY);

    const result = await prisma.$transaction(async (tx) => {
      const job = await tx.job.findUnique({
        where: { id: jobId },
        include: { queue: { include: { retryPolicy: true } } }
      });

      if (!job || job.queueId !== queueId || job.status !== JobStatus.FAILED) {
        return { job: job as Job, scheduled: false, delayMs: null };
      }

      const policy = job.queue.retryPolicy;
      if (job.attemptCount >= job.maxAttempts || job.attemptCount >= policy.maxAttempts) {
        return { job, scheduled: false, delayMs: null };
      }

      const delayMs = calculateRetryDelay(policy, job.attemptCount);
      const updated = await tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Job"
        SET
          "status" = 'RETRY',
          "scheduledAt" = CURRENT_TIMESTAMP + (${delayMs}::double precision * INTERVAL '1 millisecond'),
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${jobId}::uuid
          AND "queueId" = ${queueId}::uuid
          AND "status" = 'FAILED'
          AND "attemptCount" < "maxAttempts"
          AND "attemptCount" < ${policy.maxAttempts}
        RETURNING "id"
      `;

      if (updated.length === 0) {
        const current = await tx.job.findUnique({ where: { id: jobId } });
        return { job: current ?? job, scheduled: false, delayMs: null };
      }

      const scheduledJob = await tx.job.findUniqueOrThrow({ where: { id: jobId } });
      return { job: scheduledJob, scheduled: true, delayMs };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    if (result.scheduled) {
      await this.logRetryEvent(result.job.id, "retry scheduled", LogLevel.INFO, { delayMs: result.delayMs, queueId });
      await publishJobStateEvent(result.job.id, "job.retry", JobStatus.RETRY, JobStatus.FAILED);
    } else if (result.job?.status === JobStatus.FAILED && result.job.attemptCount >= result.job.maxAttempts) {
      await this.logRetryEvent(result.job.id, "retry rejected because maxAttempts was reached", LogLevel.WARN, { queueId });
    }

    return result;
  }

  async promoteDueRetries(queueId?: string): Promise<RetryPromotionResult> {
    assertValidTransition(JobStatus.RETRY, JobStatus.QUEUED);

    const promoted = await prisma.$transaction(async (tx) => {
      if (queueId) {
        return tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "Job"
          SET
            "status" = 'QUEUED',
            "updatedAt" = CURRENT_TIMESTAMP
          FROM "Queue"
          WHERE "Job"."status" = 'RETRY'
            AND "Job"."queueId" = ${queueId}::uuid
            AND "Job"."queueId" = "Queue"."id"
            AND "Queue"."isPaused" = false
            AND "Job"."scheduledAt" <= CURRENT_TIMESTAMP
          RETURNING "Job"."id"
        `;
      }

      return tx.$queryRaw<Array<{ id: string }>>`
        UPDATE "Job"
        SET
          "status" = 'QUEUED',
          "updatedAt" = CURRENT_TIMESTAMP
          FROM "Queue"
          WHERE "Job"."status" = 'RETRY'
            AND "Job"."queueId" = "Queue"."id"
            AND "Queue"."isPaused" = false
            AND "Job"."scheduledAt" <= CURRENT_TIMESTAMP
          RETURNING "Job"."id"
      `;
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    for (const job of promoted) {
      await this.logRetryEvent(job.id, "retry promotion", LogLevel.INFO, { queueId: queueId ?? null });
      await publishJobStateEvent(job.id, "job.queued", JobStatus.QUEUED, JobStatus.RETRY);
    }

    return { promotedJobIds: promoted.map((job) => job.id) };
  }

  private async logRetryEvent(jobId: string, message: string, level: LogLevel, metadata: Prisma.InputJsonObject): Promise<void> {
    const execution = await prisma.jobExecution.findFirst({
      where: { jobId },
      orderBy: { attemptNumber: "desc" },
      select: { id: true }
    });

    if (!execution) {
      return;
    }

    await prisma.jobLog.create({
      data: {
        executionId: execution.id,
        level,
        message,
        metadata
      }
    });
  }
}

export function calculateRetryDelay(policy: Pick<RetryPolicy, "strategy" | "initialDelayMs" | "maxDelayMs" | "backoffMultiplier" | "jitter"> , attemptCount: number): number {
  if (attemptCount < 1) {
    throw new Error("attemptCount must be at least 1 to calculate retry backoff.");
  }

  const baseDelay = new Prisma.Decimal(policy.initialDelayMs);
  const multiplier = new Prisma.Decimal(policy.backoffMultiplier);
  let delay: Prisma.Decimal;

  switch (policy.strategy) {
    case RetryStrategy.FIXED:
      delay = baseDelay;
      break;
    case RetryStrategy.LINEAR:
      delay = baseDelay.mul(attemptCount);
      break;
    case RetryStrategy.EXPONENTIAL:
      delay = baseDelay.mul(multiplier.pow(attemptCount - 1));
      break;
    default:
      throw new Error(`Unsupported retry strategy: ${String(policy.strategy)}`);
  }

  const cappedDelay = delay.lessThan(policy.maxDelayMs) ? delay : new Prisma.Decimal(policy.maxDelayMs);
  const jitteredDelay = policy.jitter
    ? cappedDelay.mul(new Prisma.Decimal(0.5 + Math.random()))
    : cappedDelay;
  const finalDelay = jitteredDelay.lessThan(policy.maxDelayMs) ? jitteredDelay : new Prisma.Decimal(policy.maxDelayMs);
  const delayNumber = finalDelay.toNumber();
  if (!Number.isSafeInteger(delayNumber) || delayNumber < 0) {
    throw new Error("Retry delay must be a non-negative safe integer number of milliseconds.");
  }

  return delayNumber;
}
