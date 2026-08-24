import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionStatus, JobStatus, RetryStrategy, WorkerStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { RetryProcessor } from "./retryProcessor.js";
import { DeadLetterProcessor } from "./deadLetterProcessor.js";

const dlq = new DeadLetterProcessor();
const retry = new RetryProcessor();
type Context = Awaited<ReturnType<typeof context>>;

async function context() {
  const organization = await prisma.organization.findFirstOrThrow({ where: { name: "Codity Demo Org" } });
  const project = await prisma.project.findFirstOrThrow({ where: { organizationId: organization.id, name: "Scheduler Demo" } });
  const policy = await prisma.retryPolicy.create({ data: { name: `step8-policy-${Date.now()}-${Math.random()}`, strategy: RetryStrategy.FIXED, maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 1, jitter: false } });
  const queue = await prisma.queue.create({ data: { projectId: project.id, name: `step8-queue-a-${Date.now()}-${Math.random()}`, description: "Step 8 test queue", defaultPriority: 0, concurrencyLimit: 10, isPaused: false, retryPolicyId: policy.id } });
  const queueB = await prisma.queue.create({ data: { projectId: project.id, name: `step8-queue-b-${Date.now()}-${Math.random()}`, description: "Step 8 test queue", defaultPriority: 0, concurrencyLimit: 10, isPaused: false, retryPolicyId: policy.id } });
  const worker = await prisma.worker.create({ data: { organizationId: organization.id, name: `step8-worker-${Date.now()}-${Math.random()}`, status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0 } });
  return { organization, project, policy, queue, queueB, worker };
}

async function cleanup(value: Context) {
  const queueIds = [value.queue.id, value.queueB.id];
  await prisma.deadLetterEntry.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
  await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: { in: queueIds } } } } });
  await prisma.jobExecution.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
  await prisma.job.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.worker.deleteMany({ where: { id: value.worker.id } });
  await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.retryPolicy.deleteMany({ where: { id: value.policy.id } });
}

async function job(value: Context, status: JobStatus = JobStatus.FAILED, attemptCount = 3, maxAttempts = 3, queueId = value.queue.id) {
  return prisma.job.create({ data: { queueId, jobType: "step8-dlq-test", payload: { step: 8 }, status, priority: 1, scheduledAt: new Date(), maxAttempts, attemptCount, claimedBy: status === JobStatus.CLAIMED || status === JobStatus.RUNNING ? value.worker.id : null, claimedAt: status === JobStatus.CLAIMED || status === JobStatus.RUNNING ? new Date() : null, idempotencyKey: `${Date.now()}-${Math.random()}` } });
}

async function failedExecution(value: Context, jobId: string, attemptNumber = 1, errorMessage = "provider exhausted") {
  return prisma.jobExecution.create({ data: { jobId, workerId: value.worker.id, attemptNumber, status: ExecutionStatus.FAILED, startedAt: new Date(Date.now() - 500), completedAt: new Date(Date.now() - 100), durationMs: 400, errorMessage, errorCode: "STEP8_FAILURE" } });
}

async function load(value: Context, jobId: string) {
  return prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { executions: { orderBy: { attemptNumber: "asc" } }, deadLetterEntry: true } });
}

test("basic exhausted FAILED job becomes DEAD_LETTER with diagnostic entry", async () => {
  const value = await context();
  const target = await job(value);
  const execution = await failedExecution(value, target.id, 1, "final provider failure");
  const ownership = await prisma.queue.findUniqueOrThrow({ where: { id: value.queue.id }, select: { projectId: true, project: { select: { organizationId: true } } } });
  try {
    const result = await dlq.processDeadLetter(target.id, value.queue.id);
    const persisted = await load(value, target.id);
    assert.equal(result.processed, true);
    assert.equal(persisted.status, JobStatus.DEAD_LETTER);
    assert.equal(persisted.deadLetterEntry ? 1 : 0, 1);
    assert.equal(persisted.attemptCount, 3);
    assert.equal(persisted.queueId, value.queue.id);
    assert.equal(persisted.executions.length, 1);
    assert.equal(persisted.executions[0]!.id, execution.id);
    assert.equal(persisted.executions[0]!.status, ExecutionStatus.FAILED);
    assert.ok(persisted.deadLetterEntry?.reason.length);
    assert.equal(persisted.deadLetterEntry?.errorMessage, "final provider failure");
    assert.equal(persisted.deadLetterEntry?.lastWorkerId, execution.workerId);
    assert.ok(persisted.deadLetterEntry?.lastWorkerId);
    assert.equal((await prisma.queue.findUniqueOrThrow({ where: { id: value.queue.id }, select: { projectId: true, project: { select: { organizationId: true } } } })).projectId, ownership.projectId);
    assert.equal((await prisma.queue.findUniqueOrThrow({ where: { id: value.queue.id }, select: { project: { select: { organizationId: true } } } })).project.organizationId, ownership.project.organizationId);
    assert.ok(persisted.deadLetterEntry?.failedAt instanceof Date);
  } finally { await cleanup(value); }
});

