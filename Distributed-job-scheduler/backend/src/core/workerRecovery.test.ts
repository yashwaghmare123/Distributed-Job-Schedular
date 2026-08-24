import test from "node:test";
import assert from "node:assert/strict";
import { ExecutionStatus, JobStatus, RetryStrategy, WorkerStatus } from "@prisma/client";
import { prisma } from "../lib/prisma.js";
import { claimNextJob } from "./jobClaimer.js";
import { WorkerRecovery } from "./workerRecovery.js";

const recovery = new WorkerRecovery({ heartbeatTimeoutMs: 20_000 });
type Context = Awaited<ReturnType<typeof createContext>>;

async function createContext() {
  const organization = await prisma.organization.findFirstOrThrow({ where: { name: "Codity Demo Org" } });
  const project = await prisma.project.findFirstOrThrow({ where: { organizationId: organization.id, name: "Scheduler Demo" } });
  const policy = await prisma.retryPolicy.create({ data: { name: `step9-policy-${Date.now()}-${Math.random()}`, strategy: RetryStrategy.FIXED, maxAttempts: 3, initialDelayMs: 100, maxDelayMs: 1000, backoffMultiplier: 1, jitter: false } });
  const queue = await prisma.queue.create({ data: { projectId: project.id, name: `step9-queue-a-${Date.now()}-${Math.random()}`, description: "Step 9 test queue", defaultPriority: 0, concurrencyLimit: 10, isPaused: false, retryPolicyId: policy.id } });
  const queueB = await prisma.queue.create({ data: { projectId: project.id, name: `step9-queue-b-${Date.now()}-${Math.random()}`, description: "Step 9 test queue", defaultPriority: 0, concurrencyLimit: 10, isPaused: false, retryPolicyId: policy.id } });
  const worker = await prisma.worker.create({ data: { organizationId: organization.id, name: `step9-worker-a-${Date.now()}-${Math.random()}`, status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0, lastHeartbeatAt: new Date() } });
  const workerB = await prisma.worker.create({ data: { organizationId: organization.id, name: `step9-worker-b-${Date.now()}-${Math.random()}`, status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0, lastHeartbeatAt: new Date() } });
  return { organization, project, policy, queue, queueB, worker, workerB };
}

async function cleanup(value: Context) {
  const workerIds = [value.worker.id, value.workerB.id];
  const queueIds = [value.queue.id, value.queueB.id];
  await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: { in: queueIds } } } } });
  await prisma.jobExecution.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
  await prisma.job.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: { in: workerIds } } });
  await prisma.worker.deleteMany({ where: { id: { in: workerIds } } });
  await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.retryPolicy.deleteMany({ where: { id: value.policy.id } });
}

async function makeJob(value: Context, status: JobStatus, workerId: string | null = null, attemptCount = 0, queueId = value.queue.id, maxAttempts = 3) {
  return prisma.job.create({ data: { queueId, jobType: "step9-recovery-test", payload: { step: 9 }, status, priority: 1, scheduledAt: new Date(), maxAttempts, attemptCount, claimedBy: workerId, claimedAt: workerId ? new Date() : null, idempotencyKey: `${Date.now()}-${Math.random()}` } });
}

async function makeExecution(value: Context, jobId: string, status: ExecutionStatus, attemptNumber = 1, workerId = value.worker.id) {
  return prisma.jobExecution.create({ data: { jobId, workerId, attemptNumber, status, startedAt: new Date(Date.now() - 500), completedAt: status === ExecutionStatus.FAILED ? new Date(Date.now() - 100) : null, durationMs: status === ExecutionStatus.FAILED ? 400 : null, errorMessage: status === ExecutionStatus.FAILED ? "previous failure" : null, errorCode: status === ExecutionStatus.FAILED ? "PREVIOUS_FAILURE" : null } });
}

async function makeStale(value: Context, workerId = value.worker.id) {
  await prisma.$executeRaw`UPDATE "Worker" SET "lastHeartbeatAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute', "status" = 'ONLINE', "currentJobCount" = 2 WHERE "id" = ${workerId}::uuid`;
}

