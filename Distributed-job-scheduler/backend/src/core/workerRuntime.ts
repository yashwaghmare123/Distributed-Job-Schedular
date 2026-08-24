import { JobStatus, ExecutionStatus, LogLevel, Prisma, type Job, type JobExecution } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { assertValidTransition } from "./jobStateMachine.js";
import { claimNextJob } from "./jobClaimer.js";
import { publishJobStateEvent } from "../events/eventBus.js";

export type JobExecutionResult = {
  ok: boolean;
  jobId: string;
  workerId: string;
  status: JobStatus | ExecutionStatus;
  errorMessage?: string | null;
  errorCode?: string | null;
};

export type JobHandler = (job: Job) => Promise<JobExecutionResult | void | null>;

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
  handler: JobHandler;
};

export class WorkerRuntime {
  readonly workerId: string;
  readonly queueId: string;
  readonly pollIntervalMs: number;
  private readonly handler: JobHandler;
  private running = false;
  private stopRequested = false;
  private loopPromise: Promise<void> | null = null;

  constructor(options: WorkerRuntimeOptions) {
    this.workerId = options.workerId;
    this.queueId = options.queueId;
    this.pollIntervalMs = options.pollIntervalMs ?? 250;
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
    this.stopRequested = true;
    if (this.loopPromise) {
      await this.loopPromise;
    }
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
      const job = await this.runOnce();
      if (job === null) {
        await new Promise((resolve) => setTimeout(resolve, this.pollIntervalMs));
      }
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
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

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
      const finalStatus = ExecutionStatus.COMPLETED;
      const completedAt = new Date();

      result = {
        ok: true,
        jobId: job.id,
        workerId: this.workerId,
        status: JobStatus.COMPLETED,
        errorMessage: null,
        errorCode: null
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
      const completedAt = new Date();

      result = {
        ok: false,
        jobId: job.id,
        workerId: this.workerId,
        status: JobStatus.FAILED,
        errorMessage: message,
        errorCode: "EXECUTION_FAILED"
      };

      await prisma.$transaction(async (tx) => {
        await tx.jobExecution.update({
          where: { id: execution.id },
          data: {
            status: ExecutionStatus.FAILED,
            completedAt,
            durationMs: completedAt.getTime() - (execution.startedAt?.getTime() ?? completedAt.getTime()),
            errorMessage: message,
            errorCode: "EXECUTION_FAILED"
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
          metadata: { jobId: job.id, queueId: this.queueId, workerId: this.workerId, error: message }
        }
      });

      return result;
    }
  }
}
