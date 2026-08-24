import { z } from "zod";
import { HttpError } from "./errors.js";

export const uuidSchema = z.string().uuid();
export const safePositiveIntSchema = z.coerce.number().int().min(1).max(100);
export const optionalUuidSchema = z.string().uuid().optional().nullable();

export function parseRequest<T>(schema: z.ZodType<T>, value: unknown, message = "Invalid request") {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw new HttpError(
      400,
      "VALIDATION_ERROR",
      message,
      parsed.error.issues.map((issue) => ({
        path: issue.path.join("."),
        message: issue.message
      }))
    );
  }
  return parsed.data;
}

export function parseQueryPagination(query: Record<string, unknown>) {
  const page = query.page === undefined ? 1 : Number(query.page);
  const limit = query.limit === undefined ? 25 : Number(query.limit);

  const parsedPage = z.coerce.number().int().min(1).safeParse(page);
  const parsedLimit = z.coerce.number().int().min(1).max(100).safeParse(limit);

  if (!parsedPage.success || !parsedLimit.success) {
    const details: Array<{ path: string; message: string }> = [];
    if (!parsedPage.success) {
      details.push({ path: "page", message: "Page must be a positive integer." });
    }
    if (!parsedLimit.success) {
      details.push({ path: "limit", message: "Limit must be between 1 and 100." });
    }

    throw new HttpError(400, "VALIDATION_ERROR", "Invalid pagination", details);
  }

  return { page: parsedPage.data, limit: parsedLimit.data };
}
