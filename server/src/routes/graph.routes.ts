import { Hono } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { getGraph, getGraphNode } from "../controllers/graph.controller";

export const graphRouter = new Hono<{ Variables: AuthVariables }>();

graphRouter.get("/", getGraph);
graphRouter.get("/node/:id", getGraphNode);
