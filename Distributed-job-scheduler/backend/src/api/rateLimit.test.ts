import test, { after } from "node:test";
import assert from "node:assert/strict";
import express from "express";
import request from "supertest";
import { redis } from "../lib/redis.js";
import { createRateLimiter, type RateLimitPolicy } from "./middleware/rateLimit.js";
import { apiErrorHandler } from "./lib/errors.js";

const testPrefix = `rate-limit-test-${Date.now()}-${Math.random().toString(36).slice(2)}`;
const policy: RateLimitPolicy = { name: testPrefix, windowMs: 1_000, maxRequests: 5 };
const client = redis;

function makeApp(limiter = createRateLimiter(policy, client), beforeRoute?: express.RequestHandler) {
  const app = express();
  app.use(express.json());
  if (beforeRoute) app.use(beforeRoute);
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.get("/limited", limiter, (_request, response) => response.json({ ok: true }));
  app.post("/mutation", limiter, (_request, response) => response.status(201).json({ created: true }));
  app.use(apiErrorHandler);
  return app;
}

async function clearKeys() {
  if (!client.isOpen) await client.connect();
  const keys: string[] = [];
  for await (const rawKey of client.scanIterator({ MATCH: `rate-limit:v1:${testPrefix}:*`, COUNT: 100 })) {
    if (Array.isArray(rawKey)) keys.push(...rawKey);
    else keys.push(rawKey);
  }
  if (keys.length) await client.del(keys);
}

test("allows under-limit requests and exposes rate-limit headers", async () => {
  await clearKeys();
  const response = await request(makeApp()).get("/limited");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-ratelimit-limit"], "5");
  assert.equal(response.headers["x-ratelimit-remaining"], "4");
  assert.ok(response.headers["x-ratelimit-reset"]);
});

test("rejects over-limit requests with existing error shape and Retry-After", async () => {
  await clearKeys();
  const responses = await Promise.all(Array.from({ length: 6 }, () => request(makeApp()).get("/limited")));
  assert.equal(responses.filter((response) => response.status === 200).length, 5);
  const rejected = responses.filter((response) => response.status === 429);
  assert.equal(rejected.length, 1);
  assert.equal(rejected[0]!.body.error.code, "RATE_LIMITED");
  assert.match(rejected[0]!.body.error.message, /Too many requests/);
  assert.ok(Number(rejected[0]!.headers["retry-after"]) >= 1);
});

test("concurrent same-identity requests cannot bypass the atomic window", async () => {
  await clearKeys();
  const responses = await Promise.all(Array.from({ length: 10 }, () => request(makeApp()).get("/limited")));
  assert.equal(responses.filter((response) => response.status === 200).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 5);
});

test("different authenticated identities receive independent buckets", async () => {
  await clearKeys();
  const identity = (id: string): express.RequestHandler => (request, _response, next) => { request.user = { id, email: `${id}@test`, organizationIds: [id] }; next(); };
  const appA = makeApp(createRateLimiter(policy, client), identity("user-a"));
  const appB = makeApp(createRateLimiter(policy, client), identity("user-b"));
  const responses = await Promise.all([
    ...Array.from({ length: 6 }, () => request(appA).get("/limited")),
    ...Array.from({ length: 6 }, () => request(appB).get("/limited"))
  ]);
  assert.equal(responses.filter((response) => response.status === 200).length, 10);
  assert.equal(responses.filter((response) => response.status === 429).length, 2);
});

test("different API-key identities use hashed independent buckets", async () => {
  await clearKeys();
  const app = makeApp();
  const responses = await Promise.all([
    ...Array.from({ length: 6 }, () => request(app).get("/limited").set("X-API-Key", "secret-a")),
    ...Array.from({ length: 6 }, () => request(app).get("/limited").set("X-API-Key", "secret-b"))
  ]);
  assert.equal(responses.filter((response) => response.status === 200).length, 10);
  assert.equal(responses.filter((response) => response.status === 429).length, 2);
  const keys: string[] = [];
  for await (const rawKey of client.scanIterator({ MATCH: `rate-limit:v1:${testPrefix}:*`, COUNT: 100 })) {
    if (Array.isArray(rawKey)) keys.push(...rawKey);
    else keys.push(rawKey);
  }
  assert.ok(keys.length >= 2);
  assert.ok(keys.every((key) => !key.includes("secret-a") && !key.includes("secret-b")));
});

test("counter TTL expires and the fixed window resets", async () => {
  await clearKeys();
  await request(makeApp()).get("/limited");
  const keys: string[] = [];
  for await (const rawKey of client.scanIterator({ MATCH: `rate-limit:v1:${testPrefix}:*`, COUNT: 100 })) {
    if (Array.isArray(rawKey)) keys.push(...rawKey);
    else keys.push(rawKey);
  }
  assert.equal(keys.length, 1);
  assert.ok(await client.ttl(keys[0]!) > 0);
  await new Promise((resolve) => setTimeout(resolve, 1_100));
  const response = await request(makeApp()).get("/limited");
  assert.equal(response.status, 200);
  assert.equal(response.headers["x-ratelimit-remaining"], "4");
});

test("health remains available and rejected mutations do not execute the route", async () => {
  await clearKeys();
  let mutationCalls = 0;
  const app = express();
  app.get("/health", (_request, response) => response.json({ status: "ok" }));
  app.post("/mutation", createRateLimiter(policy, client), (_request, response) => { mutationCalls += 1; response.status(201).json({ created: true }); });
  app.use(apiErrorHandler);
  assert.equal((await request(app).get("/health")).status, 200);
  const responses = await Promise.all(Array.from({ length: 6 }, () => request(app).post("/mutation")));
  assert.equal(responses.filter((response) => response.status === 201).length, 5);
  assert.equal(responses.filter((response) => response.status === 429).length, 1);
  assert.equal(mutationCalls, 5);
});

test("Redis failure fails open for rate limiting without bypassing upstream authentication", async () => {
  const unavailable = (await import("redis")).createClient({ url: "redis://127.0.0.1:6399", socket: { reconnectStrategy: false } });
  const protectedApp = express();
  protectedApp.use((request: express.Request, _response: express.Response, next: express.NextFunction) => request.headers.authorization === "Bearer valid" ? next() : next(new Error("unauthorized")));
  protectedApp.get("/protected", createRateLimiter(policy, unavailable), (_request, response) => response.json({ ok: true }));
  protectedApp.use((_error: unknown, _request: express.Request, response: express.Response, _next: express.NextFunction) => response.status(401).json({ error: { code: "UNAUTHORIZED" } }));
  assert.equal((await request(protectedApp).get("/protected")).status, 401);
  assert.equal((await request(protectedApp).get("/protected").set("Authorization", "Bearer valid")).status, 200);
  if (unavailable.isOpen) await unavailable.disconnect();
});

after(async () => {
  if (client.isOpen) await clearKeys();
});
