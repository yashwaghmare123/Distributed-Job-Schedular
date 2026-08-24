import test from "node:test";
import assert from "node:assert/strict";
import request from "supertest";
import { JobStatus } from "@prisma/client";
import { createApp, startRuntimeBootstrap } from "./server.js";
import { prisma } from "./lib/prisma.js";

async function waitFor(condition: () => Promise<boolean> | boolean, timeoutMs = 15_000, intervalMs = 100): Promise<void> {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    if (await condition()) return;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
  throw new Error("Timed out waiting for condition");
}

test("runtime bootstrap starts scheduler/worker and completes a real queued job", async () => {
  const app = createApp();
  const runtime = await startRuntimeBootstrap({ app, port: 0, schedulerPollIntervalMs: 250, workerPollIntervalMs: 25 });

  try {
    const register = await request(app).post("/auth/register").send({
      name: "runtime bootstrap user",
      email: `runtime-bootstrap-${Date.now()}-${Math.random().toString(16).slice(2)}@example.test`,
      password: "RuntimeBootstrapPass123!"
    });
    assert.equal(register.status, 201);

    const auth = { Authorization: `Bearer ${register.body.accessToken}` };
    const project = await request(app).post("/projects").set(auth).send({ name: `runtime-bootstrap-project-${Date.now()}` });
    assert.equal(project.status, 201);

    const policy = await prisma.retryPolicy.findFirstOrThrow({ where: { name: "seed-fixed" } });
    const queue = await request(app).post(`/projects/${project.body.id}/queues`).set(auth).send({
      name: `runtime-bootstrap-queue-${Date.now()}`,
      concurrencyLimit: 2,
      retryPolicyId: policy.id
    });
    assert.equal(queue.status, 201);

    const created = await request(app).post(`/queues/${queue.body.id}/jobs`).set(auth).send({
      jobType: "runtime-bootstrap-job",
      payload: { ok: true }
    });
    assert.equal(created.status, 201);

    await waitFor(async () => {
      const job = await prisma.job.findUnique({ where: { id: created.body.id }, select: { status: true } });
      return job?.status === JobStatus.COMPLETED;
    }, 20_000, 100);

    const persisted = await prisma.job.findUnique({
      where: { id: created.body.id },
      include: { executions: true }
    });

    assert.ok(persisted);
    assert.equal(persisted.status, JobStatus.COMPLETED);
    assert.ok(persisted.executions.length >= 1);
    assert.equal(persisted.executions[0]?.status, "COMPLETED");
  } finally {
    await runtime.shutdown();
  }
});
