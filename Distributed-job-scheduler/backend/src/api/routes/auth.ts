import { Router } from "express";
import type { Response } from "express";
import { z } from "zod";
import { prisma } from "../../lib/prisma.js";
import {
  hashPassword,
  signAccessToken,
  signRefreshToken,
  verifyJwt,
  verifyPassword
} from "../lib/auth.js";
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
  refreshToken: z.string().min(1).optional()
});

const isProduction = process.env.NODE_ENV === "production";

const cookieOptions = (maxAge: number) => ({
  httpOnly: true,
  secure: isProduction,
  sameSite: isProduction ? ("none" as const) : ("lax" as const),
  path: "/",
  maxAge
});

function setAuthCookies(
  response: Response,
  accessToken: string,
  refreshToken: string
) {
  response.cookie(
    "scheduler.access",
    accessToken,
    cookieOptions(15 * 60 * 1000)
  );

  response.cookie(
    "scheduler.refresh",
    refreshToken,
    cookieOptions(7 * 24 * 60 * 60 * 1000)
  );
}

router.post("/register", authRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(
      registerSchema,
      request.body,
      "Invalid registration request"
    );

    const existing = await prisma.user.findUnique({
      where: { email: body.email }
    });

    if (existing) {
      throw new HttpError(
        409,
        "CONFLICT",
        "User with this email already exists."
      );
    }

    const user = await prisma.$transaction(async (tx) => {
      const createdUser = await tx.user.create({
        data: {
          email: body.email,
          name: body.name,
          passwordHash: await hashPassword(body.password)
        }
      });

      const organization = await tx.organization.create({
        data: {
          name: `${body.name}'s Organization`
        }
      });

      await tx.organizationMember.create({
        data: {
          organizationId: organization.id,
          userId: createdUser.id,
          role: "OWNER"
        }
      });

      return createdUser;
    });

    const orgIds = await prisma.organizationMember
      .findMany({
        where: { userId: user.id },
        select: { organizationId: true }
      })
      .then((rows) => rows.map((row) => row.organizationId));

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      organizationIds: orgIds
    });

    const refreshToken = signRefreshToken({
      id: user.id,
      email: user.email,
      organizationIds: orgIds
    });

    setAuthCookies(response, accessToken, refreshToken);

    response.status(201).json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      accessToken,
      refreshToken
    });
  } catch (error) {
    next(error);
  }
});

router.post("/login", authRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(
      loginSchema,
      request.body,
      "Invalid login request"
    );

    const user = await prisma.user.findUnique({
      where: { email: body.email }
    });

    if (!user) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Invalid credentials."
      );
    }

    const valid = await verifyPassword(
      body.password,
      user.passwordHash
    );

    if (!valid) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Invalid credentials."
      );
    }

    const orgIds = await prisma.organizationMember
      .findMany({
        where: { userId: user.id },
        select: { organizationId: true }
      })
      .then((rows) => rows.map((row) => row.organizationId));

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      organizationIds: orgIds
    });

    const refreshToken = signRefreshToken({
      id: user.id,
      email: user.email,
      organizationIds: orgIds
    });

    setAuthCookies(response, accessToken, refreshToken);

    response.json({
      user: {
        id: user.id,
        email: user.email,
        name: user.name
      },
      accessToken,
      refreshToken
    });
  } catch (error) {
    next(error);
  }
});

router.post("/refresh", authRateLimit, async (request, response, next) => {
  try {
    const body = parseRequest(
      refreshSchema,
      request.body ?? {},
      "Invalid refresh request"
    );

    const cookieToken = request.headers.cookie
      ?.split(";")
      .map((part) => part.trim())
      .find((part) => part.startsWith("scheduler.refresh="))
      ?.slice("scheduler.refresh=".length);

    const refreshToken =
      body.refreshToken ??
      (cookieToken ? decodeURIComponent(cookieToken) : undefined);

    if (!refreshToken) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Invalid refresh token."
      );
    }

    let token;

    try {
      token = verifyJwt(refreshToken);
    } catch {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Invalid refresh token."
      );
    }

    if (token.type !== "refresh") {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Invalid refresh token."
      );
    }

    const user = await prisma.user.findUnique({
      where: { id: token.sub }
    });

    if (!user) {
      throw new HttpError(
        401,
        "UNAUTHORIZED",
        "Invalid refresh token."
      );
    }

    const orgIds = await prisma.organizationMember
      .findMany({
        where: { userId: user.id },
        select: { organizationId: true }
      })
      .then((rows) => rows.map((row) => row.organizationId));

    const accessToken = signAccessToken({
      id: user.id,
      email: user.email,
      organizationIds: orgIds
    });

    const rotatedRefreshToken = signRefreshToken({
      id: user.id,
      email: user.email,
      organizationIds: orgIds
    });

    setAuthCookies(
      response,
      accessToken,
      rotatedRefreshToken
    );

    response.json({
      accessToken,
      refreshToken: rotatedRefreshToken
    });
  } catch (error) {
    next(error);
  }
});

