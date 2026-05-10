import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import {
  createSession,
  listSessions,
} from "../controllers/sessions.controller";

export const sessionsRouter = new Hono<{ Variables: AuthVariables }>();

sessionsRouter.post("/", createSession);
sessionsRouter.get("/", listSessions);
