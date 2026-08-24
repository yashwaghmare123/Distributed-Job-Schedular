import { Router } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import { hashPassword, signAccessToken, signRefreshToken, verifyJwt, verifyPassword } from "../lib/auth.js";
import { HttpError } from "../lib/errors.js";
import { parseRequest } from "../lib/validation.js";
import { requireAuth } from "../middleware/auth.js";
import { createApiKeySecret, hashApiKey } from "../lib/apiKeys.js";
import { authRateLimit, writeRateLimit } from "../middleware/rateLimit.js";

const router = Router();

const registerSchema = z.object({
  name: z.string().min(1),
  email: z.email(),
  password: z.string().min(8)
});

const loginSchema = z.object({
  email: z.email(),
  password: z.string().min(8)
});

const refreshSchema = z.object({
  refreshToken: z.string().min(1)
});

router.post("/register", authRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(registerSchema, request.body, "Invalid registration request");

    const existing = await prisma.user.findUnique({ where: { email: body.email } });
    if (existing) {
      throw new HttpError(409, "CONFLICT", "User with this email already exists.");
    }

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: body.email,
          name: body.name,
          passwordHash: await hashPassword(body.password)
        }
      });

      const organization = await tx.organization.create({ data: { name: `${body.name}'s Organization` } });
      await tx.organizationMember.create({ data: { organizationId: organization.id, userId: createdUser.id, role: "OWNER" } });
      return createdUser;
    });

    const orgIds = await prisma.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true }
    }).then((rows) => rows.map((row) => row.organizationId));

    response.status(201).json({
      user: { id: user.id, email: user.email, name: user.name },
      accessToken: signAccessToken({ id: user.id, email: user.email, organizationIds: orgIds }),
      refreshToken: signRefreshToken({ id: user.id, email: user.email, organizationIds: orgIds })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/login", authRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(loginSchema, request.body, "Invalid login request");

    const user = await prisma.user.findUnique({ where: { email: body.email } });
    if (!user) {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid credentials.");
    }

    const valid = await verifyPassword(body.password, user.passwordHash);
    if (!valid) {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid credentials.");
    }

    const orgIds = await prisma.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true }
    }).then((rows) => rows.map((row) => row.organizationId));

    response.json({
      user: { id: user.id, email: user.email, name: user.name },
      accessToken: signAccessToken({ id: user.id, email: user.email, organizationIds: orgIds }),
      refreshToken: signRefreshToken({ id: user.id, email: user.email, organizationIds: orgIds })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/refresh", authRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(refreshSchema, request.body, "Invalid refresh request");
    let token;
    try {
      token = verifyJwt(body.refreshToken);
    } catch {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
    }
    if (token.type !== "refresh") {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
    }

    const user = await prisma.user.findUnique({ where: { id: token.sub } });
    if (!user) {
      throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
    }

    const orgIds = await prisma.organizationMember.findMany({
      where: { userId: user.id },
      select: { organizationId: true }
    }).then((rows) => rows.map((row) => row.organizationId));

    response.json({
      accessToken: signAccessToken({ id: user.id, email: user.email, organizationIds: orgIds }),
      refreshToken: signRefreshToken({ id: user.id, email: user.email, organizationIds: orgIds })
    });
  } catch (error) {
    next(error);
  }
});

router.post("/api-keys", requireAuth, writeRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(
      z.object({ name: z.string().min(1).max(200), expiresAt: z.string().datetime().optional() }),
      request.body,
      "Invalid API key request"
    );
    const organizationId = request.user!.organizationIds[0];
    if (!organizationId) throw new HttpError(403, "FORBIDDEN", "No organization is available for this user.");

    const secret = createApiKeySecret();
    const key = await prisma.apiKey.create({
      data: {
        organizationId,
        name: body.name,
        keyHash: hashApiKey(secret),
        ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {})
      },
      select: { id: true, name: true, organizationId: true, expiresAt: true, createdAt: true }
    });

    response.status(201).json({ ...key, apiKey: secret });
  } catch (error) {
    next(error);
  }
});

export default router;
