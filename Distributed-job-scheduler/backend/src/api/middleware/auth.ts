import type { NextFunction, Request, Response } from "express";
import type { Logger } from "../../lib/logger.js";
import { HttpError } from "../lib/errors.js";
import { verifyJwt } from "../lib/auth.js";
import { hashApiKey } from "../lib/apiKeys.js";
import { prisma } from "../../lib/prisma.js";

export type AuthenticatedUser = {
  id: string;
  email: string;
  organizationIds: string[];
};

declare global {
  namespace Express {
    interface Request {
      user?: AuthenticatedUser;
      requestId: string;
      log: Logger;
    }
  }
}

export async function requireAuth(request: Request, _response: Response, next: NextFunction) {
  const authHeader = request.headers.authorization;
  const rawApiKey = request.headers["x-api-key"];
  const apiKey = Array.isArray(rawApiKey) ? rawApiKey[0] : rawApiKey;
  const cookieHeader = request.headers.cookie ?? "";
  const accessCookie = cookieHeader.split(";").map((part) => part.trim()).find((part) => part.startsWith("scheduler.access="))?.slice("scheduler.access=".length);
  if (!authHeader && !apiKey && !accessCookie) {
    return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));
  }

  if (apiKey || authHeader?.startsWith("ApiKey ")) {
    const secret = apiKey ?? authHeader!.replace(/^ApiKey\s+/i, "");
    try {
      const key = await prisma.apiKey.findUnique({
        where: { keyHash: hashApiKey(secret) },
        include: { organization: { include: { members: { where: { role: "OWNER" }, orderBy: { createdAt: "asc" }, take: 1 } } } }
      });
      const owner = key?.organization.members[0];
      if (!key || key.revokedAt || (key.expiresAt && key.expiresAt <= new Date()) || !owner) {
        return next(new HttpError(401, "UNAUTHORIZED", "Invalid or inactive API key."));
      }

      await prisma.apiKey.update({ where: { id: key.id }, data: { lastUsedAt: new Date() } });
      request.user = { id: owner.userId, email: "api-key@internal", organizationIds: [key.organizationId] };
      return next();
    } catch (error) {
      if (error instanceof HttpError) return next(error);
      return next(new HttpError(401, "UNAUTHORIZED", "Invalid or inactive API key."));
    }
  }

  if (!authHeader?.startsWith("Bearer ") && !accessCookie) {
    return next(new HttpError(401, "UNAUTHORIZED", "Authentication required."));
  }

  const token = authHeader?.startsWith("Bearer ") ? authHeader.replace(/^Bearer\s+/i, "") : decodeURIComponent(accessCookie!);

  try {
    const payload = verifyJwt(token);
    if (payload.type !== "access") {
      throw new Error("Refresh token is not valid for access");
    }

    request.user = {
      id: payload.sub,
      email: payload.email,
      organizationIds: payload.orgIds
    };
    return next();
  } catch {
    return next(new HttpError(401, "UNAUTHORIZED", "Invalid or expired access token."));
  }
}
