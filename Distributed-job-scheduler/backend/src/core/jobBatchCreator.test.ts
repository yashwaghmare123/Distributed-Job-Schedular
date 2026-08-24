import test from "node:test";
import assert from "node:assert/strict";
import { JobStatus, RetryStrategy, WorkerStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { createJobBatch, InvalidJobBatchError, type JobBatchItem } from "./jobBatchCreator.js";

const batchItems: JobBatchItem[] = [
  { jobType: "SEND_EMAIL", payload: { recipient: "a@example.com" } },
  { jobType: "GENERATE_REPORT", payload: { reportId: "123" }, priority: 11 },
  { jobType: "DEFERRED", payload: { key: "value" }, scheduledAt: new Date("2099-01-01T00:00:00.000Z") }
];
type Context = Awaited<ReturnType<typeof createContext>>;

async function createContext() {
  const organization = await prisma.organization.findFirstOrThrow({ where: { name: "Codity Demo Org" } });
  const project = await prisma.project.findFirstOrThrow({ where: { organizationId: organization.id, name: "Scheduler Demo" } });
  const policy = await prisma.retryPolicy.create({ data: { name: `step11-policy-${Date.now()}-${Math.random()}`, strategy: RetryStrategy.FIXED, maxAttempts: 4, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 1, jitter: false } });
  const queue = await prisma.queue.create({ data: { projectId: project.id, name: `step11-queue-a-${Date.now()}-${Math.random()}`, description: "Step 11 test queue", defaultPriority: 7, concurrencyLimit: 10, isPaused: false, retryPolicyId: policy.id } });
  const queueB = await prisma.queue.create({ data: { projectId: project.id, name: `step11-queue-b-${Date.now()}-${Math.random()}`, description: "Step 11 test queue", defaultPriority: 2, concurrencyLimit: 10, isPaused: false, retryPolicyId: policy.id } });
  const worker = await prisma.worker.create({ data: { organizationId: organization.id, name: `step11-worker-${Date.now()}-${Math.random()}`, status: WorkerStatus.ONLINE, concurrency: 1, currentJobCount: 0 } });
  return { organization, project, policy, queue, queueB, worker };
}

async function cleanup(value: Context) {
  const queueIds = [value.queue.id, value.queueB.id];
  await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: { in: queueIds } } } } });
  await prisma.jobExecution.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
  await prisma.job.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.jobBatch.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.scheduledJob.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: value.worker.id } });
  await prisma.worker.deleteMany({ where: { id: value.worker.id } });
  await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.retryPolicy.deleteMany({ where: { id: value.policy.id } });
}

async function counts(value: Context) {
  const queueIds = [value.queue.id, value.queueB.id];
  return {
    batches: await prisma.jobBatch.count({ where: { queueId: { in: queueIds } } }),
    jobs: await prisma.job.count({ where: { queueId: { in: queueIds } } }),
    executions: await prisma.jobExecution.count({ where: { job: { queueId: { in: queueIds } } } }),
    logs: await prisma.jobLog.count({ where: { execution: { job: { queueId: { in: queueIds } } } } })
  };
}

test("creates one batch with correct counters and linked jobs", async () => { const value = await createContext(); try { const result = await createJobBatch(value.queue.id, batchItems); const batch = await prisma.jobBatch.findUniqueOrThrow({ where: { id: result.id }, include: { jobs: true } }); const queue = await prisma.queue.findUniqueOrThrow({ where: { id: value.queue.id } }); assert.equal(batch.queueId, value.queue.id); assert.equal(queue.projectId, value.project.id); assert.equal(batch.totalJobs, 3); assert.equal(batch.pendingJobs, 3); assert.equal(batch.completedJobs, 0); assert.equal(batch.failedJobs, 0); assert.equal(batch.jobs.length, 3); assert.ok(batch.jobs.every((job) => job.batchId === batch.id && job.queueId === value.queue.id)); assert.equal(batch.jobs[0]!.priority, value.queue.defaultPriority); assert.equal(batch.jobs[1]!.priority, 11); assert.equal(batch.jobs[2]!.status, JobStatus.SCHEDULED); assert.equal(batch.jobs[2]!.attemptCount, 0); assert.deepEqual(batch.jobs.map((job) => job.payload), batchItems.map((item) => item.payload)); assert.ok(batch.jobs.every((job) => job.maxAttempts === value.policy.maxAttempts)); assert.deepEqual(await counts(value), { batches: 1, jobs: 3, executions: 0, logs: 0 }); } finally { await cleanup(value); } });

test("rejects empty and invalid input without persistence", async () => { const value = await createContext(); try { await assert.rejects(() => createJobBatch(value.queue.id, []), InvalidJobBatchError); await assert.rejects(() => createJobBatch(value.queue.id, [{ jobType: "", payload: {} }]), InvalidJobBatchError); await assert.rejects(() => createJobBatch(value.queue.id, [{ jobType: "missing", payload: undefined as never }]), InvalidJobBatchError); assert.deepEqual(await counts(value), { batches: 0, jobs: 0, executions: 0, logs: 0 }); } finally { await cleanup(value); } });

