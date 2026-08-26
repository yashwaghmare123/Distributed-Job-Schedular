import test, { after } from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JobStatus, WorkerStatus } from "@prisma/client";
import { createApp } from "./index.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";
const app = createApp();
app.set("trust proxy", true);

type Account = { userId: string; organizationId: string; email: string; token: string; refreshToken: string };
type Fixture = Account & { other: Account; projectId: string; queueId: string; workerId: string };
let fixtureNumber = 0;

function uniqueTestIp(): string {
  const timestampPart = Date.now() % 65_536;
  const randomPart = Math.floor(Math.random() * 65_536);
  return `2001:db8:${timestampPart.toString(16)}:${randomPart.toString(16)}::1`;
}

async function register(name: string, email: string, password: string, testIp: string): Promise<Account> {
  const response = await request(app).post("/auth/register").set("X-Forwarded-For", testIp).send({ name, email, password });
  assert.equal(response.status, 201);
  const membership = await prisma.organizationMember.findFirstOrThrow({ where: { userId: response.body.user.id } });
  return {
    userId: response.body.user.id,
    organizationId: membership.organizationId,
    email,
    token: response.body.accessToken,
    refreshToken: response.body.refreshToken
  };
}

function auth(account: Account) {
  return { Authorization: `Bearer ${account.token}` };
}

async function createFixture(): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  fixtureNumber += 1;
  console.log("FIXTURE_START", suffix);
  const account = await register("Step 12 Owner", `step12-owner-${suffix}@example.test`, "Step12-password", uniqueTestIp());
  const other = await register("Other Tenant", `step12-other-${suffix}@example.test`, "Step12-password", uniqueTestIp());
  const projectResponse = await request(app).post("/projects").set(auth(account)).send({ name: `Step12 Project ${suffix}`, description: "API test fixture" });
  assert.equal(projectResponse.status, 201);
  console.log("FIXTURE_PROJECT", projectResponse.status, projectResponse.body);
  const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: "seed-fixed" } });
  const queueResponse = await request(app).post(`/projects/${projectResponse.body.id}/queues`).set(auth(account)).send({ name: `step12-queue-${suffix}`, concurrencyLimit: 10, retryPolicyId: policy.id });
  assert.equal(queueResponse.status, 201);
  console.log("FIXTURE_QUEUE", queueResponse.status, queueResponse.body);
  for (const jobType of ["scheduled-creation", "hourly-sync", "lifecycle", "idempotent", "batch-a", "batch-b"]) {
    const jobTypeResponse = await request(app).post(`/projects/${projectResponse.body.id}/job-types`).set(auth(account)).send({ jobType, description: "API test fixture job type" });
    assert.equal(jobTypeResponse.status, 201);
  }
  const worker = await prisma.worker.create({ data: { organizationId: account.organizationId, name: `step12-worker-${suffix}`, status: WorkerStatus.ONLINE, concurrency: 2, currentJobCount: 0 } });
  return { ...account, other, projectId: projectResponse.body.id, queueId: queueResponse.body.id, workerId: worker.id };
}

async function cleanupFixture(fixture: Fixture) {
  const organizationIds = [fixture.organizationId, fixture.other.organizationId];
  const projectIds = [fixture.projectId];
  const queueRows = await prisma.queue.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
  const queueIds = queueRows.map((queue) => queue.id);
  const jobRows = await prisma.job.findMany({ where: { queueId: { in: queueIds } }, select: { id: true } });
  const jobIds = jobRows.map((job) => job.id);
  const workerRows = await prisma.worker.findMany({ where: { organizationId: { in: organizationIds }, name: { startsWith: "step12-worker-" } }, select: { id: true } });
  const workerIds = workerRows.map((worker) => worker.id);

  await prisma.jobLog.deleteMany({ where: { execution: { jobId: { in: jobIds } } } });
  await prisma.jobExecution.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.deadLetterEntry.deleteMany({ where: { jobId: { in: jobIds } } });
  await prisma.job.deleteMany({ where: { id: { in: jobIds } } });
  await prisma.jobBatch.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.scheduledJob.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.queueDepthSnapshot.deleteMany({ where: { queueId: { in: queueIds } } });
  await prisma.projectJobType.deleteMany({ where: { projectId: { in: projectIds } } });
  await prisma.workerHeartbeat.deleteMany({ where: { workerId: { in: workerIds } } });
  await prisma.worker.deleteMany({ where: { id: { in: workerIds } } });
  await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
  await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: { in: organizationIds } } });
  await prisma.user.deleteMany({ where: { id: { in: [fixture.userId, fixture.other.userId] } } });
  await prisma.organization.deleteMany({ where: { id: { in: organizationIds } } });
}

