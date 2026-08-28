import { JobStatus, Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { publishJobStateEvent } from "../events/eventBus.js";

type ClaimedJobRow = {
  id: string;
  queueId: string;
  status: JobStatus;
  priority: number;
  createdAt: Date;
  scheduledAt: Date | null;
  claimedBy: string | null;
  claimedAt: Date | null;
};

export async function claimNextJob(workerId: string, queueId: string) {
  assertValidTransition(JobStatus.QUEUED, JobStatus.CLAIMED);

  const claimed = await prisma.$transaction(
    async (tx) => {
      const queues = await tx.$queryRaw<Array<{ id: string; isPaused: boolean; concurrencyLimit: number }>>`
        SELECT "id", "isPaused", "concurrencyLimit"
        FROM "Queue"
        WHERE "id" = ${queueId}::uuid
        FOR UPDATE
      `;
      const queue = queues[0];
      if (!queue || queue.isPaused) {
        return null;
      }

      const rows = await tx.$queryRaw<Array<ClaimedJobRow>>`
        SELECT
          "id",
          "queueId",
          "status",
          "priority",
          "createdAt",
          "scheduledAt",
          "claimedBy",
          "claimedAt"
        FROM "Job"
        WHERE "queueId" = ${queueId}::uuid
          AND "status" = 'QUEUED'
          AND (
            "scheduledAt" IS NULL
            OR "scheduledAt" <= CURRENT_TIMESTAMP
          )
        ORDER BY "priority" DESC, "createdAt" ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      `;

      if (rows.length === 0) {
        return null;
      }

      const candidate = rows[0];
      if (!candidate) {
        return null;
      }

      const claimedAt = new Date();

      return tx.job.update({
        where: { id: candidate.id },
        data: {
          status: JobStatus.CLAIMED,
          claimedBy: workerId,
          claimedAt,
          updatedAt: claimedAt
        }
      });
    },
    {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 10_000
    }
  );
  if (claimed) await publishJobStateEvent(claimed.id, "job.claimed", JobStatus.CLAIMED, JobStatus.QUEUED);
  return claimed;
}