test("rejects a nonexistent queue", async () => { const value = await createContext(); try { await assert.rejects(() => createJobBatch("00000000-0000-0000-0000-000000000000", batchItems), /was not found/); assert.deepEqual(await counts(value), { batches: 0, jobs: 0, executions: 0, logs: 0 }); } finally { await cleanup(value); } });

test("rolls back the batch and all jobs after a controlled mid-transaction failure", async () => { const value = await createContext(); try { await assert.rejects(() => createJobBatch(value.queue.id, [{ jobType: "first", payload: {} }, { jobType: "second", payload: {} }], { afterJobCreate: (index) => { if (index === 0) throw new Error("controlled batch failure"); } }), /controlled batch failure/); assert.deepEqual(await counts(value), { batches: 0, jobs: 0, executions: 0, logs: 0 }); } finally { await cleanup(value); } });

test("ten concurrent independent requests create ten complete batches", async () => { const value = await createContext(); try { const results = await Promise.all(Array.from({ length: 10 }, () => createJobBatch(value.queue.id, batchItems))); const batchIds = results.map((result) => result.id); const batches = await prisma.jobBatch.findMany({ where: { id: { in: batchIds } }, include: { jobs: true } }); const jobs = await prisma.job.findMany({ where: { batchId: { in: batchIds } } }); assert.equal(results.length, 10); assert.equal(new Set(batchIds).size, 10); assert.equal(batches.length, 10); assert.equal(jobs.length, 30); assert.equal(jobs.filter((job) => job.batchId === null).length, 0); assert.equal(jobs.filter((job) => job.queueId !== value.queue.id).length, 0); assert.equal(jobs.filter((job) => !batchIds.includes(job.batchId!)).length, 0); assert.equal(batches.filter((batch) => batch.jobs.length !== 3 || batch.totalJobs !== 3 || batch.pendingJobs !== 3 || batch.completedJobs !== 0 || batch.failedJobs !== 0).length, 0); assert.equal(new Set(jobs.map((job) => job.id)).size, 30); } finally { await cleanup(value); } });

test("Queue B jobs remain untouched and Queue A project ownership is derived", async () => { const value = await createContext(); const queueBJob = await prisma.job.create({ data: { queueId: value.queueB.id, jobType: "existing", payload: {}, status: JobStatus.QUEUED, priority: 1, scheduledAt: new Date(), maxAttempts: 3, attemptCount: 0 } }); try { const result = await createJobBatch(value.queue.id, [{ jobType: "isolated", payload: { queue: "A" } }]); const created = await prisma.job.findUniqueOrThrow({ where: { id: result.jobs[0]!.id } }); const untouched = await prisma.job.findUniqueOrThrow({ where: { id: queueBJob.id } }); const queue = await prisma.queue.findUniqueOrThrow({ where: { id: value.queue.id } }); assert.equal(result.queueId, value.queue.id); assert.equal(queue.projectId, value.project.id); assert.equal(created.queueId, value.queue.id); assert.equal(created.batchId, result.id); assert.equal(untouched.queueId, value.queueB.id); assert.equal(untouched.batchId, null); } finally { await cleanup(value); } });

test("paused queues accept durable jobs without claiming or executing them", async () => { const value = await createContext(); await prisma.queue.update({ where: { id: value.queue.id }, data: { isPaused: true } }); const beforeWorker = await prisma.worker.findUniqueOrThrow({ where: { id: value.worker.id } }); try { const result = await createJobBatch(value.queue.id, [{ jobType: "paused", payload: {} }]); const created = await prisma.job.findUniqueOrThrow({ where: { id: result.jobs[0]!.id } }); assert.equal(created.status, JobStatus.QUEUED); assert.equal(created.claimedBy, null); assert.equal(created.claimedAt, null); assert.equal(await prisma.jobExecution.count({ where: { jobId: created.id } }), 0); assert.deepEqual(await prisma.worker.findUniqueOrThrow({ where: { id: value.worker.id } }), beforeWorker); } finally { await cleanup(value); } });

test("batch creation leaves workers, heartbeats, executions, logs, schedules, retries, and DLQ untouched", async () => { const value = await createContext(); const beforeWorker = await prisma.worker.findUniqueOrThrow({ where: { id: value.worker.id } }); const beforeHeartbeats = await prisma.workerHeartbeat.count({ where: { workerId: value.worker.id } }); try { const result = await createJobBatch(value.queue.id, [{ jobType: "isolated", payload: {} }]); const job = result.jobs[0]!; assert.deepEqual(await prisma.worker.findUniqueOrThrow({ where: { id: value.worker.id } }), beforeWorker); assert.equal(await prisma.workerHeartbeat.count({ where: { workerId: value.worker.id } }), beforeHeartbeats); assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 0); assert.equal(await prisma.jobLog.count({ where: { execution: { jobId: job.id } } }), 0); assert.equal(await prisma.scheduledJob.count({ where: { queueId: value.queue.id } }), 0); assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: job.id } }), 0); assert.equal(job.attemptCount, 0); } finally { await cleanup(value); } });
