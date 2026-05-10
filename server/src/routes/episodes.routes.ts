import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { getEpisode } from "../controllers/episodes.controller";

export const episodesRouter = new Hono<{ Variables: AuthVariables }>();

episodesRouter.get("/:id", getEpisode);
