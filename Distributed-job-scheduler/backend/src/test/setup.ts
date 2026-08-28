import { after } from "node:test";
import { disconnectRedis } from "../lib/redis.js";

after(async () => {
  await disconnectRedis();
});
