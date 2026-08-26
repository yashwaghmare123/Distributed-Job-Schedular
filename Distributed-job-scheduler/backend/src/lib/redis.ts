import "dotenv/config";
import { createClient, type RedisClientType } from "redis";

const redisUrl = process.env.REDIS_URL;
if (!redisUrl) {
  throw new Error("REDIS_URL is required to initialize the Redis client.");
}

export const redis = createClient({ url: redisUrl }) as RedisClientType;

export async function pingRedis(): Promise<string> {
  if (!redis.isOpen) await redis.connect();
  return redis.ping();
}

export async function disconnectRedis(): Promise<void> {
  if (redis.isOpen) {
    await redis.quit();
  }
}
