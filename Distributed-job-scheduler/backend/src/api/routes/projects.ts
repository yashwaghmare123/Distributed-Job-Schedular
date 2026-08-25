import { Router } from "express";
import { Prisma } from "@prisma/client";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../lib/errors.js";
import { parseRequest, parseQueryPagination } from "../lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { readRateLimit, writeRateLimit } from "../middleware/rateLimit.js";
import { registerCustomJobType } from "../../core/jobHandlers.js";

const router = Router();

router.use(requireAuth);

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable()
});

const jobTypeSchema = z.object({
  jobType: z.string().trim().min(1).max(200),
  description: z.string().max(2000).optional().nullable()
});

async function requireProjectAdmin(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, organizationId: true } });
  if (!project) throw new HttpError(404, "NOT_FOUND", "Project not found.");

  const member = await prisma.organizationMember.findFirst({
    where: { organizationId: project.organizationId, userId, role: { in: ["OWNER", "ADMIN"] } }
  });
  if (!member) throw new HttpError(403, "FORBIDDEN", "Only organization owners/admins may manage projects.");
  return project;
}

router.get("/", readRateLimit, async (request, response, next) => {
  try {
    const user = request.user!;
    const memberRows = await prisma.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true }
    });
    const organizationIds = memberRows.map((row) => row.organizationId);
    const query = parseQueryPagination(request.query as Record<string, unknown>);

    const where = { organizationId: { in: organizationIds } };
    const [projects, total] = await Promise.all([
      prisma.project.findMany({ where, orderBy: [{ createdAt: "desc" }], skip: (query.page - 1) * query.limit, take: query.limit }),
      prisma.project.count({ where })
    ]);

    response.json({ data: projects, pagination: { page: query.page, limit: query.limit, hasMore: projects.length === query.limit, total, totalPages: Math.ceil(total / query.limit) } });
  } catch (error) {
    next(error);
  }
});

router.post("/", writeRateLimit, async (request, response, next) => {
  try {
    const user = request.user!;
    const body = parseRequest(projectSchema, request.body, "Invalid project request");

    const member = await prisma.organizationMember.findFirst({
      where: {
        userId: user.id,
        role: { in: ["OWNER", "ADMIN"] }
      },
      orderBy: { createdAt: "asc" }
    });
    if (!member) {
      throw new HttpError(403, "FORBIDDEN", "Only organization owners/admins may create projects.");
    }

    const project = await prisma.project.create({
      data: {
        organizationId: member.organizationId,
        name: body.name,
        description: body.description ?? null
      }
    });

    response.status(201).json(project);
  } catch (error) {
    next(error);
  }
});

router.patch("/:id", writeRateLimit, async (request, response, next) => {
  try {
    const projectId = parseRequest(z.string().uuid(), request.params.id, "Invalid project id");
    const body = parseRequest(projectSchema.partial(), request.body, "Invalid project update");
    await requireProjectAdmin(projectId, request.user!.id);

    const project = await prisma.project.update({
      where: { id: projectId },
      data: { ...(body.name !== undefined ? { name: body.name } : {}), ...(body.description !== undefined ? { description: body.description } : {}) }
    });
    response.json(project);
  } catch (error) {
    next(error);
  }
});

router.delete("/:id", writeRateLimit, async (request, response, next) => {
  try {
    const projectId = parseRequest(z.string().uuid(), request.params.id, "Invalid project id");
    await requireProjectAdmin(projectId, request.user!.id);
    const queueCount = await prisma.queue.count({ where: { projectId } });
    if (queueCount > 0) {
      throw new HttpError(409, "CONFLICT", "Project cannot be deleted while it contains queues.");
    }

    await prisma.project.delete({ where: { id: projectId } });
    response.status(204).send();
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2003") {
      next(new HttpError(409, "CONFLICT", "Project cannot be deleted while it contains related resources."));
      return;
    }
    next(error);
  }
});

router.get("/:projectId/job-types", readRateLimit, async (request, response, next) => {
  try {
    const projectId = parseRequest(z.string().uuid(), request.params.projectId, "Invalid project id");
    const project = await requireProjectMember(projectId, request.user!.id);
    const jobTypes = await prisma.projectJobType.findMany({ where: { projectId: project.id }, orderBy: { jobType: "asc" } });
    response.json({ data: jobTypes });
  } catch (error) {
    next(error);
  }
});

router.post("/:projectId/job-types", writeRateLimit, async (request, response, next) => {
  try {
    const projectId = parseRequest(z.string().uuid(), request.params.projectId, "Invalid project id");
    await requireProjectAdmin(projectId, request.user!.id);
    const body = parseRequest(jobTypeSchema, request.body, "Invalid job type request");
    const jobType = await prisma.projectJobType.create({ data: { projectId, jobType: body.jobType, description: body.description ?? null } });
    registerCustomJobType(jobType.jobType);
    response.status(201).json(jobType);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      next(new HttpError(409, "CONFLICT", "This job type is already registered in the project."));
      return;
    }
    next(error);
  }
});

router.patch("/:projectId/job-types/:jobTypeId", writeRateLimit, async (request, response, next) => {
  try {
    const projectId = parseRequest(z.string().uuid(), request.params.projectId, "Invalid project id");
    const jobTypeId = parseRequest(z.string().uuid(), request.params.jobTypeId, "Invalid job type id");
    await requireProjectAdmin(projectId, request.user!.id);
    const body = parseRequest(jobTypeSchema.partial(), request.body, "Invalid job type update");
    const current = await prisma.projectJobType.findUnique({ where: { id: jobTypeId } });
    if (!current || current.projectId !== projectId) throw new HttpError(404, "NOT_FOUND", "Job type not found.");
    const updated = await prisma.projectJobType.update({ where: { id: jobTypeId }, data: {
      ...(body.jobType === undefined ? {} : { jobType: body.jobType }),
      ...(body.description === undefined ? {} : { description: body.description })
    } });
    registerCustomJobType(updated.jobType);
    response.json(updated);
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === "P2002") {
      next(new HttpError(409, "CONFLICT", "This job type is already registered in the project."));
      return;
    }
    next(error);
  }
});

router.delete("/:projectId/job-types/:jobTypeId", writeRateLimit, async (request, response, next) => {
  try {
    const projectId = parseRequest(z.string().uuid(), request.params.projectId, "Invalid project id");
    const jobTypeId = parseRequest(z.string().uuid(), request.params.jobTypeId, "Invalid job type id");
    await requireProjectAdmin(projectId, request.user!.id);
    const current = await prisma.projectJobType.findUnique({ where: { id: jobTypeId }, select: { projectId: true } });
    if (!current || current.projectId !== projectId) throw new HttpError(404, "NOT_FOUND", "Job type not found.");
    await prisma.projectJobType.delete({ where: { id: jobTypeId } });
    response.status(204).send();
  } catch (error) {
    next(error);
  }
});

async function requireProjectMember(projectId: string, userId: string) {
  const project = await prisma.project.findUnique({ where: { id: projectId }, select: { id: true, organizationId: true } });
  if (!project) throw new HttpError(404, "NOT_FOUND", "Project not found.");
  const member = await prisma.organizationMember.findFirst({ where: { organizationId: project.organizationId, userId } });
  if (!member) throw new HttpError(403, "FORBIDDEN", "You do not have access to this project.");
  return project;
}

export default router;
