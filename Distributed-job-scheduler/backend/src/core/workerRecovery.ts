import { randomUUID } from "node:crypto";
import { ExecutionStatus, JobStatus, LogLevel, Prisma, WorkerStatus, type Worker, type WorkerHeartbeat } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { publishJobStateEvent, publishWorkerEvent } from "../events/eventBus.js";

export const DEFAULT_HEARTBEAT_INTERVAL_MS = 5_000;
export const DEFAULT_HEARTBEAT_TIMEOUT_MS = 20_000;

type WorkerRecoveryOptions = {
  heartbeatTimeoutMs?: number;
};

type StaleWorkerRow = {
  id: string;
  status: WorkerStatus;
  lastHeartbeatAt: Date | null;
  currentJobCount: number;
};

export type HeartbeatResult = {
  worker: Worker;
  heartbeat: WorkerHeartbeat;
};

export type WorkerRecoveryResult = {
  workerId: string;
  workerProcessed: boolean;
  claimedJobsRecovered: number;
  runningJobsFailed: number;
};

export type WorkerStatusUpdate = {
  worker: Worker;
};

export class WorkerNotFoundError extends Error {
  constructor(workerId: string) {
    super(`Worker ${workerId} was not found.`);
    this.name = "WorkerNotFoundError";
  }
}

export class WorkerRecovery {
  readonly heartbeatIntervalMs: number;
  readonly heartbeatTimeoutMs: number;

  constructor(options: WorkerRecoveryOptions = {}) {
    this.heartbeatIntervalMs = DEFAULT_HEARTBEAT_INTERVAL_MS;
    this.heartbeatTimeoutMs = options.heartbeatTimeoutMs ?? DEFAULT_HEARTBEAT_TIMEOUT_MS;
    if (!Number.isSafeInteger(this.heartbeatTimeoutMs) || this.heartbeatTimeoutMs <= 0) {
      throw new Error("heartbeatTimeoutMs must be a positive safe integer.");
    }
  }

