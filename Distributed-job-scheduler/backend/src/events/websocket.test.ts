import test from "node:test";
import assert from "node:assert/strict";
import { createServer, type Server } from "node:http";
import WebSocket from "ws";
import request from "supertest";
import { JobStatus, RetryStrategy, WorkerStatus } from "@prisma/client";
import { createApp } from "../api/index.js";
import { prisma } from "../lib/prisma.js";
import { startRuntimeBootstrap } from "../server.js";
import { eventBus } from "./eventBus.js";
import { WebSocketHub } from "./websocketHub.js";

const app = createApp();

type Fixture = { userId: string; organizationId: string; token: string; projectId: string; queueId: string };

async function createFixture(label: string): Promise<Fixture> {
  const suffix = `${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const email = `step15-websocket-${label}-${suffix}@example.test`;
  const registered = await request(app).post("/auth/register").send({ name: `step15-websocket-${label}`, email, password: "Step15-websocket-password" });
  assert.equal(registered.status, 201);
  const member = await prisma.organizationMember.findFirstOrThrow({ where: { userId: registered.body.user.id } });
  const auth = { Authorization: `Bearer ${registered.body.accessToken}` };
  const project = await request(app).post("/projects").set(auth).send({ name: `step15-websocket-project-${suffix}` });
  const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: "seed-fixed" } });
  const queue = await request(app).post(`/projects/${project.body.id}/queues`).set(auth).send({ name: `step15-websocket-queue-${suffix}`, concurrencyLimit: 2, retryPolicyId: policy.id });
  return { userId: registered.body.user.id, organizationId: member.organizationId, token: registered.body.accessToken, projectId: project.body.id, queueId: queue.body.id };
}

async function cleanup(fixture: Fixture) {
  const queues = await prisma.queue.findMany({ where: { projectId: fixture.projectId }, select: { id: true } });
  const queueIds = queues.map((queue) => queue.id);
  const jobs = await prisma.job.findMany({ where: { queueId: { in: queueIds } }, select: { id: true } });
  const jobIds = jobs.map((job) => job.id);
  const workers = await prisma.worker.findMany({ where: { organizationId: fixture.organizationId }, select: { id: true } });
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
  await prisma.project.delete({ where: { id: fixture.projectId } });
  await prisma.apiKey.deleteMany({ where: { organizationId: fixture.organizationId } });
  await prisma.organizationMember.deleteMany({ where: { organizationId: fixture.organizationId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
  await prisma.organization.delete({ where: { id: fixture.organizationId } });
}

function openSocket(server: Server, token: string): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("server address unavailable"));
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(token)}`);
    socket.once("open", () => {
      socket.once("message", (data) => {
        const message = JSON.parse(data.toString()) as { type?: string };
        if (message.type === "ready") resolve(socket);
        else reject(new Error("websocket did not send ready"));
      });
    });
    socket.once("error", reject);
    socket.once("close", (code) => reject(new Error(`websocket closed with code ${code}`)));
  });
}

function nextMessage(socket: WebSocket, timeoutMs = 2_000): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("timed out waiting for websocket message")), timeoutMs);
    socket.once("message", (data) => {
      clearTimeout(timer);
      resolve(JSON.parse(data.toString()) as Record<string, unknown>);
    });
  });
}

function expectRejectedSocket(server: Server, token: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const address = server.address();
    if (!address || typeof address === "string") return reject(new Error("server address unavailable"));
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/ws?token=${encodeURIComponent(token)}`);
    socket.once("close", (code) => resolve(code));
    socket.once("error", reject);
  });
}

test("WebSocket authenticates, authorizes queue subscriptions, and delivers committed events", async () => {
  const fixture = await createFixture("a");
  const other = await createFixture("b");
  const server = createServer(app);
  const hub = new WebSocketHub();
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    assert.equal(await expectRejectedSocket(server, "invalid-token"), 1008);
    const socket = await openSocket(server, fixture.token);
    socket.send(JSON.stringify({ type: "subscribe", queueId: fixture.queueId }));
    const subscription = await nextMessage(socket);
    assert.deepEqual(subscription.queues, [fixture.queueId]);
    const syntheticMessage = nextMessage(socket);
    await eventBus.publish({ type: "job.queued", organizationId: fixture.organizationId, queueId: fixture.queueId, jobId: "synthetic", payload: {} });
    assert.equal((await syntheticMessage).jobId, "synthetic");

    const unauthorized = await new Promise<Record<string, unknown>>((resolve) => {
      const second = new WebSocket(`ws://127.0.0.1:${(server.address() as { port: number }).port}/ws?token=${encodeURIComponent(fixture.token)}`);
      second.once("open", () => second.send(JSON.stringify({ type: "subscribe", queueId: other.queueId })));
      second.on("message", (data) => { const message = JSON.parse(data.toString()) as Record<string, unknown>; if (message.type === "error") { second.close(); resolve(message); } });
    });
    assert.equal(unauthorized.code, "FORBIDDEN");

    const observedEvent = new Promise<Record<string, unknown>>((resolve) => {
      const unsubscribe = eventBus.subscribe((event) => { unsubscribe(); resolve(event as unknown as Record<string, unknown>); });
    });
    const eventMessage = nextMessage(socket);
    const created = await request(app).post(`/queues/${fixture.queueId}/jobs`).set({ Authorization: `Bearer ${fixture.token}` }).send({ jobType: "step15-websocket-job", payload: { public: true } });
    assert.equal(created.status, 201);
    assert.equal((await observedEvent).type, "job.queued");
    const event = await eventMessage;
    assert.equal(event.type, "job.queued");
    assert.equal(event.queueId, fixture.queueId);
    assert.equal(event.jobId, created.body.id);
    assert.ok(typeof event.eventId === "string");
    assert.equal((event.payload as { status: string }).status, JobStatus.QUEUED);

    const otherCreated = await request(app).post(`/queues/${other.queueId}/jobs`).set({ Authorization: `Bearer ${other.token}` }).send({ jobType: "step15-other-job", payload: {} });
    assert.equal(otherCreated.status, 201);
    await assert.rejects(() => nextMessage(socket), /timed out/);
    socket.close();
  } finally {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup(other);
    await cleanup(fixture);
  }
});

