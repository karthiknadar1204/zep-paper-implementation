import type { MiddlewareHandler } from "hono";
import { verifyToken } from "../utils/auth";

export type AuthVariables = {
  userId: string;
};

export const requireAuth: MiddlewareHandler<{ Variables: AuthVariables }> =
  async (c, next) => {
    const authHeader = c.req.header("Authorization");
    if (!authHeader || !authHeader.startsWith("Bearer ")) {
      return c.json({ error: "UNAUTHORIZED" }, 401);
    }

    const token = authHeader.slice(7).trim();
    try {
      const payload = await verifyToken(token);
      c.set("userId", payload.userId);
      await next();
    } catch {
      return c.json({ error: "INVALID_TOKEN" }, 401);
    }
  };
