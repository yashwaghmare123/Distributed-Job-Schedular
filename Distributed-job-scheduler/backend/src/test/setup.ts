import { after } from "node:test";
import { disconnectDatabase } from "../lib/prisma.js";
import { disconnectRedis } from "../lib/redis.js";

after(async () => {
  await Promise.all([disconnectRedis(), disconnectDatabase()]);
});
