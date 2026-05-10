import type { Context } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { ingestSchema } from "../validators/ingest.validator";
import {
  createEpisode,
  SessionNotFoundError,
} from "../services/episodes.service";

export async function ingest(c: Context<{ Variables: AuthVariables }>) {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = ingestSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const episode = await createEpisode(userId, parsed.data);
    return c.json(
      { episodeId: episode.id, status: episode.status },
      202,
    );
  } catch (err) {
    if (err instanceof SessionNotFoundError) {
      return c.json({ error: "SESSION_NOT_FOUND" }, 404);
    }
    throw err;
  }
}
