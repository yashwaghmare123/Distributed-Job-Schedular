import "dotenv/config";
import { PrismaPg } from "@prisma/adapter-pg";
import { PrismaClient } from "@prisma/client";
import pg from "pg";

const processEnvironment = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process?.env;
const databaseUrl = processEnvironment?.DATABASE_URL;

if (!databaseUrl) {
  throw new Error("DATABASE_URL is required to initialize the application database client.");
}

const poolMax = Number.parseInt(processEnvironment?.DB_POOL_MAX ?? "20", 10);
if (!Number.isSafeInteger(poolMax) || poolMax < 1) {
  throw new Error("DB_POOL_MAX must be a positive integer.");
}

const pool = new pg.Pool({
  connectionString: databaseUrl,
  max: poolMax,
  connectionTimeoutMillis: 10_000
});
const adapter = new PrismaPg(pool);

export const prisma = new PrismaClient({ adapter });

let disconnectPromise: Promise<void> | null = null;

export function disconnectDatabase(): Promise<void> {
  if (!disconnectPromise) {
    disconnectPromise = (async () => {
      await prisma.$disconnect();
    })();
  }
  return disconnectPromise;
}
