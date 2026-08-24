import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { ExecutionStatus, JobStatus, WorkerStatus } from "@prisma/client";
import { createApp } from "./index.js";
import { prisma } from "../lib/prisma.js";

const app = createApp();

type Fixture = { userId: string; organizationId: string; projectId: string; queueId: string; workerId: string; token: string };

async function fixture(label: string): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const registered = await request(app).post("/auth/register").send({ name: `step16-gapfill-${label}`, email: `step16-gapfill-${label}-${suffix}@example.test`, password: "Step16-gapfill-password" });
  assert.equal(registered.status, 201);
  const member = await prisma.organizationMember.findFirstOrThrow({ where: { userId: registered.body.user.id } });
  const auth = { Authorization: `Bearer ${registered.body.accessToken}` };
  const project = await request(app).post("/projects").set(auth).send({ name: `step16-gapfill-project-${suffix}` });
  const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: "seed-fixed" } });
  const queue = await request(app).post(`/projects/${project.body.id}/queues`).set(auth).send({ name: `step16-gapfill-queue-${suffix}`, concurrencyLimit: 2, retryPolicyId: policy.id });
  const worker = await prisma.worker.create({ data: { organizationId: member.organizationId, name: `step16-gapfill-worker-${suffix}`, status: WorkerStatus.ONLINE, concurrency: 1, currentJobCount: 0 } });
  return { userId: registered.body.user.id, organizationId: member.organizationId, projectId: project.body.id, queueId: queue.body.id, workerId: worker.id, token: registered.body.accessToken };
}

async function cleanup(value: Fixture) {
  const jobs = await prisma.job.findMany({ where: { queueId: value.queueId }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  await prisma.jobLog.deleteMany({ where: { execution: { jobId: { in: jobIds } } } });
  await prisma.jobExecution.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.deadLetterEntry.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.scheduledJob.deleteMany({ where: { queueId: value.queueId } });
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: value.workerId } });
  await prisma.worker.delete({ where: { id: value.workerId } });
  await prisma.queue.delete({ where: { id: value.queueId } });
  await prisma.project.delete({ where: { id: value.projectId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: value.organizationId } });
  await prisma.user.delete({ where: { id: value.userId } });
  await prisma.organization.delete({ where: { id: value.organizationId } });
}

test("scheduled jobs and executions list endpoints are tenant-scoped", async () => {
  const a = await fixture("a"); const b = await fixture("b");
  try {
    const scheduledA = await prisma.scheduledJob.create({ data: { queueId: a.queueId, jobType: "step16-gapfill-scheduled", payload: {}, cronExpression: "0 * * * *", nextRunAt: new Date("2099-01-01T00:00:00Z") } });
    const jobA = await prisma.job.create({ data: { queueId: a.queueId, jobType: "step16-gapfill-execution", payload: {}, status: JobStatus.RUNNING, maxAttempts: 2, attemptCount: 1 } });
    await prisma.jobExecution.create({ data: { jobId: jobA.id, workerId: a.workerId, attemptNumber: 1, status: ExecutionStatus.RUNNING, startedAt: new Date() } });
    const ownScheduled = await request(app).get("/scheduled-jobs?limit=10").set({ Authorization: `Bearer ${a.token}` });
    assert.equal(ownScheduled.status, 200); assert.equal(ownScheduled.body.data.some((item: { id: string }) => item.id === scheduledA.id), true);
    const ownExecutions = await request(app).get("/executions?limit=10").set({ Authorization: `Bearer ${a.token}` });
    assert.equal(ownExecutions.status, 200); assert.equal(ownExecutions.body.data.some((item: { job: { id: string } }) => item.job.id === jobA.id), true);
    const otherScheduled = await request(app).get("/scheduled-jobs?limit=10").set({ Authorization: `Bearer ${b.token}` });
    const otherExecutions = await request(app).get("/executions?limit=10").set({ Authorization: `Bearer ${b.token}` });
    assert.equal(otherScheduled.status, 200); assert.equal(otherExecutions.status, 200);
    assert.equal(otherScheduled.body.data.some((item: { id: string }) => item.id === scheduledA.id), false);
    assert.equal(otherExecutions.body.data.some((item: { job: { id: string } }) => item.job.id === jobA.id), false);
    assert.equal((await request(app).get("/scheduled-jobs?page=0").set({ Authorization: `Bearer ${a.token}` })).status, 400);
    assert.equal((await request(app).get("/executions?status=RUNNING&limit=10").set({ Authorization: `Bearer ${a.token}` })).body.data.length, 1);
  } finally { await cleanup(b); await cleanup(a); }
});
