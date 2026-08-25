import { prisma } from "./prisma.js";
import { redis } from "./redis.js";
import { getWebSocketHealth } from "../events/websocketHub.js";

async function withRetry(operation: () => Promise<void>, attempts = 5, delayMs = 200): Promise<boolean> {
  for (let attempt = 0; attempt < attempts; attempt += 1) {
    try {
      await operation();
      return true;
    } catch {
      if (attempt < attempts - 1) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
    }
  }

  return false;
}

export async function checkReadiness(): Promise<{ ok: boolean; failures: string[]; database: "ready" | "unavailable"; redis: "ready" | "unavailable"; websocket: ReturnType<typeof getWebSocketHealth> }> {
  const failures: string[] = [];

  const dbCheck = await withRetry(async () => {
    await prisma.$connect();
    await prisma.$queryRaw`SELECT 1`;
  });
  if (!dbCheck) {
    failures.push("PostgreSQL unavailable");
  }

  const redisCheck = await withRetry(async () => {
    if (!redis.isOpen) await redis.connect();
    const pong = await redis.ping();
    if (pong !== "PONG") throw new Error("Redis ping did not return PONG");
  });
  if (!redisCheck) {
    failures.push("Redis unavailable");
  }

  const websocket = getWebSocketHealth();
  if (websocket !== "ready") failures.push(`WebSocket server ${websocket}`);
  return { ok: failures.length === 0, failures, database: dbCheck ? "ready" : "unavailable", redis: redisCheck ? "ready" : "unavailable", websocket };
}