test("retryable FAILED job is not dead-lettered", async () => {
  const value = await context(); const target = await job(value, JobStatus.FAILED, 2, 3);
  try { const result = await dlq.processDeadLetter(target.id, value.queue.id); const persisted = await load(value, target.id); assert.equal(result.processed, false); assert.equal(persisted.status, JobStatus.FAILED); assert.equal(persisted.deadLetterEntry, null); assert.equal(persisted.attemptCount, 2); } finally { await cleanup(value); }
});

test("already DEAD_LETTER job is idempotent", async () => {
  const value = await context(); const target = await job(value, JobStatus.DEAD_LETTER); const entry = await prisma.deadLetterEntry.create({ data: { jobId: target.id, reason: "already processed", attemptCount: 3, failedAt: new Date() } });
  try { const first = await dlq.processDeadLetter(target.id, value.queue.id); const second = await dlq.processDeadLetter(target.id, value.queue.id); assert.equal(first.processed, false); assert.equal(second.processed, false); assert.equal((await prisma.deadLetterEntry.count({ where: { jobId: target.id } })), 1); assert.equal((await load(value, target.id)).deadLetterEntry?.id, entry.id); } finally { await cleanup(value); }
});

test("RETRY is never dead-lettered", async () => {
  const value = await context(); const target = await job(value, JobStatus.RETRY, 3, 3);
  try { const result = await dlq.processDeadLetter(target.id, value.queue.id); assert.equal(result.processed, false); assert.equal((await load(value, target.id)).status, JobStatus.RETRY); } finally { await cleanup(value); }
});

test("non-FAILED statuses are never dead-lettered", async () => {
  const value = await context(); const statuses = [JobStatus.QUEUED, JobStatus.SCHEDULED, JobStatus.CLAIMED, JobStatus.RUNNING, JobStatus.COMPLETED, JobStatus.CANCELLED]; const targets = await Promise.all(statuses.map((status) => job(value, status, 3, 3)));
  try { await Promise.all(targets.map((target) => dlq.processDeadLetter(target.id, value.queue.id))); const rows = await prisma.job.findMany({ where: { id: { in: targets.map((target) => target.id) } }, include: { deadLetterEntry: true } }); assert.ok(rows.every((row) => row.status !== JobStatus.DEAD_LETTER && row.deadLetterEntry === null)); } finally { await cleanup(value); }
});

test("all failed execution history is preserved", async () => {
  const value = await context(); const target = await job(value, JobStatus.FAILED, 3, 3); await failedExecution(value, target.id, 1); await failedExecution(value, target.id, 2); await failedExecution(value, target.id, 3);
  try { await dlq.processDeadLetter(target.id); const persisted = await load(value, target.id); assert.equal(persisted.status, JobStatus.DEAD_LETTER); assert.equal(persisted.executions.length, 3); assert.deepEqual(persisted.executions.map((item) => item.attemptNumber), [1, 2, 3]); assert.ok(persisted.executions.every((item) => item.status === ExecutionStatus.FAILED)); assert.equal(persisted.attemptCount, 3); } finally { await cleanup(value); }
});

test("ten concurrent processors produce one DEAD_LETTER entry", async () => {
  const value = await context(); const target = await job(value); await failedExecution(value, target.id);
  try { const results = await Promise.all(Array.from({ length: 10 }, () => dlq.processDeadLetter(target.id, value.queue.id))); const persisted = await load(value, target.id); assert.equal(results.filter((result) => result.processed).length, 1); assert.equal(persisted.status, JobStatus.DEAD_LETTER); assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: target.id } }), 1); assert.equal(persisted.attemptCount, 3); assert.equal(persisted.executions.length, 1); } finally { await cleanup(value); }
});