test("WebSocket delivers the real job lifecycle for a real queued job", async () => {
  const fixture = await createFixture("lifecycle");
  const runtime = await startRuntimeBootstrap({ app, port: 0, schedulerPollIntervalMs: 200, workerPollIntervalMs: 50 });
  const server = runtime.server;
  try {
    const socket = await openSocket(server, fixture.token);
    socket.send(JSON.stringify({ type: "subscribe", queueId: fixture.queueId }));
    await nextMessage(socket);

    const lifecycleEvents: string[] = [];
    const onMessage = (data: Buffer | ArrayBuffer | Buffer[]) => {
      const message = JSON.parse(data.toString()) as Record<string, unknown>;
      if (typeof message.type === "string") {
        lifecycleEvents.push(message.type);
      }
    };
    socket.on("message", onMessage);

    const created = await request(app).post(`/queues/${fixture.queueId}/jobs`).set({ Authorization: `Bearer ${fixture.token}` }).send({
      jobType: "step15-websocket-lifecycle-job",
      payload: { ok: true }
    });
    assert.equal(created.status, 201);

    await new Promise<void>((resolve, reject) => {
      const started = Date.now();
      const timer = setInterval(async () => {
        const job = await prisma.job.findUnique({ where: { id: created.body.id }, select: { status: true } });
        if (job?.status === JobStatus.COMPLETED) {
          clearInterval(timer);
          resolve();
          return;
        }
        if (Date.now() - started > 20_000) {
          clearInterval(timer);
          reject(new Error("Timed out waiting for job completion"));
        }
      }, 100);
    });

    const finalJob = await prisma.job.findUnique({ where: { id: created.body.id }, include: { executions: true } });
    assert.ok(finalJob);
    assert.equal(finalJob.status, JobStatus.COMPLETED);

    const queuedIndex = lifecycleEvents.indexOf("job.queued");
    const claimedIndex = lifecycleEvents.indexOf("job.claimed");
    const runningIndex = lifecycleEvents.indexOf("job.running");
    const completedIndex = lifecycleEvents.indexOf("job.completed");

    assert.ok(queuedIndex >= 0, `missing queued event: ${lifecycleEvents.join(",")}`);
    assert.ok(claimedIndex >= 0, `missing claimed event: ${lifecycleEvents.join(",")}`);
    assert.ok(runningIndex >= 0, `missing running event: ${lifecycleEvents.join(",")}`);
    assert.ok(completedIndex >= 0, `missing completed event: ${lifecycleEvents.join(",")}`);
    assert.ok(queuedIndex < claimedIndex, "queued must precede claimed");
    assert.ok(claimedIndex < runningIndex, "claimed must precede running");
    assert.ok(runningIndex < completedIndex, "running must precede completed");

    socket.close();
  } finally {
    await runtime.shutdown();
    await cleanup(fixture);
  }
});

test("WebSocket fan-out uses one event and rollback publishes nothing", async () => {
  const fixture = await createFixture("fanout");
  const server = createServer(app);
  const hub = new WebSocketHub();
  hub.attach(server);
  await new Promise<void>((resolve) => server.listen(0, resolve));
  try {
    const sockets = await Promise.all(Array.from({ length: 10 }, () => openSocket(server, fixture.token)));
    await Promise.all(sockets.map(async (socket) => { socket.send(JSON.stringify({ type: "subscribe", queueId: fixture.queueId })); await nextMessage(socket); }));
    const events: string[] = [];
    const unsubscribe = eventBus.subscribe((event) => { events.push(event.eventId); });
    const failed = await request(app).post(`/queues/${fixture.queueId}/jobs/batch`).set({ Authorization: `Bearer ${fixture.token}` }).send({ jobs: [] });
    assert.equal(failed.status, 400);
    assert.equal(events.length, 0);
    const receives = sockets.map((socket) => nextMessage(socket));
    const created = await request(app).post(`/queues/${fixture.queueId}/jobs`).set({ Authorization: `Bearer ${fixture.token}` }).send({ jobType: "step15-fanout", payload: {} });
    assert.equal(created.status, 201);
    const received = await Promise.all(receives);
    assert.equal(received.length, 10);
    assert.equal(new Set(events).size, 1);
    for (const socket of sockets) socket.close();
    unsubscribe();
  } finally {
    hub.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await cleanup(fixture);
  }
});
