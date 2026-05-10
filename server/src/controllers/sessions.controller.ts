import type { Context } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { createSessionSchema } from "../validators/sessions.validator";
import * as sessionsService from "../services/sessions.service";

export async function createSession(
  c: Context<{ Variables: AuthVariables }>,
) {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => ({}));
  const parsed = createSessionSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", issues: parsed.error.issues },
      400,
    );
  }

  const session = await sessionsService.createSession(
    userId,
    parsed.data.title,
  );
  return c.json({ session }, 201);
}

export async function listSessions(
  c: Context<{ Variables: AuthVariables }>,
) {
  const userId = c.get("userId");
  const items = await sessionsService.listSessionsForUser(userId);
  return c.json({ sessions: items });
}