test("retry policies are backfilled when none are configured", async () => {
  const account = await register("Retry Policy Owner", `retry-policy-${Date.now()}@example.test`, "Retry-password", uniqueTestIp());
  try {
    const projectRows = await prisma.project.findMany({ where: { organizationId: account.organizationId }, select: { id: true } });
    const projectIds = projectRows.map((project) => project.id);
    const queueRows = await prisma.queue.findMany({ where: { projectId: { in: projectIds } }, select: { id: true } });
    const queueIds = queueRows.map((queue) => queue.id);

    await prisma.jobLog.deleteMany({ where: { execution: { job: { queueId: { in: queueIds } } } } });
    await prisma.jobExecution.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
    await prisma.deadLetterEntry.deleteMany({ where: { job: { queueId: { in: queueIds } } } });
    await prisma.job.deleteMany({ where: { queueId: { in: queueIds } } });
    await prisma.jobBatch.deleteMany({ where: { queueId: { in: queueIds } } });
    await prisma.scheduledJob.deleteMany({ where: { queueId: { in: queueIds } } });
    await prisma.queueDepthSnapshot.deleteMany({ where: { queueId: { in: queueIds } } });
    await prisma.projectJobType.deleteMany({ where: { projectId: { in: projectIds } } });
    await prisma.workerHeartbeat.deleteMany({ where: { worker: { organizationId: account.organizationId } } });
    await prisma.worker.deleteMany({ where: { organizationId: account.organizationId } });
    await prisma.queue.deleteMany({ where: { id: { in: queueIds } } });
    await prisma.project.deleteMany({ where: { id: { in: projectIds } } });
    await prisma.retryPolicy.deleteMany({ where: { queues: { none: {} } } });

    const response = await request(app).get("/retry-policies").set(auth(account));
    assert.equal(response.status, 200);
    assert.ok(response.body.data.length >= 3);
    const names = response.body.data.map((policy: { name: string }) => policy.name).sort();
    assert.deepEqual(names, ["seed-exponential", "seed-fixed", "seed-linear"]);
  } finally {
    await prisma.organizationMember.deleteMany({ where: { userId: account.userId } });
    await prisma.user.deleteMany({ where: { id: account.userId } });
    await prisma.organization.deleteMany({ where: { id: account.organizationId } });
  }
});

