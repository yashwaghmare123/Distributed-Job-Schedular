import { after } from "node:test";
import { disconnectDatabase } from "./lib/prisma.js";
import { redis } from "./lib/redis.js";

after(async () => {
  if (redis.isOpen) {
    await redis.quit();
  }
  await disconnectDatabase();
});