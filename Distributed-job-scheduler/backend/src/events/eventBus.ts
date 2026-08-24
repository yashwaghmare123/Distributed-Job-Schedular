import { randomUUID } from "node:crypto";
import { prisma } from "../lib/prisma.js";
import { metricsRegistry, updateRuntimeMetrics } from "../lib/metrics.js";
import type { JobStatus, WorkerStatus } from "@prisma/client";
import type { SchedulerEvent, SchedulerEventType } from "./eventTypes.js";

export type EventListener = (event: SchedulerEvent) => void | Promise<void>;

class EventBus {
  private readonly listeners = new Set<EventListener>();

  subscribe(listener: EventListener): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  async publish(event: Omit<SchedulerEvent, "eventId" | "occurredAt">): Promise<SchedulerEvent> {
    const complete: SchedulerEvent = { ...event, eventId: randomUUID(), occurredAt: new Date().toISOString() };
    await Promise.allSettled([...this.listeners].map((listener) => listener(complete)));

    switch (complete.type) {
      case "job.queued":
        metricsRegistry.increment("jobs_created_total");
        break;
      case "job.completed":
        metricsRegistry.increment("jobs_completed_total");
        break;
      case "job.failed":
        metricsRegistry.increment("jobs_failed_total");
        break;
      case "job.retry":
        metricsRegistry.increment("jobs_retried_total");
        break;
      case "job.dead_lettered":
        metricsRegistry.increment("jobs_dead_lettered_total");
        break;
      default:
        break;
    }

    await updateRuntimeMetrics();
    return complete;
  }
}

export const eventBus = new EventBus();

export async function publishJobEvent(
  jobId: string,
  type: SchedulerEventType,
  payload: SchedulerEvent["payload"] = {}
): Promise<SchedulerEvent | null> {
  const job = await prisma.job.findUnique({
    where: { id: jobId },
    select: { id: true, queueId: true, status: true, attemptCount: true, queue: { select: { projectId: true, project: { select: { organizationId: true } } } } }
  });
  if (!job) return null;
  return eventBus.publish({
    type,
    organizationId: job.queue.project.organizationId,
    projectId: job.queue.projectId,
    queueId: job.queueId,
    jobId: job.id,
    payload: { status: job.status, attemptCount: job.attemptCount, ...payload }
  });
}

export async function publishWorkerEvent(
  workerId: string,
  type: SchedulerEventType,
  payload: SchedulerEvent["payload"] = {}
): Promise<SchedulerEvent | null> {
  const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { id: true, organizationId: true, status: true, currentJobCount: true } });
  if (!worker) return null;
  return eventBus.publish({
    type,
    organizationId: worker.organizationId,
    workerId: worker.id,
    payload: { status: worker.status as WorkerStatus, currentJobCount: worker.currentJobCount, ...payload }
  });
}

export async function publishJobStateEvent(jobId: string, type: SchedulerEventType, status: JobStatus, previousStatus?: JobStatus) {
  return publishJobEvent(jobId, type, { status, ...(previousStatus ? { previousStatus } : {}) });
}