test("future scheduledAt creates a SCHEDULED job instead of immediate QUEUED", async () => {
  const fixture = await createFixture();
  try {
    const scheduledAt = new Date(Date.now() + 60_000).toISOString();
    const response = await request(app).post(`/queues/${fixture.queueId}/jobs`).set(auth(fixture)).send({
      jobType: "scheduled-creation",
      payload: { scheduled: true },
      priority: 7,
      scheduledAt,
      maxAttempts: 3
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.status, JobStatus.SCHEDULED);
    assert.equal(new Date(response.body.scheduledAt).getTime(), new Date(scheduledAt).getTime());
  } finally {
    await cleanupFixture(fixture);
  }
});

test("recurring schedules create real definitions that advance with cron expressions", async () => {
  const fixture = await createFixture();
  try {
    const response = await request(app).post(`/queues/${fixture.queueId}/scheduled-jobs`).set(auth(fixture)).send({
      jobType: "hourly-sync",
      payload: { tenant: "acme" },
      cronExpression: "0 * * * *",
      nextRunAt: new Date(Date.now() + 60_000).toISOString(),
      enabled: true
    });

    assert.equal(response.status, 201);
    assert.equal(response.body.jobType, "hourly-sync");
    assert.equal(response.body.cronExpression, "0 * * * *");
    assert.ok(response.body.id);

    const definition = await prisma.scheduledJob.findUniqueOrThrow({ where: { id: response.body.id } });
    assert.equal(definition.jobType, "hourly-sync");
    assert.equal(definition.cronExpression, "0 * * * *");
  } finally {
    await cleanupFixture(fixture);
  }
});

test("Step 12 auth, ownership, validation, listing, and job lifecycle APIs", async () => {
  const fixture = await createFixture();
  try {
    assert.equal((await request(app).get("/health")).status, 200);
    assert.equal((await request(app).get("/projects")).status, 401);
    assert.equal((await request(app).post("/auth/register").send({ name: "Duplicate", email: fixture.email, password: "Step12-password" })).status, 409);
    assert.equal((await request(app).post("/auth/login").send({ email: "missing@example.test", password: "Step12-password" })).status, 401);

    const login = await request(app).post("/auth/login").send({ email: "unused", password: "bad-password" });
    assert.equal(login.status, 400);
    const refresh = await request(app).post("/auth/refresh").send({ refreshToken: fixture.refreshToken });
    assert.equal(refresh.status, 200);
    assert.equal((await request(app).post("/auth/refresh").send({ refreshToken: "invalid" })).status, 401);

    const projects = await request(app).get("/projects").set(auth(fixture));
    assert.equal(projects.status, 200);
    assert.ok(projects.body.data.some((project: { id: string }) => project.id === fixture.projectId));
    assert.equal((await request(app).get(`/projects/${fixture.projectId}/queues`).set(auth(fixture.other))).status, 403);
    const queues = await request(app).get(`/projects/${fixture.projectId}/queues`).set(auth(fixture));
    assert.equal(queues.status, 200);
    const update = await request(app).patch(`/queues/${fixture.queueId}`).set(auth(fixture)).send({ name: "step12-updated", concurrencyLimit: 5 });
    assert.equal(update.status, 200);
    assert.equal(update.body.name, "step12-updated");
    assert.equal((await request(app).patch(`/queues/${fixture.queueId}`).set(auth(fixture.other)).send({ name: "leak" })).status, 403);

    const invalidJob = await request(app).post(`/queues/${fixture.queueId}/jobs`).set(auth(fixture)).send({ payload: {} });
    assert.equal(invalidJob.status, 400);
    const created = await request(app).post(`/queues/${fixture.queueId}/jobs`).set(auth(fixture)).send({ jobType: "lifecycle", payload: { ok: true }, maxAttempts: 3 });
    assert.equal(created.status, 201);
    const jobId = created.body.id;
    assert.equal((await request(app).get(`/jobs/${jobId}`).set(auth(fixture))).status, 200);
    assert.equal((await request(app).get(`/jobs/${jobId}`).set(auth(fixture.other))).status, 403);
    assert.equal((await request(app).get(`/jobs/${jobId}/executions`).set(auth(fixture.other))).status, 403);
    const listed = await request(app).get("/jobs?page=1&limit=1").set(auth(fixture));
    assert.equal(listed.status, 200);
    assert.equal(listed.body.pagination.limit, 1);
    assert.equal((await request(app).get("/jobs?page=0").set(auth(fixture))).status, 400);
    assert.equal((await request(app).get("/jobs").set(auth(fixture.other))).status, 200);

    const cancelled = await request(app).post(`/jobs/${jobId}/cancel`).set(auth(fixture));
    assert.equal(cancelled.status, 200);
    assert.equal(cancelled.body.status, JobStatus.CANCELLED);
    assert.equal((await request(app).post(`/jobs/${jobId}/cancel`).set(auth(fixture.other))).status, 403);

    const retryJob = await prisma.job.create({ data: { queueId: fixture.queueId, jobType: "retry-api", payload: {}, status: JobStatus.FAILED, priority: 0, scheduledAt: new Date(), maxAttempts: 3, attemptCount: 1 } });
    const retry = await request(app).post(`/jobs/${retryJob.id}/retry`).set(auth(fixture));
    assert.equal(retry.status, 200);
    assert.equal(retry.body.scheduled, true);

    assert.equal((await request(app).get("/workers").set(auth(fixture))).status, 200);
    assert.equal((await request(app).get(`/workers/${fixture.workerId}/heartbeats`).set(auth(fixture))).status, 200);
    assert.equal((await request(app).get(`/workers/${fixture.workerId}/heartbeats`).set(auth(fixture.other))).status, 403);
    assert.equal((await request(app).get("/dlq").set(auth(fixture))).status, 200);
  } finally {
    await cleanupFixture(fixture);
  }
});

test("idempotency and batch concurrency use PostgreSQL uniqueness and transactions", async () => {
  const fixture = await createFixture();
  try {
    const key = `step12-idempotency-${Date.now()}`;
    const responses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post(`/queues/${fixture.queueId}/jobs`).set(auth(fixture)).set("Idempotency-Key", key).send({ jobType: "idempotent", payload: { key }, maxAttempts: 3 }))
    );
    const jobs = await prisma.job.findMany({ where: { queueId: fixture.queueId, idempotencyKey: key } });
    const successful = responses.filter((response) => response.status >= 200 && response.status < 300);
    const created = responses.filter((response) => response.status === 201);
    const replayed = responses.filter((response) => response.status === 200);
    assert.equal(responses.length, 10);
    assert.equal(successful.length, 10);
    assert.equal(responses.filter((response) => response.status === 500).length, 0);
    assert.equal(jobs.length, 1);
    assert.equal(created.length, 1);
    assert.equal(replayed.length, 9);
    assert.equal(new Set(successful.map((response) => response.body.id)).size, 1);
    assert.equal(jobs[0]!.attemptCount, 0);
    assert.equal(jobs[0]!.claimedBy, null);
    assert.equal(jobs[0]!.claimedAt, null);
    assert.equal(await prisma.jobExecution.count({ where: { jobId: jobs[0]!.id } }), 0);

    const batchResponses = await Promise.all(
      Array.from({ length: 10 }, () => request(app).post(`/queues/${fixture.queueId}/jobs/batch`).set(auth(fixture)).send({ jobs: [{ jobType: "batch-a", payload: {} }, { jobType: "batch-b", payload: {} }] }))
    );
    assert.ok(batchResponses.every((response) => response.status === 201));
    const batchIds = batchResponses.map((response) => response.body.id);
    assert.equal(await prisma.jobBatch.count({ where: { id: { in: batchIds } } }), 10);
    assert.equal(await prisma.job.count({ where: { batchId: { in: batchIds } } }), 20);
    const batches = await prisma.jobBatch.findMany({ where: { id: { in: batchIds } } });
    assert.ok(batches.every((batch) => batch.totalJobs === 2 && batch.pendingJobs === 2 && batch.completedJobs === 0 && batch.failedJobs === 0));
  } finally {
    await cleanupFixture(fixture);
  }
});

