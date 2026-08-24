import { randomUUID } from "node:crypto";

export type LogContext = Record<string, unknown>;

const SENSITIVE_KEYS = new Set([
  "password",
  "token",
  "jwt",
  "authorization",
  "apiKey",
  "apikey",
  "x-api-key",
  "xapikey",
  "secret",
  "refreshToken",
  "accessToken",
  "refresh_token",
  "access_token",
  "cookie",
  "set-cookie"
]);

function redactValue(value: unknown): unknown {
  if (typeof value === "string") {
    return value.length > 0 ? "[REDACTED]" : value;
  }

  return "[REDACTED]";
}

function sanitizeValue(value: unknown, seen = new WeakSet<object>()): unknown {
  if (value === null || value === undefined) return value;
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) return value.map((item) => sanitizeValue(item, seen));
  if (typeof value === "object") {
    if (seen.has(value as object)) return "[Circular]";
    seen.add(value as object);
    const sanitized: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(value as Record<string, unknown>)) {
      if (SENSITIVE_KEYS.has(key.toLowerCase())) {
        sanitized[key] = redactValue(nested);
        continue;
      }
      sanitized[key] = sanitizeValue(nested, seen);
    }
    return sanitized;
  }

  return String(value);
}

export type Logger = {
  info: (message: string, context?: LogContext) => void;
  warn: (message: string, context?: LogContext) => void;
  error: (message: string, context?: LogContext) => void;
  withContext: (context: LogContext) => Logger;
};

function createLogger(baseContext: LogContext = {}): Logger {
  const emit = (level: "info" | "warn" | "error", message: string, context: LogContext = {}) => {
    const payload = sanitizeValue({
      timestamp: new Date().toISOString(),
      level,
      message,
      ...baseContext,
      ...context
    });

    console.log(JSON.stringify(payload));
  };

  return {
    info: (message, context) => emit("info", message, context ?? {}),
    warn: (message, context) => emit("warn", message, context ?? {}),
    error: (message, context) => emit("error", message, context ?? {}),
    withContext: (context) => createLogger({ ...baseContext, ...sanitizeValue(context) as LogContext })
  };
}

export const logger = createLogger();

export function requestIdHeaderValue(requestId?: string) {
  return requestId ?? randomUUID();
}

export function safeLogContext(context: LogContext = {}): LogContext {
  return sanitizeValue(context) as LogContext;
}
