import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JobStatus, WorkerStatus } from "@prisma/client";
import { createApp } from "./api/index.js";
import { prisma } from "./lib/prisma.js";
import { pingRedis, redis } from "./lib/redis.js";
import { Dispatcher } from "./core/dispatcher.js";

const app = createApp();
type Account = { userId: string; organizationId: string; token: string; apiKey: string; projectId: string; queueId: string };

async function fixture(): Promise<Account> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `gapfill-${suffix}@example.test`;
  const registered = await request(app).post("/auth/register").send({ name: "Gap Fill", email, password: "Gapfill-password" });
  assert.equal(registered.status, 201);
  const membership = await prisma.organizationMember.findFirstOrThrow({ where: { userId: registered.body.user.id } });
  const auth = { Authorization: `Bearer ${registered.body.accessToken}` };
  const project = await request(app).post("/projects").set(auth).send({ name: `gapfill-project-${suffix}` });
  const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: "seed-fixed" } });
  const queue = await request(app).post(`/projects/${project.body.id}/queues`).set(auth).send({ name: `gapfill-queue-${suffix}`, concurrencyLimit: 2, retryPolicyId: policy.id });
  const key = await request(app).post("/auth/api-keys").set(auth).send({ name: `gapfill-key-${suffix}` });
  assert.equal(key.status, 201);
  return { userId: registered.body.user.id, organizationId: membership.organizationId, token: registered.body.accessToken, apiKey: key.body.apiKey, projectId: project.body.id, queueId: queue.body.id };
}

async function cleanup(value: Account) {
  const queues = await prisma.queue.findMany({ where: { projectId: value.projectId }, select: { id: true } });
  const queueIds = queues.map((queue) => queue.id);
  const jobs = await prisma.job.findMany({ where: { queueId: { in: queueIds } }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  const workers = await prisma.worker.findMany({ where: { organizationId: value.organizationId }, select: { id: true } });
  const workerIds = workers.map((worker) => worker.id);
  await prisma.jobLog.deleteMany({ where: { execution: { jobId: { in: jobIds } } } });
  await prisma.jobExecution.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.deadLetterEntry.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.jobBatch.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.scheduledJob.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: { in: workerIds } } });
  await prisma.worker.deleteMany({ where: { id: { in: workerIds } } });
  await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.project.delete({ where: { id: value.projectId } });
  await prisma.apiKey.deleteMany({ where: { organizationId: value.organizationId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: value.organizationId } });
  await prisma.user.delete({ where: { id: value.userId } });
  await prisma.organization.delete({ where: { id: value.organizationId } });
}

test("API keys authenticate without persisting plaintext and preserve tenant isolation", async () => {
  const value = await fixture();
  const other = await fixture();
  try {
    const own = await request(app).get("/projects").set("X-API-Key", value.apiKey);
    assert.equal(own.status, 200);
    const cross = await request(app).get(`/projects/${other.projectId}/queues`).set("X-API-Key", value.apiKey);
    assert.equal(cross.status, 403);
    assert.equal((await request(app).get("/projects").set("X-API-Key", "invalid-key")).status, 401);
    assert.equal((await request(app).get("/projects")).status, 401);
    const stored = await prisma.apiKey.findFirstOrThrow({ where: { organizationId: value.organizationId, name: { startsWith: "gapfill-key-" } } });
    assert.notEqual(stored.keyHash, value.apiKey);
    assert.equal((await request(app).get("/projects").set("Authorization", `ApiKey ${value.apiKey}`)).status, 200);
    await prisma.apiKey.updateMany({ where: { organizationId: value.organizationId }, data: { revokedAt: new Date() } });
    assert.equal((await request(app).get("/projects").set("X-API-Key", value.apiKey)).status, 401);
  } finally {
    await cleanup(other);
    await cleanup(value);
  }
});

test("Redis is reachable as coordination infrastructure and does not hold Job state", async () => {
  assert.equal(await pingRedis(), "PONG");
  assert.equal(await redis.get("gapfill-job-state"), null);
});

test("Redis-unavailable connections fail without changing PostgreSQL state", async () => {
  const unavailable = (await import("redis")).createClient({ url: "redis://127.0.0.1:6399", socket: { reconnectStrategy: false } });
  await assert.rejects(() => unavailable.connect());
  await unavailable.disconnect();
  assert.equal(await prisma.job.count({ where: { jobType: "gapfill-redis-probe" } }), 0);
});

test("dispatcher delegates claiming and execution to the frozen runtime", async () => {
  const value = await fixture();
  let dispatchedId: string | null = null;
  try {
    const worker = await prisma.worker.create({ data: { organizationId: value.organizationId, name: `gapfill-worker-${Date.now()}`, status: WorkerStatus.ONLINE, concurrency: 1, currentJobCount: 0 } });
    const job = await prisma.job.create({ data: { queueId: value.queueId, jobType: "gapfill-dispatch", payload: {}, status: JobStatus.QUEUED, priority: 1, scheduledAt: new Date(Date.now() - 1_000), maxAttempts: 2, attemptCount: 0 } });
    const future = await prisma.job.create({ data: { queueId: value.queueId, jobType: "gapfill-future", payload: {}, status: JobStatus.SCHEDULED, priority: 1, scheduledAt: new Date("2099-01-01T00:00:00.000Z"), maxAttempts: 2, attemptCount: 0 } });
    const dispatcher = new Dispatcher({ workerId: worker.id, queueId: value.queueId, handler: async (candidate) => { dispatchedId = candidate.id; } });
    const result = await dispatcher.dispatchOnce();
    assert.equal(result?.id, job.id);
    assert.equal(dispatchedId, job.id);
    const persisted = await prisma.job.findUniqueOrThrow({ where: { id: job.id }, include: { executions: true } });
    assert.equal(persisted.status, JobStatus.COMPLETED);
    assert.equal(persisted.attemptCount, 1);
    assert.equal(persisted.executions.length, 1);
    assert.equal((await prisma.job.findUniqueOrThrow({ where: { id: future.id } })).status, JobStatus.SCHEDULED);
    assert.equal(await dispatcher.dispatchOnce(), null);
  } finally {
    await cleanup(value);
  }
});