  async recordWorkerHeartbeat(workerId: string, currentJobCount: number): Promise<HeartbeatResult> {
    if (!Number.isSafeInteger(currentJobCount) || currentJobCount < 0) {
      throw new Error("currentJobCount must be a non-negative safe integer.");
    }

    const result = await prisma.$transaction(async (tx) => {
      const updatedWorkers = await tx.$queryRaw<Array<Worker>>`
        UPDATE "Worker"
        SET
          "status" = 'ONLINE',
          "currentJobCount" = ${currentJobCount},
          "lastHeartbeatAt" = CURRENT_TIMESTAMP,
          "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${workerId}::uuid
          AND "status" = 'ONLINE'
        RETURNING *
      `;
      const worker = updatedWorkers[0];
      if (!worker) {
        throw new WorkerNotFoundError(workerId);
      }

      const heartbeats = await tx.$queryRaw<Array<WorkerHeartbeat>>`
        INSERT INTO "WorkerHeartbeat" ("id", "workerId", "status", "currentJobCount", "recordedAt")
        VALUES (${randomUUID()}::uuid, ${workerId}::uuid, 'ONLINE', ${currentJobCount}, CURRENT_TIMESTAMP)
        RETURNING *
      `;
      const heartbeat = heartbeats[0];
      if (!heartbeat) {
        throw new Error("Worker heartbeat was not recorded.");
      }

      return { worker, heartbeat };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
    await publishWorkerEvent(workerId, "worker.heartbeat", { currentJobCount });
    return result;
  }

  async updateWorkerStatus(workerId: string, status: WorkerStatus): Promise<WorkerStatusUpdate> {
    const worker = await prisma.worker.update({
      where: { id: workerId },
      data: {
        status,
        ...(status === WorkerStatus.STOPPED ? { currentJobCount: 0 } : {}),
        stoppedAt: status === WorkerStatus.STOPPED ? new Date() : null,
        updatedAt: new Date()
      }
    });
    if (status === WorkerStatus.STOPPED) {
      await publishWorkerEvent(workerId, "worker.offline");
    }
    return { worker };
  }

  async recoverStaleWorkers(): Promise<WorkerRecoveryResult[]> {
    assertValidTransition(JobStatus.CLAIMED, JobStatus.QUEUED);
    assertValidTransition(JobStatus.RUNNING, JobStatus.FAILED);

    const candidates = await prisma.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "Worker"
      WHERE "status" = 'ONLINE'
        AND "lastHeartbeatAt" IS NOT NULL
        AND "lastHeartbeatAt" < CURRENT_TIMESTAMP - (${this.heartbeatTimeoutMs}::double precision * INTERVAL '1 millisecond')
    `;

    const results: WorkerRecoveryResult[] = [];
    for (const candidate of candidates) {
      const result = await this.recoverWorker(candidate.id);
      results.push(result);
      if (result.workerProcessed) {
        await publishWorkerEvent(result.workerId, "worker.offline");
      }
    }
    return results;
  }

  private async recoverWorker(workerId: string): Promise<WorkerRecoveryResult> {
    return prisma.$transaction(async (tx) => {
      const rows = await tx.$queryRaw<StaleWorkerRow[]>`
        SELECT "id", "status", "lastHeartbeatAt", "currentJobCount"
        FROM "Worker"
        WHERE "id" = ${workerId}::uuid
          AND "status" = 'ONLINE'
          AND "lastHeartbeatAt" IS NOT NULL
          AND "lastHeartbeatAt" < CURRENT_TIMESTAMP - (${this.heartbeatTimeoutMs}::double precision * INTERVAL '1 millisecond')
        FOR UPDATE
      `;
      const worker = rows[0];
      if (!worker) {
        return { workerId, workerProcessed: false, claimedJobsRecovered: 0, runningJobsFailed: 0 };
      }

      await tx.$executeRaw`
        UPDATE "Worker"
        SET "status" = 'OFFLINE', "currentJobCount" = 0, "updatedAt" = CURRENT_TIMESTAMP
        WHERE "id" = ${workerId}::uuid
          AND "status" = 'ONLINE'
          AND "lastHeartbeatAt" < CURRENT_TIMESTAMP - (${this.heartbeatTimeoutMs}::double precision * INTERVAL '1 millisecond')
      `;

      const ownedJobs = await tx.job.findMany({
        where: { claimedBy: workerId, status: { in: [JobStatus.CLAIMED, JobStatus.RUNNING] } },
        select: { id: true, status: true, attemptCount: true, claimedAt: true }
      });
      let claimedJobsRecovered = 0;
      let runningJobsFailed = 0;

      for (const job of ownedJobs) {
        if (job.status === JobStatus.CLAIMED) {
          await tx.job.update({
            where: { id: job.id },
            data: { status: JobStatus.QUEUED, claimedBy: null, claimedAt: null, updatedAt: new Date() }
          });
          claimedJobsRecovered += 1;
          continue;
        }

        const execution = await tx.jobExecution.findFirst({
          where: { jobId: job.id, workerId, status: ExecutionStatus.RUNNING },
          orderBy: { attemptNumber: "desc" }
        });
        const databaseTime = await tx.$queryRaw<Array<{ now: Date }>>`SELECT CURRENT_TIMESTAMP AS now`;
        const completedAt = databaseTime[0]?.now;
        if (!execution || !completedAt) {
          continue;
        }

        await tx.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.FAILED,
            completedAt,
            durationMs: execution.startedAt ? Math.max(0, completedAt.getTime() - execution.startedAt.getTime()) : null,
            errorMessage: "Worker became stale while job was running.",
            errorCode: "WORKER_STALE"
          }
        });
        await tx.job.update({
          where: { id: job.id },
          data: { status: JobStatus.FAILED, claimedBy: null, claimedAt: null, updatedAt: new Date() }
        });
        await tx.jobLog.create({
          data: {
            executionId: execution.id,
            level: LogLevel.ERROR,
            message: "running execution failed during stale-worker recovery",
            metadata: { workerId, reason: "WORKER_STALE" }
          }
        });
        runningJobsFailed += 1;
      }

      return { workerId, workerProcessed: true, claimedJobsRecovered, runningJobsFailed };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }
}
