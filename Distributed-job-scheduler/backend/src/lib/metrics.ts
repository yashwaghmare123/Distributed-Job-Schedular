import { randomUUID } from "node:crypto";
import { prisma } from "./prisma.js";
import { redis } from "./redis.js";

const metrics = new Map<string, { value: number; type: "counter" | "gauge" | "histogram"; help: string; labels?: Record<string, string> }>();

function register(name: string, type: "counter" | "gauge" | "histogram", help: string, initialValue = 0) {
  if (!metrics.has(name)) {
    metrics.set(name, { value: initialValue, type, help });
  }
}

register("jobs_created_total", "counter", "Total jobs created");
register("jobs_completed_total", "counter", "Total jobs completed");
register("jobs_failed_total", "counter", "Total jobs failed");
register("jobs_retried_total", "counter", "Total jobs retried");
register("jobs_dead_lettered_total", "counter", "Total jobs dead lettered");
register("active_workers", "gauge", "Active workers");
register("queue_depth", "gauge", "Queue depth");
register("job_execution_duration_ms", "histogram", "Job execution duration in milliseconds");
register("http_requests_total", "counter", "Total HTTP requests");
register("http_request_duration_ms", "histogram", "HTTP request duration in milliseconds");
register("http_errors_total", "counter", "Total HTTP errors");

export const metricsRegistry = {
  increment(name: string, value = 1) {
    const current = metrics.get(name);
    if (!current) return;
    current.value += value;
  },
  set(name: string, value: number) {
    const current = metrics.get(name);
    if (!current) return;
    current.value = value;
  },
  observe(name: string, value: number) {
    const current = metrics.get(name);
    if (!current) return;
    current.value = value;
  },
  snapshot() {
    return Array.from(metrics.entries()).map(([name, metric]) => ({ name, ...metric }));
  }
};

export function metricsText() {
  const lines: string[] = [];
  for (const [name, metric] of metrics.entries()) {
    lines.push(`# HELP ${name} ${metric.help}`);
    lines.push(`# TYPE ${name} ${metric.type}`);
    lines.push(`${name} ${metric.value}`);
  }
  return lines.join("\n") + "\n";
}

export async function updateRuntimeMetrics() {
  const [workerCount, queueDepth] = await Promise.all([
    prisma.worker.count({ where: { status: "ONLINE" } }),
    prisma.job.count({ where: { status: { in: ["QUEUED", "CLAIMED", "RUNNING", "RETRY", "SCHEDULED"] } } })
  ]);
  metricsRegistry.set("active_workers", workerCount);
  metricsRegistry.set("queue_depth", queueDepth);
  try {
    const ping = await redis.ping();
    if (ping !== "PONG") {
      metricsRegistry.set("queue_depth", 0);
    }
  } catch {
    metricsRegistry.set("queue_depth", 0);
  }
}

export function requestCorrelationMiddleware() {
  return async function (_request: any, response: any, next: any) {
    const requestId = randomUUID();
    response.setHeader("X-Request-ID", requestId);
    response.locals.requestId = requestId;
    next();
  };
}
