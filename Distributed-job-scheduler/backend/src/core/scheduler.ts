import { JobStatus, Prisma, type Job, type ScheduledJob } from "@prisma/client";
import { CronExpressionParser } from "cron-parser";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { publishJobStateEvent } from "../events/eventBus.js";

export type SchedulerOptions = {
  beforeDefinitionUpdate?: () => void | Promise<void>;
};

export type MaterializationResult = {
  materialized: boolean;
  job: Job | null;
  scheduledJob: ScheduledJob | null;
};

export type PromotionResult = {
  promotedJobIds: string[];
};

export function calculateNextRunAt(cronExpression: string, fromDate: Date): Date {
  if (Number.isNaN(fromDate.getTime())) {
    throw new Error("Cannot calculate the next run from an invalid date.");
  }

  try {
    return CronExpressionParser.parse(cronExpression, { currentDate: fromDate }).next().toDate();
  } catch (error) {
    const message = error instanceof Error ? error.message : "invalid cron expression";
    throw new Error(`Invalid cron expression: ${message}`);
  }
}

export class Scheduler {
  private readonly beforeDefinitionUpdate: (() => void | Promise<void>) | undefined;

  constructor(options: SchedulerOptions = {}) {
    this.beforeDefinitionUpdate = options.beforeDefinitionUpdate;
  }

  async createScheduledJob(data: {
    queueId: string;
    jobType: string;
    payload: Prisma.InputJsonValue;
    cronExpression: string;
    nextRunAt: Date;
    enabled?: boolean;
  }): Promise<ScheduledJob> {
    calculateNextRunAt(data.cronExpression, data.nextRunAt);
    return prisma.scheduledJob.create({
      data: {
        queueId: data.queueId,
        jobType: data.jobType,
        payload: data.payload,
        cronExpression: data.cronExpression,
        nextRunAt: data.nextRunAt,
        enabled: data.enabled ?? true
      }
    });
  }

  async promoteDueScheduledJobs(queueId: string): Promise<PromotionResult> {
    assertValidTransition(JobStatus.SCHEDULED, JobStatus.QUEUED);

    const promoted = await prisma.$queryRaw<Array<{ id: string }>>`
      UPDATE "Job"
      SET "status" = 'QUEUED', "updatedAt" = CURRENT_TIMESTAMP
      WHERE "queueId" = ${queueId}::uuid
        AND "status" = 'SCHEDULED'
        AND "scheduledAt" <= CURRENT_TIMESTAMP
        AND EXISTS (
          SELECT 1
          FROM "Queue"
          WHERE "Queue"."id" = "Job"."queueId"
            AND "Queue"."isPaused" = false
        )
      RETURNING "id"
    `;

    for (const job of promoted) await publishJobStateEvent(job.id, "job.schedule.promoted", JobStatus.QUEUED, JobStatus.SCHEDULED);
    return { promotedJobIds: promoted.map((job) => job.id) };
  }

  async materializeDueScheduledJob(scheduledJobId: string, queueId?: string): Promise<MaterializationResult> {
    const result = await prisma.$transaction(async (tx) => {
      const definitions = await tx.$queryRaw<Array<{
        id: string;
        queueId: string;
        jobType: string;
        payload: Prisma.JsonValue;
        cronExpression: string;
        nextRunAt: Date;
        enabled: boolean;
        queueIsPaused: boolean;
        queueDefaultPriority: number;
        queueMaxAttempts: number;
      }>>`
        SELECT
          s."id",
          s."queueId",
          s."jobType",
          s."payload",
          s."cronExpression",
          s."nextRunAt",
          s."enabled",
          q."isPaused" AS "queueIsPaused",
          q."defaultPriority" AS "queueDefaultPriority",
          rp."maxAttempts" AS "queueMaxAttempts"
        FROM "ScheduledJob" s
        INNER JOIN "Queue" q ON q."id" = s."queueId"
        INNER JOIN "RetryPolicy" rp ON rp."id" = q."retryPolicyId"
        WHERE s."id" = ${scheduledJobId}::uuid
        FOR UPDATE
      `;
      const definition = definitions[0];

      if (!definition || (queueId !== undefined && definition.queueId !== queueId)) {
        return { materialized: false, job: null, scheduledJob: null };
      }

      const due = await tx.$queryRaw<Array<{ isDue: boolean; now: Date }>>`
        SELECT "enabled" = true AND "nextRunAt" <= CURRENT_TIMESTAMP AS "isDue", CURRENT_TIMESTAMP AS "now"
        FROM "ScheduledJob"
        WHERE "id" = ${scheduledJobId}::uuid
      `;
      if (definition.queueIsPaused || due[0]?.isDue !== true) {
        const current = await tx.scheduledJob.findUnique({ where: { id: scheduledJobId } });
        return { materialized: false, job: null, scheduledJob: current };
      }

      const occurrence = definition.nextRunAt;
      let nextRunAt = calculateNextRunAt(definition.cronExpression, occurrence);
      if (nextRunAt <= due[0].now) {
        nextRunAt = calculateNextRunAt(definition.cronExpression, due[0].now);
      }
      const occurrenceKey = `scheduler:${definition.id}:${occurrence.toISOString()}`;
      const concreteJob = await tx.job.create({
        data: {
          queueId: definition.queueId,
          jobType: definition.jobType,
          payload: definition.payload as Prisma.InputJsonValue,
          status: JobStatus.SCHEDULED,
          priority: definition.queueDefaultPriority,
          scheduledAt: occurrence,
          maxAttempts: definition.queueMaxAttempts,
          attemptCount: 0,
          idempotencyKey: occurrenceKey,
          claimedBy: null,
          claimedAt: null
        }
      });

      await this.beforeDefinitionUpdate?.();

      const updatedDefinition = await tx.scheduledJob.update({
        where: { id: definition.id },
        data: { nextRunAt }
      });

      return { materialized: true, job: concreteJob, scheduledJob: updatedDefinition };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    if (result.materialized && result.job) await publishJobStateEvent(result.job.id, "job.scheduled", JobStatus.SCHEDULED);
    return result;
  }
}
