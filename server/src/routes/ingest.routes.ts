import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { ingest } from "../controllers/ingest.controller";

export const ingestRouter = new Hono<{ Variables: AuthVariables }>();

ingestRouter.post("/", ingest);
