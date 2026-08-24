import { pathToFileURL } from "node:url";
import type { Server as HttpServer } from "node:http";
import { WorkerStatus } from "@prisma/client";
import { prisma } from "./lib/prisma.js";
import { createApp } from "./api/index.js";
import { WebSocketHub } from "./events/websocketHub.js";
import { Scheduler } from "./core/scheduler.js";
import { WorkerRuntime } from "./core/workerRuntime.js";
import { RetryProcessor } from "./core/retryProcessor.js";
import { redis } from "./lib/redis.js";

export { createApp };

export type RuntimeBootstrapOptions = {
  app?: ReturnType<typeof createApp>;
  port?: number;
  schedulerPollIntervalMs?: number;
  workerPollIntervalMs?: number;
};

export type RuntimeBootstrapHandle = {
  server: HttpServer;
  shutdown: (signal?: string) => Promise<void>;
};

function getConfiguredPort(port?: number): number {
  const configuredPort = Number.parseInt(String(port ?? process.env.PORT ?? "3000"), 10);
  if (!Number.isInteger(configuredPort) || configuredPort < 0 || configuredPort > 65_535) {
    throw new Error("PORT must be an integer between 0 and 65535.");
  }
  return configuredPort;
}

async function ensureQueueWorker(queueId: string): Promise<{ id: string; organizationId: string; name: string }> {
  const queue = await prisma.queue.findUnique({
    where: { id: queueId },
    select: {
      id: true,
      concurrencyLimit: true,
      project: { select: { organizationId: true } }
    }
  });

  if (!queue) {
    throw new Error(`Queue ${queueId} was not found while creating the runtime worker.`);
  }

  const name = `app-runtime-${queueId.slice(0, 8)}`;
  const worker = await prisma.worker.upsert({
    where: { organizationId_name: { organizationId: queue.project.organizationId, name } },
    update: {
      status: WorkerStatus.ONLINE,
      concurrency: Math.max(queue.concurrencyLimit, 1),
      currentJobCount: 0,
      lastHeartbeatAt: new Date(),
      startedAt: new Date(),
      stoppedAt: null,
      updatedAt: new Date()
    },
    create: {
      organizationId: queue.project.organizationId,
      name,
      status: WorkerStatus.ONLINE,
      concurrency: Math.max(queue.concurrencyLimit, 1),
      currentJobCount: 0,
      lastHeartbeatAt: new Date(),
      startedAt: new Date()
    }
  });

  return { id: worker.id, organizationId: worker.organizationId, name: worker.name };
}

export async function startRuntimeBootstrap(options: RuntimeBootstrapOptions = {}): Promise<RuntimeBootstrapHandle> {
  const configuredPort = getConfiguredPort(options.port);
  const app = options.app ?? createApp();
  const server = app.listen(configuredPort, () => {
    console.log(`HTTP server started on port ${configuredPort}`);
  });

  const websocketHub = new WebSocketHub();
  websocketHub.attach(server);
  console.log("WebSocket started");

  const scheduler = new Scheduler();
  const retryProcessor = new RetryProcessor();
  const runtimeWorkers = new Map<string, WorkerRuntime>();
  const schedulerPollIntervalMs = options.schedulerPollIntervalMs ?? Number.parseInt(process.env.SCHEDULER_POLL_INTERVAL_MS ?? "5000", 10);
  const workerPollIntervalMs = options.workerPollIntervalMs ?? Number.parseInt(process.env.WORKER_POLL_INTERVAL_MS ?? "250", 10);
  const schedulerTickPromises = new Set<Promise<void>>();
  let shutdownRequested = false;
  let shutdownPromise: Promise<void> | null = null;

  const ensureRuntimeWorkers = async () => {
    const queues = await prisma.queue.findMany({ select: { id: true } });
    for (const queue of queues) {
      if (runtimeWorkers.has(queue.id)) {
        continue;
      }

      const runtimeWorker = await ensureQueueWorker(queue.id);
      const runtime = new WorkerRuntime({
        workerId: runtimeWorker.id,
        queueId: queue.id,
        pollIntervalMs: workerPollIntervalMs,
        handler: async (job) => ({ ok: true, jobId: job.id, workerId: runtimeWorker.id, status: "COMPLETED" })
      });

      runtime.start();
      runtimeWorkers.set(queue.id, runtime);
      console.log(`Worker started for queue ${queue.id} (${runtimeWorker.name})`);
    }
  };

  await ensureRuntimeWorkers();
  console.log("Scheduler started");
  console.log("Worker started");

  const schedulerTick = setInterval(() => {
    if (shutdownRequested) {
      return;
    }

    const task = (async () => {
      if (shutdownRequested) {
        return;
      }

      try {
        await ensureRuntimeWorkers();
        const queues = await prisma.queue.findMany({ select: { id: true } });
        for (const queue of queues) {
          if (shutdownRequested) {
            return;
          }
          await scheduler.promoteDueScheduledJobs(queue.id);
          if (shutdownRequested) {
            return;
          }
          await retryProcessor.promoteDueRetries(queue.id);
          if (shutdownRequested) {
            return;
          }
          const dueScheduledJobs = await prisma.scheduledJob.findMany({
            where: { queueId: queue.id, enabled: true, nextRunAt: { lte: new Date() } },
            select: { id: true }
          });
          for (const scheduledJob of dueScheduledJobs) {
            if (shutdownRequested) {
              return;
            }
            await scheduler.materializeDueScheduledJob(scheduledJob.id, queue.id);
          }
        }
      } catch (error) {
        if (!shutdownRequested) {
          console.error("Scheduler tick failed.", error);
        }
      }
    })();

    schedulerTickPromises.add(task);
    void task.finally(() => {
      schedulerTickPromises.delete(task);
    });
  }, schedulerPollIntervalMs);

  const shutdown = async (signal?: string) => {
    if (shutdownPromise) {
      return shutdownPromise;
    }

    shutdownPromise = (async () => {
      shutdownRequested = true;
      if (signal) {
        console.log(`Received ${signal}; shutting down.`);
      }
      clearInterval(schedulerTick);

      await Promise.allSettled(Array.from(runtimeWorkers.values(), (runtime) => runtime.stop()));
      await Promise.allSettled(Array.from(schedulerTickPromises));

      websocketHub.close();

      await new Promise<void>((resolve, reject) => {
        server.close((error) => {
          if (error) {
            reject(error);
            return;
          }
          resolve();
        });
      });

      try {
        if (redis.isOpen) {
          await redis.quit();
        }
      } catch (error) {
        console.error("Failed to disconnect Redis during shutdown.", error);
      }

      await prisma.$disconnect();
      console.log("Application shutdown complete.");
    })();

    return shutdownPromise;
  };

  process.once("SIGINT", () => {
    void shutdown("SIGINT").finally(() => process.exit(0));
  });
  process.once("SIGTERM", () => {
    void shutdown("SIGTERM").finally(() => process.exit(0));
  });

  server.on("error", (error: NodeJS.ErrnoException) => {
    console.error("Backend failed to start.", error);
    void prisma.$disconnect().finally(() => process.exit(1));
  });

  return { server, shutdown };
}

const entryUrl = process.argv[1] ? pathToFileURL(process.argv[1]).href : undefined;
if (entryUrl && import.meta.url === entryUrl) {
  void startRuntimeBootstrap();
}
