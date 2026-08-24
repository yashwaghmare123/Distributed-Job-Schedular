import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JobStatus, WorkerStatus } from "@prisma/client";
import { createApp } from "./index.js";
import { prisma } from "../lib/prisma.js";

const app = createApp();

type Account = { userId: string; organizationId: string; token: string; projectId: string; queueId: string };

async function createAccount(label: string): Promise<Account> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const response = await request(app).post("/auth/register").send({
    name: `step13-heartbeat-${label}`,
    email: `step13-heartbeat-${label}-${suffix}@example.test`,
    password: "Step13-heartbeat-password"
  });
  assert.equal(response.status, 201);
  const member = await prisma.organizationMember.findFirstOrThrow({ where: { userId: response.body.user.id } });
  const auth = { Authorization: `Bearer ${response.body.accessToken}` };
  const project = await request(app).post("/projects").set(auth).send({ name: `step13-heartbeat-project-${suffix}` });
  assert.equal(project.status, 201);
  const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: "seed-fixed" } });
  const queue = await request(app).post(`/projects/${project.body.id}/queues`).set(auth).send({ name: `step13-heartbeat-queue-${suffix}`, concurrencyLimit: 2, retryPolicyId: policy.id });
  assert.equal(queue.status, 201);
  return { userId: response.body.user.id, organizationId: member.organizationId, token: response.body.accessToken, projectId: project.body.id, queueId: queue.body.id };
}

async function cleanupAccount(account: Account) {
  const workers = await prisma.worker.findMany({ where: { organizationId: account.organizationId }, select: { id: true } });
  const workerIds = workers.map((worker) => worker.id);
  const projects = await prisma.project.findMany({ where: { organizationId: account.organizationId }, select: { id: true } });
  const queues = await prisma.queue.findMany({ where: { projectId: { in: projects.map((project) => project.id) } }, select: { id: true } });
  const jobs = await prisma.job.findMany({ where: { queueId: { in: queues.map((queue) => queue.id) } }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  await prisma.jobLog.deleteMany({ where: { execution: { jobId: { in: jobIds } } } });
  await prisma.jobExecution.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.deadLetterEntry.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: { in: workerIds } } });
  await prisma.worker.deleteMany({ where: { id: { in: workerIds } } });
  await prisma.queue.deleteMany({ where: { id: { in: queues.map((queue) => queue.id) } } });
  await prisma.project.deleteMany({ where: { id: { in: projects.map((project) => project.id) } } });
  await prisma.apiKey.deleteMany({ where: { organizationId: account.organizationId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: account.organizationId } });
  await prisma.user.delete({ where: { id: account.userId } });
  await prisma.organization.delete({ where: { id: account.organizationId } });
}

test("worker heartbeat API is authenticated, tenant-isolated, concurrent, and side-effect free", async () => {
  const account = await createAccount("owner");
  const other = await createAccount("other");
  const worker = await prisma.worker.create({
    data: {
      organizationId: account.organizationId,
      name: `step13-heartbeat-worker-${Date.now()}`,
      status: WorkerStatus.ONLINE,
      concurrency: 2,
      currentJobCount: 0,
      lastHeartbeatAt: new Date()
    }
  });
  try {
    const auth = { Authorization: `Bearer ${account.token}` };
    const unauthenticated = await request(app).post(`/workers/${worker.id}/heartbeat`).send({ currentJobCount: 1 });
    assert.equal(unauthenticated.status, 401);
    const invalid = await request(app).post(`/workers/${worker.id}/heartbeat`).set(auth).send({ currentJobCount: -1 });
    assert.equal(invalid.status, 400);
    const forbidden = await request(app).post(`/workers/${worker.id}/heartbeat`).set({ Authorization: `Bearer ${other.token}` }).send({ currentJobCount: 1 });
    assert.equal(forbidden.status, 403);

    const beforeWorker = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const beforeHeartbeats = await prisma.workerHeartbeat.count({ where: { workerId: worker.id } });
    const job = await prisma.job.create({
      data: {
        queueId: account.queueId,
        jobType: `step13-heartbeat-job-${Date.now()}`,
        payload: { heartbeat: true },
        status: JobStatus.QUEUED,
        priority: 1,
        maxAttempts: 3,
        attemptCount: 0
      }
    });
    const beforeQueue = await prisma.queue.findUniqueOrThrow({ where: { id: job.queueId } });

    const success = await request(app).post(`/workers/${worker.id}/heartbeat`).set(auth).send({ currentJobCount: 3 });
    assert.equal(success.status, 200);
    assert.equal(success.body.worker.id, worker.id);
    assert.equal(success.body.worker.status, WorkerStatus.ONLINE);
    assert.equal(success.body.worker.currentJobCount, 3);
    assert.equal(success.body.heartbeat.workerId, worker.id);
    assert.equal(success.body.heartbeat.currentJobCount, 3);

    const responses = await Promise.all(
      Array.from({ length: 10 }, (_, index) => request(app).post(`/workers/${worker.id}/heartbeat`).set(auth).send({ currentJobCount: index }))
    );
    assert.equal(responses.length, 10);
    assert.ok(responses.every((response) => response.status === 200));
    const heartbeatRows = await prisma.workerHeartbeat.findMany({ where: { workerId: worker.id }, orderBy: { recordedAt: "asc" } });
    assert.equal(heartbeatRows.length, beforeHeartbeats + 11);
    assert.ok(heartbeatRows.every((heartbeat) => heartbeat.status === WorkerStatus.ONLINE));
    assert.deepEqual(new Set(heartbeatRows.slice(-10).map((heartbeat) => heartbeat.currentJobCount)), new Set(Array.from({ length: 10 }, (_, index) => index)));

    const afterWorker = await prisma.worker.findUniqueOrThrow({ where: { id: worker.id } });
    const afterJob = await prisma.job.findUniqueOrThrow({ where: { id: job.id } });
    const afterQueue = await prisma.queue.findUniqueOrThrow({ where: { id: job.queueId } });
    assert.equal(afterWorker.status, WorkerStatus.ONLINE);
    assert.ok(afterWorker.currentJobCount >= 0 && afterWorker.currentJobCount < 10);
    assert.notEqual(afterWorker.lastHeartbeatAt?.getTime(), beforeWorker.lastHeartbeatAt?.getTime());
    assert.ok(heartbeatRows.some((heartbeat) => heartbeat.currentJobCount === afterWorker.currentJobCount));
    assert.equal(afterJob.status, JobStatus.QUEUED);
    assert.equal(afterJob.attemptCount, 0);
    assert.equal(afterJob.claimedBy, null);
    assert.equal(await prisma.jobExecution.count({ where: { jobId: job.id } }), 0);
    assert.equal(await prisma.jobLog.count({ where: { execution: { jobId: job.id } } }), 0);
    assert.equal(await prisma.deadLetterEntry.count({ where: { jobId: job.id } }), 0);
    assert.deepEqual(afterQueue, beforeQueue);

    await prisma.worker.update({ where: { id: worker.id }, data: { status: WorkerStatus.STOPPED } });
    assert.equal((await request(app).post(`/workers/${worker.id}/heartbeat`).set(auth).send({ currentJobCount: 1 })).status, 409);
    await prisma.worker.update({ where: { id: worker.id }, data: { status: WorkerStatus.DRAINING } });
    assert.equal((await request(app).post(`/workers/${worker.id}/heartbeat`).set(auth).send({ currentJobCount: 1 })).status, 409);
  } finally {
    await cleanupAccount(other);
    await cleanupAccount(account);
  }
});
