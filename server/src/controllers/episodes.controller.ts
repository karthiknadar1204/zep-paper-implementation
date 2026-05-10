import type { Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../middleware/auth.middleware";
import {
  getEpisodeWithLogs,
  EpisodeNotFoundError,
} from "../services/episodes.service";

export async function getEpisode(c: Context<{ Variables: AuthVariables }>) {
  const userId = c.get("userId");
  const idParam = c.req.param("id");
  const parsed = z.uuid().safeParse(idParam);
  if (!parsed.success) {
    return c.json({ error: "INVALID_ID" }, 400);
  }

  try {
    const { episode, logs } = await getEpisodeWithLogs(userId, parsed.data);
    return c.json({ episode, logs });
  } catch (err) {
    if (err instanceof EpisodeNotFoundError) {
      return c.json({ error: "EPISODE_NOT_FOUND" }, 404);
    }
    throw err;
  }
}
