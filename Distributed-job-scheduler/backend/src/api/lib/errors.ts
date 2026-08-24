import type { NextFunction, Request, Response } from "express";
import { logger, type Logger } from "../../lib/logger.js";

export type ApiErrorCode =
  | "VALIDATION_ERROR"
  | "UNAUTHORIZED"
  | "FORBIDDEN"
  | "NOT_FOUND"
  | "CONFLICT"
  | "RATE_LIMITED"
  | "INTERNAL_ERROR";

export type ApiErrorDetail = { path?: string; message: string };

export class HttpError extends Error {
  statusCode: number;
  code: ApiErrorCode;
  details?: ApiErrorDetail[] | undefined;

  constructor(statusCode: number, code: ApiErrorCode, message: string, details?: ApiErrorDetail[]) {
    super(message);
    this.name = "HttpError";
    this.statusCode = statusCode;
    this.code = code;
    this.details = details ?? undefined;
  }
}

export function notFoundHandler(request: Request, response: Response) {
  const requestWithContext = request as typeof request & { requestId: string; log?: Logger };
  const requestId = requestWithContext.requestId;
  logger.error("route not found", {
    requestId,
    method: request.method,
    route: request.originalUrl,
    status: 404,
    errorCode: "NOT_FOUND"
  });

  response.status(404).json({
    error: {
      code: "NOT_FOUND",
      message: "Resource not found"
    }
  });
}

export function apiErrorHandler(error: unknown, request: Request, response: Response, _next: NextFunction) {
  const requestWithContext = request as typeof request & { requestId: string; log?: Logger };
  const requestId = requestWithContext.requestId;
  const requestLogger = requestWithContext.log ?? logger.withContext({ requestId, method: request.method, route: request.originalUrl });

  if (error instanceof HttpError) {
    requestLogger.warn("api error", {
      requestId,
      method: request.method,
      route: request.originalUrl,
      status: error.statusCode,
      errorCode: error.code,
      message: error.message
    });

    const payload: { error: { code: ApiErrorCode; message: string; details?: ApiErrorDetail[] } } = {
      error: {
        code: error.code,
        message: error.message
      }
    };

    if (error.details && error.details.length > 0) {
      payload.error.details = error.details.filter((detail): detail is ApiErrorDetail => Boolean(detail));
    }

    response.status(error.statusCode).json(payload);
    return;
  }

  const message = error instanceof Error ? error.message : "Internal server error";
  requestLogger.error("unexpected api error", {
    requestId,
    method: request.method,
    route: request.originalUrl,
    status: 500,
    errorCode: "INTERNAL_ERROR",
    message
  });

  response.status(500).json({
    error: {
      code: "INTERNAL_ERROR",
      message: "Internal server error"
    }
  });
}
