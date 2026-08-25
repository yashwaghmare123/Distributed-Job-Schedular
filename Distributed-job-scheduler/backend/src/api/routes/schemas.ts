import { z } from "zod";

export const jobCreateSchema = z.object({
  jobType: z.string().min(1).max(200),
  payload: z.any(),
  priority: z.number().int().safe().optional(),
  scheduledAt: z.string().datetime().optional(),
  maxAttempts: z.number().int().min(1).max(50).optional(),
  idempotencyKey: z.string().max(255).optional()
});

export const batchJobSchema = z.object({
  jobType: z.string().min(1).max(200),
  payload: z.any(),
  priority: z.number().int().safe().optional(),
  scheduledAt: z.string().datetime().optional(),
  maxAttempts: z.number().int().min(1).max(50).optional(),
  idempotencyKey: z.string().max(255).optional()
});

export const scheduledJobCreateSchema = z.object({
  jobType: z.string().min(1).max(200),
  payload: z.any(),
  cronExpression: z.string().min(1).max(200),
  nextRunAt: z.string().datetime().optional(),
  enabled: z.boolean().optional()
});

export const scheduledJobUpdateSchema = scheduledJobCreateSchema.partial();

export const retryPolicySchema = z.object({
  name: z.string().min(1).max(200),
  strategy: z.enum(["FIXED", "LINEAR", "EXPONENTIAL"]),
  maxAttempts: z.number().int().min(1).max(50),
  initialDelayMs: z.number().int().min(0).safe(),
  maxDelayMs: z.number().int().min(0).safe(),
  backoffMultiplier: z.number().positive(),
  jitter: z.boolean().optional()
});

export const jobQueueSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable(),
  defaultPriority: z.number().int().safe().optional(),
  concurrencyLimit: z.number().int().min(1).max(1000),
  isPaused: z.boolean().optional(),
  retryPolicyId: z.string().uuid()
});
