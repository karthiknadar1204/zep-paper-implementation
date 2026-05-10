import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { retrieve } from "../controllers/retrieve.controller";

export const retrieveRouter = new Hono<{ Variables: AuthVariables }>();

retrieveRouter.post("/", retrieve);
