import jwt from "jsonwebtoken";
import bcrypt from "bcrypt";

export type AppJwtPayload = {
  sub: string;
  email: string;
  type: "access" | "refresh";
  orgIds: string[];
  iat?: number;
  exp?: number;
};

const secret = process.env.JWT_SECRET ?? "dev-secret-change-me";

export function hashPassword(password: string) {
  return bcrypt.hash(password, 12);
}

export function verifyPassword(password: string, hash: string) {
  return bcrypt.compare(password, hash);
}

export function signAccessToken(user: { id: string; email: string; organizationIds: string[] }) {
  return jwt.sign({ sub: user.id, email: user.email, type: "access", orgIds: user.organizationIds }, secret, {
    expiresIn: "15m"
  });
}

export function signRefreshToken(user: { id: string; email: string; organizationIds: string[] }) {
  return jwt.sign({ sub: user.id, email: user.email, type: "refresh", orgIds: user.organizationIds }, secret, {
    expiresIn: "7d"
  });
}

export function verifyJwt(token: string): AppJwtPayload {
  const payload = jwt.verify(token, secret) as AppJwtPayload;
  if (!payload.sub || !payload.email || !payload.type || !Array.isArray(payload.orgIds)) {
    throw new Error("Invalid token payload");
  }
  return payload;
}
