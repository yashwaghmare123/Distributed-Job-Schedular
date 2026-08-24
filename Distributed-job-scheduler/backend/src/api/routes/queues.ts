import { Router } from "express";
import { JobStatus, Prisma, RetryStrategy } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../lib/errors.js";
import { parseRequest, parseQueryPagination } from "../lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { createJobBatch, type JobBatchItem } from "../../core/jobBatchCreator.js";
import { RetryProcessor } from "../../core/retryProcessor.js";
import { Scheduler } from "../../core/scheduler.js";
import { WorkerRecovery } from "../../core/workerRecovery.js";
import { publishJobStateEvent } from "../../events/eventBus.js";
import { jobQueueSchema, jobCreateSchema, batchJobSchema, scheduledJobCreateSchema } from "./schemas.js";
import { batchRateLimit, readRateLimit, writeRateLimit } from "../middleware/rateLimit.js";

const router = Router();
const retryProcessor = new RetryProcessor();
const scheduler = new Scheduler();
const workerRecovery = new WorkerRecovery();

const defaultRetryPolicies = [
  { name: "seed-fixed", strategy: RetryStrategy.FIXED, maxAttempts: 3, initialDelayMs: 5000, maxDelayMs: 30000, backoffMultiplier: new Prisma.Decimal("1"), jitter: false },
  { name: "seed-linear", strategy: RetryStrategy.LINEAR, maxAttempts: 4, initialDelayMs: 10000, maxDelayMs: 120000, backoffMultiplier: new Prisma.Decimal("1"), jitter: false },
  { name: "seed-exponential", strategy: RetryStrategy.EXPONENTIAL, maxAttempts: 5, initialDelayMs: 15000, maxDelayMs: 300000, backoffMultiplier: new Prisma.Decimal("2"), jitter: true }
] as const;

async function ensureDefaultRetryPolicies() {
  const count = await prisma.retryPolicy.count();
  if (count > 0) {
    return;
  }

  await prisma.retryPolicy.createMany({
    data: defaultRetryPolicies.map((policy) => ({
      name: policy.name,
      strategy: policy.strategy,
      maxAttempts: policy.maxAttempts,
      initialDelayMs: policy.initialDelayMs,
      maxDelayMs: policy.maxDelayMs,
      backoffMultiplier: policy.backoffMultiplier,
      jitter: policy.jitter
    }))
  });
}

router.use(requireAuth);

router.get("/retry-policies", readRateLimit, async (request, response, next) => {
  try {
    await ensureDefaultRetryPolicies();
    const policies = await prisma.retryPolicy.findMany({
      orderBy: [{ name: "asc" }],
      select: { id: true, name: true, strategy: true, maxAttempts: true }
    });
    response.json({ data: policies });
  } catch (error) {
    next(error);
  }
});

function asUuid(value: string | string[] | undefined, label: string): string {
  const raw = Array.isArray(value) ? value[0] : value;
  if (!raw) {
    throw new HttpError(400, "VALIDATION_ERROR", `Invalid ${label}`);
  }

  return parseRequest(z.string().uuid(), raw, `Invalid ${label}`);
}

function toQueueUpdateData(input: Record<string, unknown>) {
  const update: Record<string, unknown> = {};
  if (input.defaultPriority !== undefined) update.defaultPriority = Number(input.defaultPriority);
  if (input.isPaused !== undefined) update.isPaused = Boolean(input.isPaused);
  if (input.concurrencyLimit !== undefined) update.concurrencyLimit = Number(input.concurrencyLimit);
  if (input.retryPolicyId !== undefined) update.retryPolicyId = String(input.retryPolicyId);
  if (input.name !== undefined) update.name = String(input.name);
  if (input.description !== undefined) update.description = input.description === null ? null : String(input.description);
  return update;
}

function normalizeBatchJobs(input: Array<Record<string, unknown>>): JobBatchItem[] {
  return input.map((item) => ({
    jobType: String(item.jobType),
    payload: item.payload as Prisma.InputJsonValue,
    ...(item.priority !== undefined ? { priority: Number(item.priority) } : {}),
    ...(item.scheduledAt !== undefined ? { scheduledAt: new Date(String(item.scheduledAt)) } : {}),
    ...(item.maxAttempts !== undefined ? { maxAttempts: Number(item.maxAttempts) } : {}),
    ...(item.idempotencyKey !== undefined ? { idempotencyKey: String(item.idempotencyKey) } : {})
  }));
}

