import type { Context } from "hono";
import { z } from "zod";
import type { AuthVariables } from "../middleware/auth.middleware";
import { graphQuerySchema } from "../validators/graph.validator";
import {
  getUserGraph,
  getNodeDetail,
  GraphNodeNotFoundError,
} from "../services/graph.service";

export async function getGraph(c: Context<{ Variables: AuthVariables }>) {
  const userId = c.get("userId");
  const sessionIdQuery = c.req.query("sessionId");
  const parsed = graphQuerySchema.safeParse({
    sessionId: sessionIdQuery,
  });
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", issues: parsed.error.issues },
      400,
    );
  }
  const snapshot = await getUserGraph(userId, parsed.data.sessionId);
  return c.json(snapshot);
}

export async function getGraphNode(
  c: Context<{ Variables: AuthVariables }>,
) {
  const userId = c.get("userId");
  const idParam = c.req.param("id");
  const parsed = z.uuid().safeParse(idParam);
  if (!parsed.success) {
    return c.json({ error: "INVALID_ID" }, 400);
  }
  try {
    const detail = await getNodeDetail(userId, parsed.data);
    return c.json(detail);
  } catch (err) {
    if (err instanceof GraphNodeNotFoundError) {
      return c.json({ error: "NODE_NOT_FOUND" }, 404);
    }
    throw err;
  }
}
