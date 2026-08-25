import { z } from "zod";
import type { Job } from "@prisma/client";
import type { JobHandler, JobExecutionResult } from "./workerRuntime.js";

export type JobHandlerDefinition = {
  type: string;
  label: string;
  description: string;
  payloadExample: Record<string, unknown>;
  handler: JobHandler;
  internal?: boolean;
};

const generateReportPayload = z.object({
  title: z.string().min(1).max(200),
  rows: z.array(z.record(z.string(), z.unknown())).min(1).max(10_000)
});

const processDataPayload = z.object({
  items: z.array(z.number().finite()).min(1).max(100_000)
});

const sendNotificationPayload = z.object({
  recipient: z.string().min(1).max(200),
  message: z.string().min(1).max(10_000)
});

function completed(job: Job): JobExecutionResult {
  return { ok: true, jobId: job.id, workerId: job.claimedBy ?? "unknown-worker", status: "COMPLETED" };
}

function failed(job: Job, errorCode: string, errorMessage: string): JobExecutionResult {
  return { ok: false, jobId: job.id, workerId: job.claimedBy ?? "unknown-worker", status: "FAILED", errorCode, errorMessage, error: errorMessage };
}

function payloadObject(job: Job) {
  return typeof job.payload === "object" && job.payload !== null && !Array.isArray(job.payload) ? job.payload : null;
}

const handlers: JobHandlerDefinition[] = [
  {
    type: "generate_report",
    label: "Generate Report",
    description: "Validates report rows and builds a deterministic report summary locally.",
    payloadExample: { title: "Monthly Sales Report", rows: [{ product: "A", sales: 100 }] },
    handler: async (job) => {
      const parsed = generateReportPayload.safeParse(payloadObject(job));
      if (!parsed.success) return failed(job, "INVALID_REPORT_PAYLOAD", "Report payload requires a title and at least one row.");
      const rowCount = parsed.data.rows.length;
      if (rowCount < 1) return failed(job, "EMPTY_REPORT", "Report must contain at least one row.");
      return completed(job);
    }
  },
  {
    type: "process_data",
    label: "Process Data",
    description: "Validates numeric items and computes a deterministic local aggregate.",
    payloadExample: { items: [1, 2, 3, 4] },
    handler: async (job) => {
      const parsed = processDataPayload.safeParse(payloadObject(job));
      if (!parsed.success) return failed(job, "INVALID_DATA_PAYLOAD", "Data payload requires a non-empty array of finite numbers.");
      const total = parsed.data.items.reduce((sum, item) => sum + item, 0);
      if (!Number.isFinite(total)) return failed(job, "DATA_AGGREGATION_FAILED", "Data could not be aggregated safely.");
      return completed(job);
    }
  },
  {
    type: "send_notification",
    label: "Send Notification",
    description: "Validates a notification message and performs a deterministic local notification operation.",
    payloadExample: { recipient: "user@example.com", message: "Your report is ready." },
    handler: async (job) => {
      const parsed = sendNotificationPayload.safeParse(payloadObject(job));
      if (!parsed.success) return failed(job, "INVALID_NOTIFICATION_PAYLOAD", "Notification payload requires a recipient and message.");
      return completed(job);
    }
  },
  {
    type: "test.failure",
    label: "Intentional Failure Test",
    description: "Internal deterministic failure handler for development and lifecycle tests.",
    payloadExample: { message: "Internal test failure" },
    internal: true,
    handler: async (job) => {
      const payload = payloadObject(job);
      const message = typeof payload?.message === "string" && payload.message.trim() ? payload.message.trim() : "Intentional failure requested for lifecycle testing";
      return failed(job, "INTENTIONAL_FAILURE", message);
    }
  }
];

const handlerMap = new Map(handlers.map((definition) => [definition.type, definition]));

const customHandler: JobHandler = async (job) => completed(job);

export function registerJobHandler(type: string, handler: JobHandler): void {
  handlerMap.set(type, {
    type,
    label: type,
    description: "Project-registered executable job handler.",
    payloadExample: {},
    handler
  });
}

export function registerCustomJobType(type: string): void {
  registerJobHandler(type, customHandler);
}

export function getJobHandlerDefinitions() {
  return handlers.filter((definition) => !definition.internal).map(({ handler: _handler, ...definition }) => definition);
}

export function resolveJobHandler(jobType: string): JobHandler {
  const definition = handlerMap.get(jobType);
  if (!definition) {
    return async (job) => failed(job, "UNSUPPORTED_JOB_TYPE", `No handler is registered for job type '${jobType}'.`);
  }
  return definition.handler;
}

export const registeredJobHandler: JobHandler = async (job) => resolveJobHandler(job.jobType)(job);
