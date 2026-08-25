import { JobStatus, Prisma, type DeadLetterEntry } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { publishJobStateEvent } from "../events/eventBus.js";

export type DeadLetterResult = {
  processed: boolean;
  entry: DeadLetterEntry | null;
};

export type DeadLetterProcessorOptions = {
  beforeEntryCreate?: () => void | Promise<void>;
};

type LockedJob = {
  id: string;
  queueId: string;
  status: JobStatus;
  attemptCount: number;
  maxAttempts: number;
  policyMaxAttempts: number;
};

export class DeadLetterProcessor {
  private readonly beforeEntryCreate: (() => void | Promise<void>) | undefined;

  constructor(options: DeadLetterProcessorOptions = {}) {
    this.beforeEntryCreate = options.beforeEntryCreate;
  }

  async processDeadLetter(jobId: string, queueId?: string): Promise<DeadLetterResult> {
    assertValidTransition(JobStatus.FAILED, JobStatus.DEAD_LETTER);

    const result = await prisma.$transaction(async (tx) => {
      const lockedRows = await tx.$queryRaw<LockedJob[]>`
        SELECT "Job"."id", "Job"."queueId", "Job"."status", "Job"."attemptCount", "Job"."maxAttempts", "RetryPolicy"."maxAttempts" AS "policyMaxAttempts"
        FROM "Job"
        INNER JOIN "Queue" ON "Queue"."id" = "Job"."queueId"
        INNER JOIN "RetryPolicy" ON "RetryPolicy"."id" = "Queue"."retryPolicyId"
        WHERE "Job"."id" = ${jobId}::uuid
        FOR UPDATE
      `;
      const job = lockedRows[0];

      if (!job || (queueId !== undefined && job.queueId !== queueId)) {
        return { processed: false, entry: null };
      }

      if (job.status === JobStatus.DEAD_LETTER) {
        const entry = await tx.deadLetterEntry.findUnique({ where: { jobId } });
        return { processed: false, entry };
      }

      const maxAttempts = Math.min(job.maxAttempts, job.policyMaxAttempts);
      if (job.status !== JobStatus.FAILED || job.attemptCount < maxAttempts) {
        return { processed: false, entry: null };
      }

      const existing = await tx.deadLetterEntry.findUnique({ where: { jobId } });
      if (existing) {
        return { processed: false, entry: existing };
      }

      const latestExecution = await tx.jobExecution.findFirst({
        where: { jobId },
        orderBy: { attemptNumber: "desc" }
      });
      const errorMessage = latestExecution?.errorMessage ?? null;
      const reason = errorMessage
        ? `Maximum retry attempts (${maxAttempts}) exceeded: ${errorMessage}`
        : `Maximum retry attempts (${maxAttempts}) exceeded`;
      const databaseTime = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
      const failedAt = databaseTime[0]?.now;
      if (!failedAt) {
        throw new Error("Database did not return a current timestamp for dead-letter processing.");
      }

      await tx.$executeRaw`
        UPDATE "Job"
        SET "status" = 'DEAD_LETTER', "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${jobId}::uuid
          AND "status" = 'FAILED'
          AND "attemptCount" >= ${maxAttempts}
      `;

      await this.beforeEntryCreate?.();

      const entry = await tx.deadLetterEntry.create({
        data: {
          jobId,
          reason,
          errorMessage,
          attemptCount: job.attemptCount,
          lastWorkerId: latestExecution?.workerId ?? null,
          failedAt
        }
      });

      return { processed: true, entry };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    if (result.processed) await publishJobStateEvent(jobId, "job.dead_lettered", JobStatus.DEAD_LETTER, JobStatus.FAILED);
    return result;
  }
}
