import { createHash } from "node:crypto";
import type { NextFunction, Request, Response } from "express";
import { redis } from "../../lib/redis.js";
import { HttpError } from "../lib/errors.js";

export type RateLimitPolicy = {
  name: string;
  windowMs: number;
  maxRequests: number;
};

type CounterResult = { count: number; ttlSeconds: number };
type RateLimitPipeline = {
  incr: (key: string) => RateLimitPipeline;
  expire: (key: string, seconds: number) => RateLimitPipeline;
  ttl: (key: string) => RateLimitPipeline;
  exec: () => Promise<unknown[]>;
};
type RateLimitClient = {
  isOpen: boolean;
  connect: () => Promise<unknown>;
  multi: () => RateLimitPipeline;
};

const redisConnectPromises = new WeakMap<object, Promise<void>>();

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

export const rateLimitPolicies = {
  auth: {
    name: "auth",
    windowMs: positiveInteger(process.env.RATE_LIMIT_AUTH_WINDOW_MS, 60_000),
    maxRequests: positiveInteger(process.env.RATE_LIMIT_AUTH_MAX_REQUESTS, 10)
  },
  read: {
    name: "read",
    windowMs: positiveInteger(process.env.RATE_LIMIT_READ_WINDOW_MS, 60_000),
    maxRequests: positiveInteger(process.env.RATE_LIMIT_READ_MAX_REQUESTS, 120)
  },
  write: {
    name: "write",
    windowMs: positiveInteger(process.env.RATE_LIMIT_WRITE_WINDOW_MS, 60_000),
    maxRequests: positiveInteger(process.env.RATE_LIMIT_WRITE_MAX_REQUESTS, 60)
  },
  batch: {
    name: "batch",
    windowMs: positiveInteger(process.env.RATE_LIMIT_BATCH_WINDOW_MS, 60_000),
    maxRequests: positiveInteger(process.env.RATE_LIMIT_BATCH_MAX_REQUESTS, 20)
  }
} satisfies Record<string, RateLimitPolicy>;

function identityFor(request: Request): string {
  const apiKeyHeader = request.headers["x-api-key"];
  const apiKey = Array.isArray(apiKeyHeader) ? apiKeyHeader[0] : apiKeyHeader;
  if (apiKey) return `api:${createHash("sha256").update(apiKey).digest("hex")}`;
  if (request.user?.id) return `user:${request.user.id}`;
  return `ip:${request.ip || request.socket.remoteAddress || "unknown"}`;
}

function keyFor(request: Request, policy: RateLimitPolicy, window: number): string {
  return `rate-limit:v1:${policy.name}:${identityFor(request)}:${window}`;
}

function isRateLimitClient(client: unknown): client is RateLimitClient {
  if (!client || typeof client !== "object") return false;
  const candidate = client as { isOpen?: unknown; connect?: unknown; multi?: unknown };
  return typeof candidate.isOpen === "boolean" && typeof candidate.connect === "function" && typeof candidate.multi === "function";
}

async function ensureConnected(client: RateLimitClient): Promise<void> {
  if (client.isOpen) return;
  let promise = redisConnectPromises.get(client as object);
  if (!promise) {
    promise = client.connect().then(() => undefined);
    redisConnectPromises.set(client as object, promise);
  }
  try {
    await promise;
  } finally {
    redisConnectPromises.delete(client as object);
  }
}

async function increment(client: RateLimitClient, key: string, windowSeconds: number): Promise<CounterResult> {
  const result = await client.multi().incr(key).expire(key, windowSeconds).ttl(key).exec();
  const count = Number(result?.[0]);
  const ttlSeconds = Number(result?.[2]);
  if (!Number.isSafeInteger(count) || !Number.isSafeInteger(ttlSeconds)) throw new Error("Invalid Redis rate-limit response.");
  return { count, ttlSeconds };
}

export function createRateLimiter(policy: RateLimitPolicy, client: unknown = redis) {
  return async function rateLimit(request: Request, response: Response, next: NextFunction) {
    const windowSeconds = Math.max(1, Math.ceil(policy.windowMs / 1000));
    const window = Math.floor(Date.now() / policy.windowMs);
    const key = keyFor(request, policy, window);
    try {
      if (!isRateLimitClient(client)) throw new Error("Invalid Redis rate-limit client.");
      await ensureConnected(client);
      const counter = await increment(client, key, windowSeconds);
      const remaining = Math.max(0, policy.maxRequests - counter.count);
      const resetSeconds = Math.max(1, counter.ttlSeconds);
      response.setHeader("X-RateLimit-Limit", String(policy.maxRequests));
      response.setHeader("X-RateLimit-Remaining", String(remaining));
      response.setHeader("X-RateLimit-Reset", String(Math.ceil(Date.now() / 1000) + resetSeconds));
      if (counter.count > policy.maxRequests) {
        response.setHeader("Retry-After", String(resetSeconds));
        throw new HttpError(429, "RATE_LIMITED", "Too many requests. Please retry later.");
      }
      return next();
    } catch (error) {
      if (error instanceof HttpError) return next(error);
      console.error(`Rate limiter unavailable for policy ${policy.name}; failing open.`);
      return next();
    }
  };
}

export const authRateLimit = createRateLimiter(rateLimitPolicies.auth);
export const readRateLimit = createRateLimiter(rateLimitPolicies.read);
export const writeRateLimit = createRateLimiter(rateLimitPolicies.write);
export const batchRateLimit = createRateLimiter(rateLimitPolicies.batch);
