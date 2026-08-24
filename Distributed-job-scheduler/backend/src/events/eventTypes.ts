import type { JobStatus, WorkerStatus } from "@prisma/client";

export type SchedulerEventType =
  | "job.queued"
  | "job.claimed"
  | "job.running"
  | "job.completed"
  | "job.failed"
  | "job.retry"
  | "job.dead_lettered"
  | "job.cancelled"
  | "job.scheduled"
  | "job.schedule.promoted"
  | "worker.heartbeat"
  | "worker.offline"
  | "worker.recovered";

export type SchedulerEvent = {
  type: SchedulerEventType;
  eventId: string;
  occurredAt: string;
  organizationId: string;
  projectId?: string;
  queueId?: string;
  jobId?: string;
  workerId?: string;
  payload: {
    status?: JobStatus | WorkerStatus;
    previousStatus?: JobStatus;
    currentJobCount?: number;
    attemptCount?: number;
    errorCode?: string | null;
    errorMessage?: string | null;
  };
};
