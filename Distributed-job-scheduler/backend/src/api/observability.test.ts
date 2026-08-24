import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { randomUUID } from "node:crypto";
import { JobStatus } from "@prisma/client";
import { createApp } from "./index.js";
import { logger } from "../lib/logger.js";
import { eventBus } from "../events/eventBus.js";
import { prisma } from "../lib/prisma.js";
import { redis } from "../lib/redis.js";

const app = createApp();

test("request IDs are generated and preserved", async () => {
  const preserved = await request(app).get("/health").set("X-Request-ID", "trace-123");
  assert.equal(preserved.headers["x-request-id"], "trace-123");

  const generated = await request(app).get("/health");
  assert.ok(generated.headers["x-request-id"]);
  assert.notEqual(generated.headers["x-request-id"], "trace-123");
});

test("health and readiness endpoints report service state", async () => {
  const health = await request(app).get("/health");
  assert.equal(health.status, 200);
  assert.deepEqual(health.body, { status: "ok" });

  const ready = await request(app).get("/ready");
  assert.equal(ready.status, 200);
  assert.equal(ready.body.status, "ok");
});

test("readiness reports dependency failures without exposing secrets", async () => {
  const originalQuery = prisma.$queryRaw.bind(prisma);
  const originalPing = redis.ping.bind(redis);
  try {
    (prisma as any).$queryRaw = async () => { throw new Error("db down"); };
    (redis as any).ping = async () => { throw new Error("redis down"); };

    const response = await request(app).get("/ready");
    assert.equal(response.status, 503);
    assert.equal(response.body.status, "error");
    assert.match(response.body.error, /PostgreSQL|Redis/);
    assert.equal(response.body.error.includes("password"), false);
  } finally {
    (prisma as any).$queryRaw = originalQuery;
    (redis as any).ping = originalPing;
  }
});

test("metrics endpoint exposes Prometheus-compatible counters and gauges", async () => {
  const response = await request(app).get("/metrics");
  assert.equal(response.status, 200);
  assert.match(response.text, /jobs_created_total/);
  assert.match(response.text, /jobs_completed_total/);
  assert.match(response.text, /jobs_failed_total/);
  assert.match(response.text, /jobs_retried_total/);
  assert.match(response.text, /jobs_dead_lettered_total/);
  assert.match(response.text, /active_workers/);
  assert.match(response.text, /queue_depth/);
  assert.match(response.text, /http_requests_total/);
});

test("job lifecycle events increment metrics", async () => {
  await eventBus.publish({ type: "job.queued", organizationId: randomUUID(), queueId: randomUUID(), jobId: randomUUID(), payload: { status: JobStatus.QUEUED } });
  await eventBus.publish({ type: "job.completed", organizationId: randomUUID(), queueId: randomUUID(), jobId: randomUUID(), payload: { status: JobStatus.COMPLETED } });
  await eventBus.publish({ type: "job.failed", organizationId: randomUUID(), queueId: randomUUID(), jobId: randomUUID(), payload: { status: JobStatus.FAILED } });
  await eventBus.publish({ type: "job.retry", organizationId: randomUUID(), queueId: randomUUID(), jobId: randomUUID(), payload: { status: JobStatus.RETRY } });
  await eventBus.publish({ type: "job.dead_lettered", organizationId: randomUUID(), queueId: randomUUID(), jobId: randomUUID(), payload: { status: JobStatus.DEAD_LETTER } });

  const response = await request(app).get("/metrics");
  assert.match(response.text, /jobs_created_total\s+1/);
  assert.match(response.text, /jobs_completed_total\s+1/);
  assert.match(response.text, /jobs_failed_total\s+1/);
  assert.match(response.text, /jobs_retried_total\s+1/);
  assert.match(response.text, /jobs_dead_lettered_total\s+1/);
});

test("logger redacts sensitive fields", async () => {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((item) => String(item)).join(" "));
  };

  try {
    logger.info("request complete", { requestId: "req-1", password: "secret", authorization: "Bearer abc", apiKey: "key-abc", token: "jwt-abc" });
    const dump = captured.join("\n");
    assert.equal(dump.includes("secret"), false);
    assert.equal(dump.includes("jwt-abc"), false);
    assert.equal(dump.includes("key-abc"), false);
    assert.equal(dump.includes("Authorization"), false);
  } finally {
    console.log = original;
  }
});

test("api errors are logged with safe metadata", async () => {
  const original = console.log;
  const captured: string[] = [];
  console.log = (...args: unknown[]) => {
    captured.push(args.map((item) => String(item)).join(" "));
  };

  try {
    const response = await request(app).get("/projects");
    assert.equal(response.status, 401);
    const dump = captured.join("\n");
    assert.ok(dump.includes("UNAUTHORIZED"));
    assert.ok(dump.includes("/projects"));
    assert.ok(dump.includes("route") || dump.includes("requestId"));
  } finally {
    console.log = original;
  }
});
