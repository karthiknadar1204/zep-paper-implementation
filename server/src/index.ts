import { Hono } from "hono";
import { logger } from "hono/logger";
import { cors } from "hono/cors";
import { authRouter } from "./routes/auth.routes";
import { sessionsRouter } from "./routes/sessions.routes";
import { ingestRouter } from "./routes/ingest.routes";
import { episodesRouter } from "./routes/episodes.routes";
import { retrieveRouter } from "./routes/retrieve.routes";
import {
  requireAuth,
  type AuthVariables,
} from "./middleware/auth.middleware";

const app = new Hono<{ Variables: AuthVariables }>();

app.use("*", logger());
app.use("*", cors());

app.get("/", (c) => c.text("Zep memory server"));

app.route("/auth", authRouter);

const protectedRoutes = new Hono<{ Variables: AuthVariables }>();
protectedRoutes.use("*", requireAuth);
protectedRoutes.get("/me", (c) => c.json({ userId: c.get("userId") }));
protectedRoutes.route("/sessions", sessionsRouter);
protectedRoutes.route("/ingest", ingestRouter);
protectedRoutes.route("/episodes", episodesRouter);
protectedRoutes.route("/retrieve", retrieveRouter);

app.route("/", protectedRoutes);

export default {
  port: 3002,
  fetch: app.fetch,
};
