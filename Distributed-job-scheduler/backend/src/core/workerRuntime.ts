import { JobStatus, ExecutionStatus, LogLevel, Prisma, WorkerStatus, type Job, type JobExecution } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { claimNextJob } from "./jobClaimer.js";
import { publishJobStateEvent } from "../events/eventBus.js";
import { WorkerRecovery } from "./workerRecovery.js";

export type JobExecutionResult = {
  ok: boolean;
  jobId: string;
  workerId: string;
  status: JobStatus | ExecutionStatus;
  errorMessage?: string | null;
  errorCode?: string | null;
  error?: string | null;
};

export type JobHandler = (job: Job) => Promise<JobExecutionResult | void | null>;

class HandlerFailure extends Error {
  constructor(message: string, readonly errorCode: string) {
    super(message);
    this.name = "HandlerFailure";
  }
}

export class WorkerOwnershipError extends Error {
  constructor(jobId: string, workerId: string, ownerId: string | null) {
    super(`Worker ${workerId} cannot execute job ${jobId}; claimedBy=${ownerId ?? "null"}`);
    this.name = "WorkerOwnershipError";
    this.jobId = jobId;
    this.workerId = workerId;
    this.ownerId = ownerId;
  }

  readonly jobId: string;
  readonly workerId: string;
  readonly ownerId: string | null;
}

export type WorkerRuntimeOptions = {
  workerId: string;
  queueId: string;
  pollIntervalMs?: number;
  heartbeatIntervalMs?: number;
  concurrency?: number;
  handler: JobHandler;
};