router.post("/logout", (_request, response) => {
  response.clearCookie("scheduler.access", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/"
  });

  response.clearCookie("scheduler.refresh", {
    httpOnly: true,
    secure: isProduction,
    sameSite: isProduction ? "none" : "lax",
    path: "/"
  });

  response.status(204).send();
});

router.get("/session", requireAuth, async (request, response) => {
  response.json({
    user: request.user
  });
});

router.post(
  "/api-keys",
  requireAuth,
  writeRateLimit,
  async (request, response, next) => {
    try {
      const body = parseRequest(
        z.object({
          name: z.string().min(1).max(200),
          expiresAt: z.string().datetime().optional()
        }),
        request.body,
        "Invalid API key request"
      );

      const organizationId =
        request.user!.organizationIds[0];

      if (!organizationId) {
        throw new HttpError(
          403,
          "FORBIDDEN",
          "No organization is available for this user."
        );
      }

      const secret = createApiKeySecret();

      const key = await prisma.apiKey.create({
        data: {
          organizationId,
          name: body.name,
          keyHash: hashApiKey(secret),
          ...(body.expiresAt
            ? { expiresAt: new Date(body.expiresAt) }
            : {})
        },
        select: {
          id: true,
          name: true,
          organizationId: true,
          expiresAt: true,
          createdAt: true
        }
      });

      response.status(201).json({
        ...key,
        apiKey: secret
      });
    } catch (error) {
      next(error);
    }
  }
);

export default router;









// import { Router } from "express";
// import type { Response } from "express";
// import { z } from "zod";
// import { prisma } from "../../lib/prisma.js";
// import { hashPassword, signAccessToken, signRefreshToken, verifyJwt, verifyPassword } from "../lib/auth.js";
// import { HttpError } from "../lib/errors.js";
// import { parseRequest } from "../lib/validation.js";
// import { requireAuth } from "../middleware/auth.js";
// import { createApiKeySecret, hashApiKey } from "../lib/apiKeys.js";
// import { authRateLimit, writeRateLimit } from "../middleware/rateLimit.js";

// const router = Router();

// const registerSchema = z.object({
//   name: z.string().min(1),
//   email: z.email(),
//   password: z.string().min(8)
// });

// const loginSchema = z.object({
//   email: z.email(),
//   password: z.string().min(8)
// });

// const refreshSchema = z.object({
//   refreshToken: z.string().min(1).optional()
// });

// const cookieOptions = (maxAge: number) => ({ httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax" as const, path: "/", maxAge });
// function setAuthCookies(response: Response, accessToken: string, refreshToken: string) {
//   response.cookie("scheduler.access", accessToken, cookieOptions(15 * 60 * 1000));
//   response.cookie("scheduler.refresh", refreshToken, cookieOptions(7 * 24 * 60 * 60 * 1000));
// }

// router.post("/register", authRateLimit, async (request, response, next) => {
//   try {
//     const body = parseRequest(registerSchema, request.body, "Invalid registration request");

//     const existing = await prisma.user.findUnique({ where: { email: body.email } });
//     if (existing) {
//       throw new HttpError(409, "CONFLICT", "User with this email already exists.");
//     }

//     const user = await prisma.$transaction(async (tx) => {
//       const createdUser = await tx.user.create({
//         data: {
//           email: body.email,
//           name: body.name,
//           passwordHash: await hashPassword(body.password)
//         }
//       });

//       const organization = await tx.organization.create({ data: { name: `${body.name}'s Organization` } });
//       await tx.organizationMember.create({ data: { organizationId: organization.id, userId: createdUser.id, role: "OWNER" } });
//       return createdUser;
//     });

//     const orgIds = await prisma.organizationMember.findMany({
//       where: { userId: user.id },
//       select: { organizationId: true }
//     }).then((rows) => rows.map((row) => row.organizationId));

