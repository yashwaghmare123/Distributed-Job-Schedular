import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { HttpError } from "../lib/errors.js";
import { parseRequest, parseQueryPagination } from "../lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { readRateLimit, writeRateLimit } from "../middleware/rateLimit.js";

const router = Router();

router.use(requireAuth);

const projectSchema = z.object({
  name: z.string().min(1).max(200),
  description: z.string().max(1000).optional().nullable()
});

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

export default router;