test("worker and DLQ resource authorization is tenant-isolated", async () => {
  const fixture = await createFixture();
  try {
    const deadJob = await prisma.job.create({ data: { queueId: fixture.queueId, jobType: "dlq-api", payload: {}, status: JobStatus.DEAD_LETTER, priority: 0, scheduledAt: new Date(), maxAttempts: 1, attemptCount: 1 } });
    const entry = await prisma.deadLetterEntry.create({ data: { jobId: deadJob.id, reason: "test", attemptCount: 1, failedAt: new Date() } });
    const foreignHeartbeat = await request(app).get(`/workers/${fixture.workerId}/heartbeats`).set(auth(fixture.other));
    const foreignRequeue = await request(app).post(`/dlq/${entry.id}/requeue`).set(auth(fixture.other));
    console.log("STEP12_FOREIGN", foreignHeartbeat.status, foreignHeartbeat.body, foreignRequeue.status, foreignRequeue.body);
    assert.equal(foreignHeartbeat.status, 403);
    assert.equal(foreignRequeue.status, 403);
    const requeued = await request(app).post(`/dlq/${entry.id}/requeue`).set(auth(fixture));
    console.log("STEP12_OWNER", requeued.status, requeued.body);
    assert.equal(requeued.status, 200);
    assert.equal(requeued.body.job.status, JobStatus.QUEUED);
  } finally {
    await cleanupFixture(fixture);
  }
});