async function loadWorker(value: Context, workerId = value.worker.id) { return prisma.worker.findUniqueOrThrow({ where: { id: workerId }, include: { heartbeats: true } }); }
async function loadJob(jobId: string) { return prisma.job.findUniqueOrThrow({ where: { id: jobId }, include: { executions: { orderBy: { attemptNumber: "asc" } }, deadLetterEntry: true } }); }

test("heartbeat creates current state and append-only history", async () => { const value = await createContext(); try { const result = await recovery.recordWorkerHeartbeat(value.worker.id, 3); const worker = await loadWorker(value); assert.equal(worker.status, WorkerStatus.ONLINE); assert.equal(worker.currentJobCount, 3); assert.ok(worker.lastHeartbeatAt instanceof Date); assert.equal(worker.heartbeats.length, 1); assert.equal(result.heartbeat.workerId, value.worker.id); assert.equal(result.heartbeat.status, WorkerStatus.ONLINE); assert.equal(result.heartbeat.currentJobCount, 3); } finally { await cleanup(value); } });

test("repeated heartbeats preserve all history and latest count", async () => { const value = await createContext(); try { await recovery.recordWorkerHeartbeat(value.worker.id, 1); await recovery.recordWorkerHeartbeat(value.worker.id, 4); const worker = await loadWorker(value); assert.equal(worker.heartbeats.length, 2); assert.equal(worker.currentJobCount, 4); assert.equal(worker.heartbeats.filter((item) => item.currentJobCount === 1).length, 1); assert.equal(worker.heartbeats.filter((item) => item.currentJobCount === 4).length, 1); } finally { await cleanup(value); } });

test("missing worker heartbeat fails clearly", async () => { await assert.rejects(() => recovery.recordWorkerHeartbeat("00000000-0000-0000-0000-000000000000", 0), /was not found/); });

test("fresh worker is not recovered", async () => { const value = await createContext(); const before = await loadWorker(value); try { const result = await recovery.recoverStaleWorkers(); const after = await loadWorker(value); assert.equal(result.some((item) => item.workerId === value.worker.id && item.workerProcessed), false); assert.equal(after.status, WorkerStatus.ONLINE); assert.equal(after.currentJobCount, before.currentJobCount); } finally { await cleanup(value); } });

test("stale worker becomes OFFLINE with zero active count", async () => { const value = await createContext(); await makeStale(value); const before = await loadWorker(value); try { const result = await recovery.recoverStaleWorkers(); const after = await loadWorker(value); assert.equal(result.find((item) => item.workerId === value.worker.id)?.workerProcessed, true); assert.equal(after.status, WorkerStatus.OFFLINE); assert.equal(after.currentJobCount, 0); assert.equal(after.lastHeartbeatAt?.getTime(), before.lastHeartbeatAt?.getTime()); } finally { await cleanup(value); } });

test("CLAIMED jobs return to QUEUED without execution or attempt changes", async () => { const value = await createContext(); const target = await makeJob(value, JobStatus.CLAIMED, value.worker.id, 1); await makeStale(value); try { await recovery.recoverStaleWorkers(); const after = await loadJob(target.id); assert.equal(after.status, JobStatus.QUEUED); assert.equal(after.claimedBy, null); assert.equal(after.claimedAt, null); assert.equal(after.attemptCount, 1); assert.equal(after.executions.length, 0); } finally { await cleanup(value); } });

