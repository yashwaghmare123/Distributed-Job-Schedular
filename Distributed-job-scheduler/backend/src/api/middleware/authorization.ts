import type { NextFunction, Request, Response } from "express";
import { HttpError } from "../lib/errors.js";
import { prisma } from "../../lib/prisma.js";

function asString(value: string | string[] | undefined): string | undefined {
  if (Array.isArray(value)) return value[0];
  return value;
}

export async function requireProjectMembership(request: Request, response: Response, next: NextFunction) {
  const projectId = asString(request.params.projectId ?? request.params.id);
  if (!projectId) return next(new HttpError(400, "VALIDATION_ERROR", "Invalid request", [{ path: "projectId", message: "Project id is required." }]));

  if (!request.user) return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));

  try {
    const project = await prisma.project.findUnique({
      where: { id: projectId },
      select: { id: true, organizationId: true }
    });

    if (!project) return next(new HttpError(404, "NOT_FOUND", "Project not found."));

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: project.organizationId, userId: request.user.id }
    });

    if (!member) return next(new HttpError(403, "FORBIDDEN", "You do not have access to this project."));
    return next();
  } catch {
    return next(new HttpError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function requireQueueMembership(request: Request, response: Response, next: NextFunction) {
  const queueId = asString(request.params.queueId ?? request.params.id);
  if (!queueId) return next(new HttpError(400, "VALIDATION_ERROR", "Invalid request", [{ path: "queueId", message: "Queue id is required." }]));

  if (!request.user) return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));

  try {
    const queue = await prisma.queue.findUnique({
      where: { id: queueId },
      include: { project: { select: { organizationId: true } } }
    });

    if (!queue) return next(new HttpError(404, "NOT_FOUND", "Queue not found."));

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: queue.project.organizationId, userId: request.user.id }
    });

    if (!member) return next(new HttpError(403, "FORBIDDEN", "You do not have access to this queue."));
    return next();
  } catch {
    return next(new HttpError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function requireJobMembership(request: Request, response: Response, next: NextFunction) {
  const jobId = asString(request.params.jobId ?? request.params.id);
  if (!jobId) return next(new HttpError(400, "VALIDATION_ERROR", "Invalid request", [{ path: "jobId", message: "Job id is required." }]));

  if (!request.user) return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));

  try {
    const job = await prisma.job.findUnique({
      where: { id: jobId },
      include: { queue: { include: { project: { select: { organizationId: true } } } } }
    });

    if (!job) return next(new HttpError(404, "NOT_FOUND", "Job not found."));

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: job.queue.project.organizationId, userId: request.user.id }
    });

    if (!member) return next(new HttpError(403, "FORBIDDEN", "You do not have access to this job."));
    return next();
  } catch {
    return next(new HttpError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function requireWorkerMembership(request: Request, response: Response, next: NextFunction) {
  const workerId = asString(request.params.workerId ?? request.params.id);
  if (!workerId) return next(new HttpError(400, "VALIDATION_ERROR", "Invalid request", [{ path: "workerId", message: "Worker id is required." }]));

  if (!request.user) return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));

  try {
    const worker = await prisma.worker.findUnique({
      where: { id: workerId },
      select: { id: true, organizationId: true }
    });

    if (!worker) return next(new HttpError(404, "NOT_FOUND", "Worker not found."));

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: worker.organizationId, userId: request.user.id }
    });

    if (!member) return next(new HttpError(403, "FORBIDDEN", "You do not have access to this worker."));
    return next();
  } catch {
    return next(new HttpError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}

export async function requireDlqMembership(request: Request, response: Response, next: NextFunction) {
  const jobId = asString(request.params.id);
  if (!jobId) return next(new HttpError(400, "VALIDATION_ERROR", "Invalid request", [{ path: "id", message: "DLQ entry id is required." }]));

  if (!request.user) return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));

  try {
    const entry = await prisma.deadLetterEntry.findUnique({
      where: { id: jobId },
      include: { job: { include: { queue: { include: { project: { select: { organizationId: true } } } } } } }
    });

    if (!entry) return next(new HttpError(404, "NOT_FOUND", "Dead-letter entry not found."));

    const member = await prisma.organizationMember.findFirst({
      where: { organizationId: entry.job.queue.project.organizationId, userId: request.user.id }
    });

    if (!member) return next(new HttpError(403, "FORBIDDEN", "You do not have access to this DLQ entry."));
    return next();
  } catch {
    return next(new HttpError(500, "INTERNAL_ERROR", "Internal server error"));
  }
}