export class WorkerRuntime {
  readonly workerId: string;
  readonly queueId: string;
  readonly pollIntervalMs: number;
  readonly heartbeatIntervalMs: number;
  readonly concurrency: number;
  private readonly handler: JobHandler;
  private readonly recovery = new WorkerRecovery();
  private readonly activeJobs = new Set<Promise<unknown>>();
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: WorkerRuntimeOptions) {
    this.workerId = options.workerId;
    this.queueId = options.queueId;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs ?? this.recovery.heartbeatIntervalMs;
    this.concurrency = options.concurrency ?? 1;
    if (!Number.isSafeInteger(this.concurrency) || this.concurrency < 1) {
      throw new Error("concurrency must be a positive safe integer.");
    }
    this.handler = options.handler;
  }

  isRunning(): boolean {
    return this.running;
  }

  start(): void {
    if (this.running) {
      return;
    }

    this.running = true;
    this.stopRequested = false;
    this.heartbeatTimer = setInterval(() => {
      void this.recovery.recordWorkerHeartbeat(this.workerId, this.activeJobs.size).catch((error) => {
        if (!this.stopRequested) console.error(`Worker heartbeat failed for ${this.workerId}.`, error);
      });
    }, this.heartbeatIntervalMs);
    void this.recovery.recordWorkerHeartbeat(this.workerId, 0).catch((error) => {
      console.error(`Worker registration heartbeat failed for ${this.workerId}.`, error);
    });
    this.loopPromise = this.pollLoop().catch((error) => {
      if (!this.stopRequested) {
        console.error(`Worker runtime failed for queue ${this.queueId} worker ${this.workerId}.`, error);
      }
    }).finally(() => {
      this.running = false;
      this.loopPromise = null;
    });
  }

  async stop(): Promise<void> {
    if (!this.running && !this.loopPromise) return;
    this.stopRequested = true;
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = null;
    }
    await this.recovery.updateWorkerStatus(this.workerId, WorkerStatus.DRAINING);
    if (this.loopPromise) {
      await this.loopPromise;
    }
    await Promise.allSettled(Array.from(this.activeJobs));
    await this.recovery.updateWorkerStatus(this.workerId, WorkerStatus.STOPPED);
  }

  async runOnce(): Promise<Job | null> {
    const claimed = await claimNextJob(this.workerId, this.queueId);

    if (!claimed) {
      return null;
    }

    if (claimed.status !== JobStatus.CLAIMED || claimed.claimedBy !== this.workerId) {
      throw new WorkerOwnershipError(claimed.id, this.workerId, claimed.claimedBy);
    }

    await this.executeJob(claimed);
    return claimed;
  }

  private async pollLoop(): Promise<void> {
    while (!this.stopRequested && this.running) {
      if (this.activeJobs.size >= this.concurrency) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }

      let claimed: Job | null;
      try {
        claimed = await claimNextJob(this.workerId, this.queueId);
      } catch (error) {
        console.error(`Worker polling failed for queue ${this.queueId}.`, error);
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }
      if (claimed === null) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
        continue;
      }

      const execution = this.executeJob(claimed).catch((error) => {
        console.error(`Worker execution bookkeeping failed for job ${claimed.id}.`, error);
      });
      this.activeJobs.add(execution);
      void execution.finally(() => this.activeJobs.delete(execution));
    }

    this.running = false;
  }

  async executeJob(job: Job): Promise<JobExecutionResult> {
    const current = await prisma.job.findUnique({ where: { id: job.id } });
    if (!current) {
      throw new Error(`Job ${job.id} not found`);
    }

    if (current.status !== JobStatus.CLAIMED || current.claimedBy !== this.workerId) {
      throw new WorkerOwnershipError(current.id, this.workerId, current.claimedBy);
    }

    const execution = await prisma.$transaction(async (tx) => {
      const latest = await tx.job.findUnique({
        where: { id: job.id }
      });

      if (!latest || latest.status !== JobStatus.CLAIMED || latest.claimedBy !== this.workerId) {
        throw new WorkerOwnershipError(job.id, this.workerId, latest?.claimedBy ?? null);
      }

      const incremented = await tx.job.update({
        where: { id: job.id },
        data: {
          status: JobStatus.RUNNING,
          attemptCount: { increment: 1 },
          updatedAt: new Date()
        }
      });

      const attemptNumber = incremented.attemptCount;
      const startedAt = new Date();

      return tx.jobExecution.create({
        data: {
          jobId: job.id,
          workerId: this.workerId,
          attemptNumber,
          status: ExecutionStatus.RUNNING,
          startedAt,
          completedAt: null,
          durationMs: null,
          errorMessage: null,
          errorCode: null
        }
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted,
      maxWait: 10_000,
      timeout: 10_000
    });

    await publishJobStateEvent(job.id, "job.running", JobStatus.RUNNING, JobStatus.CLAIMED);

    await prisma.jobLog.create({
      data: {
        executionId: execution.id,
        level: LogLevel.INFO,
        message: "execution started",
        metadata: { jobId: job.id, queueId: this.queueId, workerId: this.workerId }
      }
    });

    let result: JobExecutionResult;

    try {
      const handlerResult = await this.handler(job);
      if (handlerResult && !handlerResult.ok) {
        throw new HandlerFailure(
          handlerResult.errorMessage ?? handlerResult.error ?? "The job handler reported a failure.",
          handlerResult.errorCode ?? "EXECUTION_FAILED"
        );
      }
      const finalStatus = ExecutionStatus.COMPLETED;
      const completedAt = new Date();

      result = {
        ok: true,
        jobId: job.id,
        workerId: this.workerId,
        status: JobStatus.COMPLETED,
        errorMessage: null,
        errorCode: null,
        error: null
      };

      await prisma.$transaction(async (tx) => {
        await tx.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: finalStatus,
            completedAt,
            durationMs: completedAt.getTime() - (execution.startedAt?.getTime() ?? completedAt.getTime()),
            errorMessage: null,
            errorCode: null
          }
        });

        await tx.job.update({
          where: { id: job.id },
          data: {
            status: JobStatus.COMPLETED,
            claimedBy: null,
            claimedAt: null,
            updatedAt: new Date()
          }
        });

        if (job.batchId) {
          await tx.jobBatch.updateMany({
            where: { id: job.batchId, pendingJobs: { gt: 0 } },
            data: { completedJobs: { increment: 1 }, pendingJobs: { decrement: 1 } }
          });
        }
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

      await publishJobStateEvent(job.id, "job.completed", JobStatus.COMPLETED, JobStatus.RUNNING);

      await prisma.jobLog.create({
        data: {
          executionId: execution.id,
          level: LogLevel.INFO,
          message: "execution completed",
          metadata: { jobId: job.id, queueId: this.queueId, workerId: this.workerId, result: handlerResult ?? null }
        }
      });

      return result;
    } catch (error) {
      const message = error instanceof Error ? error.message : "unknown execution error";
      const errorCode = error instanceof HandlerFailure ? error.errorCode : "EXECUTION_FAILED";
      const failureMessage = error instanceof HandlerFailure ? error.message : message;
      const completedAt = new Date();

      result = {
        ok: false,
        jobId: job.id,
        workerId: this.workerId,
        status: JobStatus.FAILED,
        errorMessage: failureMessage,
        errorCode,
        error: failureMessage
      };

      await prisma.$transaction(async (tx) => {
        await tx.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.FAILED,
            completedAt,
            durationMs: completedAt.getTime() - (execution.startedAt?.getTime() ?? completedAt.getTime()),
            errorMessage: message,
            errorCode
          }
        });

        await tx.job.update({
          where: { id: job.id },
          data: {
            status: JobStatus.FAILED,
            claimedBy: null,
            claimedAt: null,
            updatedAt: new Date()
          }
        });
      }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

      await publishJobStateEvent(job.id, "job.failed", JobStatus.FAILED, JobStatus.RUNNING);

      await prisma.jobLog.create({
        data: {
          executionId: execution.id,
          level: LogLevel.ERROR,
          message: "execution failed",
          metadata: { jobId: job.id, queueId: this.queueId, workerId: this.workerId, error: message, errorCode }
        }
      });

      return result;
    }
  }
}