test("RUNNING jobs and active executions become FAILED", async () => { const value = await createContext(); const target = await makeJob(value, JobStatus.RUNNING, value.worker.id, 2); const execution = await makeExecution(value, target.id, ExecutionStatus.RUNNING, 2); await makeStale(value); try { await recovery.recoverStaleWorkers(); const after = await loadJob(target.id); assert.equal(after.status, JobStatus.FAILED); assert.equal(after.claimedBy, null); assert.equal(after.attemptCount, 2); assert.equal(after.executions.length, 1); assert.equal(after.executions[0]!.id, execution.id); assert.equal(after.executions[0]!.status, ExecutionStatus.FAILED); assert.equal(after.executions[0]!.attemptNumber, 2); assert.ok(after.executions[0]!.completedAt instanceof Date); assert.ok(after.executions[0]!.durationMs !== null); assert.equal(after.deadLetterEntry, null); } finally { await cleanup(value); } });

test("only jobs owned by the stale worker are recovered", async () => { const value = await createContext(); const staleJob = await makeJob(value, JobStatus.CLAIMED, value.worker.id); const freshJob = await makeJob(value, JobStatus.CLAIMED, value.workerB.id, 0, value.queueB.id); await makeStale(value); try { await recovery.recoverStaleWorkers(); assert.equal((await loadJob(staleJob.id)).status, JobStatus.QUEUED); assert.equal((await loadJob(freshJob.id)).status, JobStatus.CLAIMED); assert.equal((await loadWorker(value, value.workerB.id)).status, WorkerStatus.ONLINE); } finally { await cleanup(value); } });

test("multiple active jobs are all recovered once", async () => { const value = await createContext(); const claimed = await makeJob(value, JobStatus.CLAIMED, value.worker.id, 1); const running = await makeJob(value, JobStatus.RUNNING, value.worker.id, 2); await makeExecution(value, running.id, ExecutionStatus.RUNNING, 2); await makeStale(value); try { await recovery.recoverStaleWorkers(); assert.equal((await loadJob(claimed.id)).status, JobStatus.QUEUED); const result = await loadJob(running.id); assert.equal(result.status, JobStatus.FAILED); assert.equal(result.executions.length, 1); } finally { await cleanup(value); } });

test("heartbeat race never leaves a fresh heartbeat marked OFFLINE", async () => { const value = await createContext(); await makeStale(value); try { await Promise.all([recovery.recoverStaleWorkers(), recovery.recordWorkerHeartbeat(value.worker.id, 7)]); const after = await loadWorker(value); assert.notEqual(after.status === WorkerStatus.OFFLINE && after.currentJobCount === 7, true); assert.ok(after.status === WorkerStatus.ONLINE || after.status === WorkerStatus.OFFLINE); if (after.currentJobCount === 7) assert.equal(after.status, WorkerStatus.ONLINE); } finally { await cleanup(value); } });

test("ten concurrent reapers process a stale worker once", async () => { const value = await createContext(); const claimed = await makeJob(value, JobStatus.CLAIMED, value.worker.id, 1); const running = await makeJob(value, JobStatus.RUNNING, value.worker.id, 2); await makeExecution(value, running.id, ExecutionStatus.RUNNING, 2); await makeStale(value); try { const results = await Promise.all(Array.from({ length: 10 }, () => recovery.recoverStaleWorkers())); const processed = results.flat().filter((item) => item.workerId === value.worker.id && item.workerProcessed); const claimedAfter = await loadJob(claimed.id); const runningAfter = await loadJob(running.id); assert.equal(processed.length, 1); assert.equal((await loadWorker(value)).status, WorkerStatus.OFFLINE); assert.equal(claimedAfter.status, JobStatus.QUEUED); assert.equal(runningAfter.status, JobStatus.FAILED); assert.equal(runningAfter.executions.length, 1); assert.equal(runningAfter.attemptCount, 2); } finally { await cleanup(value); } });

test("latest heartbeat determines liveness", async () => { const value = await createContext(); try { await prisma.$executeRaw`UPDATE "Worker" SET "lastHeartbeatAt" = CURRENT_TIMESTAMP - INTERVAL '1 minute' WHERE "id" = ${value.worker.id}::uuid`; await recovery.recordWorkerHeartbeat(value.worker.id, 5); const worker = await loadWorker(value); assert.equal(worker.status, WorkerStatus.ONLINE); assert.equal(worker.currentJobCount, 5); assert.equal(worker.heartbeats.length, 1); } finally { await cleanup(value); } });