//     const accessToken = signAccessToken({ id: user.id, email: user.email, organizationIds: orgIds });
//     const refreshToken = signRefreshToken({ id: user.id, email: user.email, organizationIds: orgIds });
//     setAuthCookies(response, accessToken, refreshToken);
//     response.status(201).json({
//       user: { id: user.id, email: user.email, name: user.name },
//       accessToken,
//       refreshToken
//     });
//   } catch (error) {
//     next(error);
//   }
// });

// router.post("/login", authRateLimit, async (request, response, next) => {
//   try {
//     const body = parseRequest(loginSchema, request.body, "Invalid login request");

//     const user = await prisma.user.findUnique({ where: { email: body.email } });
//     if (!user) {
//       throw new HttpError(401, "UNAUTHORIZED", "Invalid credentials.");
//     }

//     const valid = await verifyPassword(body.password, user.passwordHash);
//     if (!valid) {
//       throw new HttpError(401, "UNAUTHORIZED", "Invalid credentials.");
//     }

//     const orgIds = await prisma.organizationMember.findMany({
//       where: { userId: user.id },
//       select: { organizationId: true }
//     }).then((rows) => rows.map((row) => row.organizationId));

//     const accessToken = signAccessToken({ id: user.id, email: user.email, organizationIds: orgIds });
//     const refreshToken = signRefreshToken({ id: user.id, email: user.email, organizationIds: orgIds });
//     setAuthCookies(response, accessToken, refreshToken);
//     response.json({
//       user: { id: user.id, email: user.email, name: user.name },
//       accessToken,
//       refreshToken
//     });
//   } catch (error) {
//     next(error);
//   }
// });

// router.post("/refresh", authRateLimit, async (request, response, next) => {
//   try {
//     const body = parseRequest(refreshSchema, request.body ?? {}, "Invalid refresh request");
//     const cookieToken = request.headers.cookie?.split(";").map((part) => part.trim()).find((part) => part.startsWith("scheduler.refresh="))?.slice("scheduler.refresh=".length);
//     const refreshToken = body.refreshToken ?? (cookieToken ? decodeURIComponent(cookieToken) : undefined);
//     if (!refreshToken) throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
//     let token;
//     try {
//       token = verifyJwt(refreshToken);
//     } catch {
//       throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
//     }
//     if (token.type !== "refresh") {
//       throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
//     }

//     const user = await prisma.user.findUnique({ where: { id: token.sub } });
//     if (!user) {
//       throw new HttpError(401, "UNAUTHORIZED", "Invalid refresh token.");
//     }

//     const orgIds = await prisma.organizationMember.findMany({
//       where: { userId: user.id },
//       select: { organizationId: true }
//     }).then((rows) => rows.map((row) => row.organizationId));

//     const accessToken = signAccessToken({ id: user.id, email: user.email, organizationIds: orgIds });
//     const rotatedRefreshToken = signRefreshToken({ id: user.id, email: user.email, organizationIds: orgIds });
//     setAuthCookies(response, accessToken, rotatedRefreshToken);
//     response.json({ accessToken, refreshToken: rotatedRefreshToken });
//   } catch (error) {
//     next(error);
//   }
// });

// router.post("/logout", (_request, response) => {
//   response.clearCookie("scheduler.access", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
//   response.clearCookie("scheduler.refresh", { httpOnly: true, secure: process.env.NODE_ENV === "production", sameSite: "lax", path: "/" });
//   response.status(204).send();
// });

// router.get("/session", requireAuth, async (request, response) => {
//   response.json({ user: request.user });
// });

// router.post("/api-keys", requireAuth, writeRateLimit, async (request, response, next) => {
//   try {
//     const body = parseRequest(
//       z.object({ name: z.string().min(1).max(200), expiresAt: z.string().datetime().optional() }),
//       request.body,
//       "Invalid API key request"
//     );
//     const organizationId = request.user!.organizationIds[0];
//     if (!organizationId) throw new HttpError(403, "FORBIDDEN", "No organization is available for this user.");

//     const secret = createApiKeySecret();
//     const key = await prisma.apiKey.create({
//       data: {
//         organizationId,
//         name: body.name,
//         keyHash: hashApiKey(secret),
//         ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {})
//       },
//       select: { id: true, name: true, organizationId: true, expiresAt: true, createdAt: true }
//     });

//     response.status(201).json({ ...key, apiKey: secret });
//   } catch (error) {
//     next(error);
//   }
// });

// export default router;
