import express from "express";
import cors from "cors";
import helmet from "helmet";
import { randomUUID } from "node:crypto";
import authRouter from "./routes/auth.js";
import projectsRouter from "./routes/projects.js";
import apiRoutes from "./routes/queues.js";
import { apiErrorHandler, notFoundHandler } from "./lib/errors.js";
import { logger, type Logger } from "../lib/logger.js";
import { metricsText, metricsRegistry } from "../lib/metrics.js";
import { checkReadiness } from "../lib/readiness.js";
import { getJobHandlerDefinitions } from "../core/jobHandlers.js";
import { requireAuth } from "./middleware/auth.js";

export function createApp() {
  const app = express();
  app.disable("x-powered-by");
  app.use(cors({ origin: process.env.FRONTEND_ORIGIN ?? true, credentials: true }));
  app.use(helmet());
  app.use(express.json({ limit: "1mb" }));

  app.use((request, response, next) => {
    const requestId = (Array.isArray(request.headers["x-request-id"]) ? request.headers["x-request-id"][0] : request.headers["x-request-id"]) ?? randomUUID();
    const requestWithContext = request as typeof request & { requestId: string; log: Logger };
    requestWithContext.requestId = requestId;
    requestWithContext.log = logger.withContext({ requestId, method: request.method, route: request.path });
    response.setHeader("X-Request-ID", requestId);
    metricsRegistry.increment("http_requests_total");
    const started = Date.now();
    response.on("finish", () => {
      metricsRegistry.observe("http_request_duration_ms", Date.now() - started);
      if (response.statusCode >= 400) {
        metricsRegistry.increment("http_errors_total");
      }
      requestWithContext.log.info("request completed", {
        status: response.statusCode,
        durationMs: Date.now() - started,
        route: request.originalUrl
      });
    });
    next();
  });

  app.get("/health", (_request, response) => {
    response.status(200).json({ status: "ok" });
  });

  app.get("/ready", async (_request, response) => {
    const readiness = await checkReadiness();
    if (readiness.ok) {
      response.status(200).json({ status: "ok", database: readiness.database, redis: readiness.redis, websocket: readiness.websocket });
      return;
    }
    response.status(503).json({ status: "error", error: readiness.failures.join(", "), database: readiness.database, redis: readiness.redis, websocket: readiness.websocket });
  });

  app.get("/metrics", async (_request, response) => {
    response.type("text/plain; version=0.0.4");
    response.send(await metricsText());
  });

  app.use("/auth", authRouter);
  app.get("/job-handlers", requireAuth, (_request, response) => {
    response.json({ data: getJobHandlerDefinitions() });
  });
  app.use("/projects", projectsRouter);
  app.use(apiRoutes);

  app.use(notFoundHandler);
  app.use(apiErrorHandler);

  return app;
}