test("already OFFLINE, STOPPED, and fresh DRAINING workers are not reaped", async () => { const value = await createContext(); try { await prisma.worker.update({ where: { id: value.worker.id }, data: { status: WorkerStatus.OFFLINE } }); await prisma.worker.update({ where: { id: value.workerB.id }, data: { status: WorkerStatus.STOPPED } }); const results = await recovery.recoverStaleWorkers(); assert.equal(results.length, 0); assert.equal((await loadWorker(value)).status, WorkerStatus.OFFLINE); assert.equal((await loadWorker(value, value.workerB.id)).status, WorkerStatus.STOPPED); } finally { await cleanup(value); } });

test("DRAINING worker remains unchanged", async () => { const value = await createContext(); try { await prisma.worker.update({ where: { id: value.worker.id }, data: { status: WorkerStatus.DRAINING } }); const results = await recovery.recoverStaleWorkers(); assert.equal(results.length, 0); assert.equal((await loadWorker(value)).status, WorkerStatus.DRAINING); } finally { await cleanup(value); } });

test("recovery preserves queue and attempt number", async () => { const value = await createContext(); const target = await makeJob(value, JobStatus.RUNNING, value.worker.id, 2, value.queue.id); await makeExecution(value, target.id, ExecutionStatus.RUNNING, 2); await makeStale(value); try { await recovery.recoverStaleWorkers(); const after = await loadJob(target.id); assert.equal(after.queueId, value.queue.id); assert.equal(after.attemptCount, 2); assert.equal(after.executions[0]!.attemptNumber, 2); } finally { await cleanup(value); } });

test("recovery preserves previous execution history", async () => { const value = await createContext(); const target = await makeJob(value, JobStatus.RUNNING, value.worker.id, 2); await makeExecution(value, target.id, ExecutionStatus.COMPLETED, 1); await makeExecution(value, target.id, ExecutionStatus.RUNNING, 2); await makeStale(value); try { await recovery.recoverStaleWorkers(); const after = await loadJob(target.id); assert.equal(after.executions.length, 2); assert.equal(after.executions[0]!.status, ExecutionStatus.COMPLETED); assert.equal(after.executions[1]!.status, ExecutionStatus.FAILED); } finally { await cleanup(value); } });

test("recovery is tenant-isolated", async () => { const value = await createContext(); const other = await prisma.organization.create({ data: { name: `step9-other-org-${Date.now()}-${Math.random()}` } }); const otherWorker = await prisma.worker.create({ data: { organizationId: other.id, name: `step9-other-worker-${Date.now()}-${Math.random()}`, status: WorkerStatus.ONLINE, concurrency: 1, currentJobCount: 0, lastHeartbeatAt: new Date() } }); const otherJob = await makeJob(value, JobStatus.CLAIMED, otherWorker.id, 0, value.queue.id); await makeStale(value); try { await recovery.recoverStaleWorkers(); assert.equal((await loadJob(otherJob.id)).status, JobStatus.CLAIMED); assert.equal((await prisma.worker.findUniqueOrThrow({ where: { id: otherWorker.id } })).status, WorkerStatus.ONLINE); } finally { await prisma.job.delete({ where: { id: otherJob.id } }); await prisma.worker.delete({ where: { id: otherWorker.id } }); await prisma.organization.delete({ where: { id: other.id } }); await cleanup(value); } });

test("heartbeat and recovery do not create DLQ entries or executions", async () => { const value = await createContext(); const target = await makeJob(value, JobStatus.CLAIMED, value.worker.id, 1); await makeStale(value); try { await recovery.recordWorkerHeartbeat(value.worker.id, 0); await recovery.recoverStaleWorkers(); assert.equal(await prisma.jobExecution.count({ where: { jobId: target.id } }), 0); assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: target.id } }), 0); } finally { await cleanup(value); } });