test("DLQ processing is queue-isolated", async () => {
  const value = await context(); const a = await job(value); const b = await job(value, JobStatus.FAILED, 3, 3, value.queueB.id);
  try { const result = await dlq.processDeadLetter(a.id, value.queue.id); assert.equal(result.processed, true); assert.equal((await load(value, a.id)).status, JobStatus.DEAD_LETTER); assert.equal((await load(value, b.id)).status, JobStatus.FAILED); assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: b.id } }), 0); } finally { await cleanup(value); }
});

test("entry creation failure rolls back the state transition", async () => {
  const value = await context(); const target = await job(value); await failedExecution(value, target.id);
  const failingProcessor = new DeadLetterProcessor({ beforeEntryCreate: () => { throw new Error("controlled entry failure"); } });
  try { await assert.rejects(() => failingProcessor.processDeadLetter(target.id, value.queue.id), /controlled entry failure/); const persisted = await load(value, target.id); assert.equal(persisted.status, JobStatus.FAILED); assert.equal(persisted.deadLetterEntry, null); assert.equal(persisted.attemptCount, 3); assert.equal(persisted.executions.length, 1); } finally { await cleanup(value); }
});

test("repeated processing is idempotent", async () => {
  const value = await context(); const target = await job(value); await failedExecution(value, target.id);
  try { const results = [await dlq.processDeadLetter(target.id, value.queue.id), await dlq.processDeadLetter(target.id, value.queue.id), await dlq.processDeadLetter(target.id, value.queue.id)]; assert.equal(results[0]!.processed, true); assert.equal(results[1]!.processed, false); assert.equal(results[2]!.processed, false); assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: target.id } }), 1); assert.equal((await load(value, target.id)).status, JobStatus.DEAD_LETTER); } finally { await cleanup(value); }
});

test("maxAttempts boundary is exclusive below and inclusive at max", async () => {
  const value = await context(); const below = await job(value, JobStatus.FAILED, 2, 3); const at = await job(value, JobStatus.FAILED, 3, 3);
  try { assert.equal((await dlq.processDeadLetter(below.id, value.queue.id)).processed, false); assert.equal((await dlq.processDeadLetter(at.id, value.queue.id)).processed, true); assert.equal((await load(value, below.id)).status, JobStatus.FAILED); assert.equal((await load(value, at.id)).status, JobStatus.DEAD_LETTER); } finally { await cleanup(value); }
});

test("Step 7 and Step 8 are mutually exclusive at the attempt boundary", async () => {
  const value = await context(); const retryable = await job(value, JobStatus.FAILED, 2, 3); const exhausted = await job(value, JobStatus.FAILED, 3, 3);
  try { assert.equal((await dlq.processDeadLetter(retryable.id, value.queue.id)).processed, false); assert.equal((await retry.scheduleFailedJob(retryable.id, value.queue.id)).scheduled, true); assert.equal((await retry.scheduleFailedJob(exhausted.id, value.queue.id)).scheduled, false); assert.equal((await dlq.processDeadLetter(exhausted.id, value.queue.id)).processed, true); } finally { await cleanup(value); }
});

test("DLQ preserves attempt count", async () => {
  const value = await context(); const target = await job(value, JobStatus.FAILED, 3, 3); const before = target.attemptCount;
  try { await dlq.processDeadLetter(target.id); assert.equal((await load(value, target.id)).attemptCount, before); } finally { await cleanup(value); }
});

test("DLQ preserves tenancy and queue invariants", async () => {
  const value = await context(); const target = await job(value); const before = await prisma.queue.findUniqueOrThrow({ where: { id: target.queueId }, select: { id: true, project: { select: { organizationId: true } } } });
  try { await dlq.processDeadLetter(target.id, target.queueId); const after = await prisma.queue.findUniqueOrThrow({ where: { id: target.queueId }, select: { id: true, project: { select: { organizationId: true } } } }); const persisted = await load(value, target.id); assert.equal(persisted.queueId, before.id); assert.equal(after.project.organizationId, before.project.organizationId); } finally { await cleanup(value); }
});

test("DLQ never claims or executes a job", async () => {
  const value = await context(); const target = await job(value); const before = await load(value, target.id);
  try { await dlq.processDeadLetter(target.id, value.queue.id); const after = await load(value, target.id); assert.equal(after.claimedBy, before.claimedBy); assert.equal(after.claimedAt, before.claimedAt); assert.equal(after.attemptCount, before.attemptCount); assert.equal(after.executions.length, before.executions.length); } finally { await cleanup(value); }
});