function isJobIdempotencyConflict(error: unknown): boolean {
  if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== "P2002") {
    return false;
  }

  return error.meta?.modelName === "Job" && /queueId.*idempotencyKey|idempotencyKey.*queueId/.test(error.message);
}

router.get("/projects/:projectId/queues", readRateLimit, async (request, response, next) => {
  try {
    const projectId = asUuid(request.params.projectId, "projectId");
    const query = parseQueryPagination(request.query as Record<string, unknown>);

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { organizationId: true } });
    if (!project) throw new HttpError(404, "NOT_FOUND", "Project not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this project.");

    const where = { projectId };
    const [queues, total] = await Promise.all([
      prisma.queue.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.queue.count({ where })
    ]);
    response.json({ data: queues, pagination: { page: query.page, limit: query.limit, hasMore: queues.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.post("/projects/:projectId/queues", writeRateLimit, async (request, response, next) => {
  try {
    const projectId = asUuid(request.params.projectId, "projectId");
    const body = parseRequest(jobQueueSchema, request.body, "Invalid queue request");

    const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, organizationId: true } });
    if (!project) throw new HttpError(404, "NOT_FOUND", "Project not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this project.");

    const retryPolicy = await prisma.retryPolicy.findUnique({ where: { id: body.retryPolicyId } });
    if (!retryPolicy) throw new HttpError(404, "NOT_FOUND", "Retry policy not found.");

    const queue = await prisma.queue.create({
      data: {
        projectId,
        name: body.name,
        description: body.description ?? null,
        defaultPriority: body.defaultPriority ?? 0,
        concurrencyLimit: body.concurrencyLimit,
        isPaused: body.isPaused ?? false,
        retryPolicyId: body.retryPolicyId
      }
    });

    response.status(201).json(queue);
  } catch (error) {
    next(error);
  }
});

router.patch("/queues/:id", writeRateLimit, async (request, response, next) => {
  try {
    const queueId = asUuid(request.params.id, "id");
    const queue = await prisma.queue.findUnique({ where: { id: queueId }, include: { project: { select: { organizationId: true } } } });
    if (!queue) throw new HttpError(404, "NOT_FOUND", "Queue not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this queue.");

    const allowed = z.object({
      defaultPriority: z.number().int().safe().optional(),
      isPaused: z.boolean().optional(),
      concurrencyLimit: z.number().int().min(1).max(1000).optional(),
      retryPolicyId: z.string().uuid().optional(),
      name: z.string().min(1).max(200).optional(),
      description: z.string().max(2000).nullable().optional()
    });

    const body = parseRequest(allowed.partial(), request.body, "Invalid queue update");
    const updateData = toQueueUpdateData(body as Record<string, unknown>);
    const updated = await prisma.queue.update({ where: { id: queueId }, data: updateData });
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

router.post("/queues/:id/jobs", writeRateLimit, async (request, response, next) => {
  try {
    const queueId = asUuid(request.params.id, "id");
    const queue = await prisma.queue.findUnique({
      where: { id: queueId },
      include: { project: { select: { organizationId: true } }, retryPolicy: true }
    });
    if (!queue) throw new HttpError(404, "NOT_FOUND", "Queue not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this queue.");

    const body = parseRequest(jobCreateSchema, request.body, "Invalid job request");
    const idempotencyKey = Array.isArray(request.headers["idempotency-key"]) ? request.headers["idempotency-key"][0] : request.headers["idempotency-key"] ?? body.idempotencyKey;
    const scheduledAt = body.scheduledAt ? new Date(body.scheduledAt) : new Date();
    const status = scheduledAt.getTime() > Date.now() ? JobStatus.SCHEDULED : JobStatus.QUEUED;
    try {
      const job = await prisma.job.create({
        data: {
          queueId,
          jobType: body.jobType,
          payload: body.payload,
          priority: body.priority ?? queue.defaultPriority,
          scheduledAt,
          maxAttempts: body.maxAttempts ?? (queue.retryPolicy?.maxAttempts ?? 1),
          attemptCount: 0,
          idempotencyKey: idempotencyKey ?? null,
          claimedBy: null,
          claimedAt: null,
          status
        }
      });

      await publishJobStateEvent(job.id, status === JobStatus.SCHEDULED ? "job.scheduled" : "job.queued", status);
      response.status(201).json(job);
    } catch (error) {
      if (!idempotencyKey || !isJobIdempotencyConflict(error)) {
        throw error;
      }

      const existingJob = await prisma.job.findUnique({
        where: { queueId_idempotencyKey: { queueId, idempotencyKey } }
      });
      if (!existingJob) {
        throw error;
      }

      response.status(200).json(existingJob);
    }
  } catch (error) {
    next(error);
  }
});

router.post("/queues/:id/jobs/batch", batchRateLimit, async (request, response, next) => {
  try {
    const queueId = asUuid(request.params.id, "id");
    const queue = await prisma.queue.findUnique({ where: { id: queueId }, include: { project: { select: { organizationId: true } } } });
    if (!queue) throw new HttpError(404, "NOT_FOUND", "Queue not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this queue.");

    const body = parseRequest(z.object({ jobs: z.array(batchJobSchema).min(1) }), request.body, "Invalid batch request");
    const batch = await createJobBatch(queueId, normalizeBatchJobs(body.jobs as Array<Record<string, unknown>>));
    for (const job of batch.jobs) {
      await publishJobStateEvent(job.id, job.status === "SCHEDULED" ? "job.scheduled" : "job.queued", job.status);
    }
    response.status(201).json(batch);
  } catch (error) {
    next(error);
  }
});

router.get("/jobs", readRateLimit, async (request, response, next) => {
  try {
    const query = parseQueryPagination(request.query as Record<string, unknown>);
    const filters: Record<string, unknown> = {
      queue: { project: { organizationId: { in: request.user!.organizationIds } } }
    };
    const raw = request.query as Record<string, unknown>;
    if (raw.status) filters.status = raw.status;
    if (raw.queueId) filters.queueId = raw.queueId;
    if (raw.jobType) filters.jobType = raw.jobType;
    if (raw.priority) filters.priority = Number(raw.priority);
    if (raw.batchId) filters.batchId = raw.batchId;

    const [jobs, total] = await Promise.all([
      prisma.job.findMany({
        where: filters,
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit
      }),
      prisma.job.count({ where: filters })
    ]);

    response.json({ data: jobs, pagination: { page: query.page, limit: query.limit, hasMore: jobs.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.post("/queues/:id/scheduled-jobs", writeRateLimit, async (request, response, next) => {
  try {
    const queueId = asUuid(request.params.id, "id");
    const queue = await prisma.queue.findUnique({
      where: { id: queueId },
      include: { project: { select: { organizationId: true } } }
    });
    if (!queue) throw new HttpError(404, "NOT_FOUND", "Queue not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this queue.");

    const body = parseRequest(scheduledJobCreateSchema, request.body, "Invalid recurring schedule request");
    const nextRunAt = body.nextRunAt ? new Date(body.nextRunAt) : new Date(Date.now() + 60_000);
    const scheduledJob = await scheduler.createScheduledJob({
      queueId,
      jobType: body.jobType,
      payload: body.payload,
      cronExpression: body.cronExpression,
      nextRunAt,
      enabled: body.enabled ?? true
    });

    response.status(201).json(scheduledJob);
  } catch (error) {
    next(error);
  }
});

router.get("/scheduled-jobs", readRateLimit, async (request, response, next) => {
  try {
    const query = parseQueryPagination(request.query as Record<string, unknown>);
    const where = { queue: { project: { organizationId: { in: request.user!.organizationIds } } } };
    const [scheduledJobs, total] = await Promise.all([
      prisma.scheduledJob.findMany({
        where,
        include: { queue: { select: { id: true, name: true, projectId: true } } },
        orderBy: { nextRunAt: "asc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit
      }),
      prisma.scheduledJob.count({ where })
    ]);

    const relevantQueueIds = scheduledJobs.map((item) => item.queueId);
    const runSummaries = new Map<string, { lastRunAt: Date | null; runCount: number }>();
    if (relevantQueueIds.length > 0) {
      const occurrences = await prisma.job.findMany({
        where: {
          queueId: { in: relevantQueueIds },
          idempotencyKey: { startsWith: "scheduler:" }
        },
        select: { idempotencyKey: true, scheduledAt: true }
      });

      for (const occurrence of occurrences) {
        const match = occurrence.idempotencyKey?.match(/^scheduler:([0-9a-f-]+):/i);
        if (!match) continue;
        const scheduleId = match[1];
        const current = runSummaries.get(scheduleId) ?? { lastRunAt: null, runCount: 0 };
        current.runCount += 1;
        if (!current.lastRunAt || occurrence.scheduledAt > current.lastRunAt) {
          current.lastRunAt = occurrence.scheduledAt;
        }
        runSummaries.set(scheduleId, current);
      }
    }

    const payload = scheduledJobs.map((item) => ({
      ...item,
      lastRunAt: runSummaries.get(item.id)?.lastRunAt ?? null,
      runCount: runSummaries.get(item.id)?.runCount ?? 0,
      status: item.enabled ? "Enabled" : "Disabled"
    }));

    response.json({ data: payload, pagination: { page: query.page, limit: query.limit, hasMore: scheduledJobs.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.get("/executions", readRateLimit, async (request, response, next) => {
  try {
    const query = parseQueryPagination(request.query as Record<string, unknown>);
    const raw = request.query as Record<string, unknown>;
    const where: Record<string, unknown> = { job: { queue: { project: { organizationId: { in: request.user!.organizationIds } } } } };
    if (raw.jobId) where.jobId = raw.jobId;
    if (raw.workerId) where.workerId = raw.workerId;
    if (raw.status) where.status = raw.status;
    const [executions, total] = await Promise.all([
      prisma.jobExecution.findMany({
        where,
        include: { job: { select: { id: true, jobType: true, queueId: true } }, worker: { select: { id: true, name: true } } },
        orderBy: { createdAt: "desc" },
        skip: (query.page - 1) * query.limit,
        take: query.limit
      }),
      prisma.jobExecution.count({ where })
    ]);
    response.json({ data: executions, pagination: { page: query.page, limit: query.limit, hasMore: executions.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.get("/jobs/:id", readRateLimit, async (request, response, next) => {
  try {
    const jobId = asUuid(request.params.id, "id");
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { queue: { include: { project: true } }, executions: { orderBy: { attemptNumber: "asc" } }, deadLetterEntry: true }
    });
    if (!job) throw new HttpError(404, "NOT_FOUND", "Job not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: job.queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this job.");

    response.json(job);
  } catch (error) {
    next(error);
  }
});

router.get("/jobs/:id/executions", readRateLimit, async (request, response, next) => {
  try {
    const jobId = asUuid(request.params.id, "id");
    const job = await prisma.job.findUnique({ where: { id: jobId }, include: { queue: { include: { project: true } } } });
    if (!job) throw new HttpError(404, "NOT_FOUND", "Job not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: job.queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this job.");

    const executions = await prisma.jobExecution.findMany({ where: { jobId }, orderBy: { attemptNumber: "asc" } });
    response.json({ data: executions });
  } catch (error) {
    next(error);
  }
});

router.post("/jobs/:id/retry", async (request, response, next) => {
  try {
    const jobId = asUuid(request.params.id, "id");
    const job = await prisma.job.findUnique({ where: { id: jobId }, include: { queue: { include: { project: true } } } });
    if (!job) throw new HttpError(404, "NOT_FOUND", "Job not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: job.queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this job.");

    const result = await retryProcessor.scheduleFailedJob(jobId, job.queueId);
    response.json(result);
  } catch (error) {
    next(error);
  }
});

router.post("/jobs/:id/cancel", async (request, response, next) => {
  try {
    const jobId = asUuid(request.params.id, "id");
    const job = await prisma.job.findUnique({ where: { id: jobId }, include: { queue: { include: { project: true } } } });
    if (!job) throw new HttpError(404, "NOT_FOUND", "Job not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: job.queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this job.");

    const validTransitions = ["QUEUED", "SCHEDULED", "CLAIMED", "RUNNING", "RETRY"] as const;
    if (!validTransitions.includes(job.status as (typeof validTransitions)[number])) {
      throw new HttpError(409, "CONFLICT", "This job cannot be cancelled in its current state.");
    }

    const updated = await prisma.job.update({
      where: { id: jobId },
      data: { status: "CANCELLED", claimedBy: null, claimedAt: null, updatedAt: new Date() }
    });

    await publishJobStateEvent(updated.id, "job.cancelled", JobStatus.CANCELLED, job.status as JobStatus);
    response.json(updated);
  } catch (error) {
    next(error);
  }
});

router.get("/workers", readRateLimit, async (request, response, next) => {
  try {
    const query = parseQueryPagination(request.query as Record<string, unknown>);
    const where = { organizationId: { in: request.user!.organizationIds } };
    const [workers, total] = await Promise.all([
      prisma.worker.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.worker.count({ where })
    ]);
    response.json({ data: workers, pagination: { page: query.page, limit: query.limit, hasMore: workers.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.get("/workers/:id/heartbeats", readRateLimit, async (request, response, next) => {
  try {
    const workerId = asUuid(request.params.id, "id");
    const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { organizationId: true } });
    if (!worker) throw new HttpError(404, "NOT_FOUND", "Worker not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: worker.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this worker.");

    const heartbeats = await prisma.workerHeartbeat.findMany({ where: { workerId }, orderBy: { recordedAt: "desc" } });
    response.json({ data: heartbeats });
  } catch (error) {
    next(error);
  }
});

router.post("/workers/:id/heartbeat", async (request, response, next) => {
  try {
    const workerId = asUuid(request.params.id, "id");
    const body = parseRequest(z.object({ currentJobCount: z.number().int().min(0).safe() }), request.body, "Invalid heartbeat request");
    const worker = await prisma.worker.findUnique({ where: { id: workerId }, select: { organizationId: true, status: true } });
    if (!worker) throw new HttpError(404, "NOT_FOUND", "Worker not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: worker.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this worker.");
    if (worker.status === "STOPPED" || worker.status === "DRAINING") {
      throw new HttpError(409, "CONFLICT", "This worker is not accepting heartbeats in its current state.");
    }

    const result = await workerRecovery.recordWorkerHeartbeat(workerId, body.currentJobCount);
    response.json({
      worker: {
        id: result.worker.id,
        status: result.worker.status,
        currentJobCount: result.worker.currentJobCount,
        lastHeartbeatAt: result.worker.lastHeartbeatAt
      },
      heartbeat: {
        id: result.heartbeat.id,
        workerId: result.heartbeat.workerId,
        status: result.heartbeat.status,
        currentJobCount: result.heartbeat.currentJobCount,
        recordedAt: result.heartbeat.recordedAt
      }
    });
  } catch (error) {
    next(error);
  }
});

router.get("/dlq", readRateLimit, async (request, response, next) => {
  try {
    const query = parseQueryPagination(request.query as Record<string, unknown>);
    const where = { job: { queue: { project: { organizationId: { in: request.user!.organizationIds } } } } };
    const [entries, total] = await Promise.all([
      prisma.deadLetterEntry.findMany({ where, orderBy: { failedAt: "desc" }, skip: (query.page - 1) * query.limit, take: query.limit, include: { job: { include: { queue: { include: { project: true } } } } } }),
      prisma.deadLetterEntry.count({ where })
    ]);
    response.json({ data: entries, pagination: { page: query.page, limit: query.limit, hasMore: entries.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.post("/dlq/:id/requeue", async (request, response, next) => {
  try {
    const id = asUuid(request.params.id, "id");
    const entry = await prisma.deadLetterEntry.findUnique({
      where: { id },
      include: { job: { include: { queue: { include: { project: true } } } } }
    });
    if (!entry) throw new HttpError(404, "NOT_FOUND", "Dead-letter entry not found.");

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: entry.job.queue.project.organizationId, userId: request.user!.id }
    });
    if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this DLQ entry.");

    const current = await prisma.job.findUnique({ where: { id: entry.jobId }, include: { deadLetterEntry: true } });
    if (!current || current.status !== "DEAD_LETTER") throw new HttpError(409, "CONFLICT", "This dead-letter entry is no longer active.");

    const queued = await prisma.$transaction(async (tx) => {
      const updated = await tx.job.update({
        where: { id: entry.jobId },
        data: { status: "QUEUED", claimedBy: null, claimedAt: null, updatedAt: new Date(), scheduledAt: new Date() }
      });

      await tx.deadLetterEntry.update({
        where: { id: entry.id },
        data: { requeuedAt: new Date() }
      });

      return updated;
    });

    response.json({ message: "Job requeued from DLQ.", job: queued });
  } catch (error) {
    next(error);
  }
});

export default router;
