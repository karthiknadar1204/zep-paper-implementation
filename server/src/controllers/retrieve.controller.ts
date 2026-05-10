import type { Context } from "hono";
import type { AuthVariables } from "../middleware/auth.middleware";
import { retrieveSchema } from "../validators/retrieve.validator";
import { getContext } from "../services/retrieval.service";

export async function retrieve(c: Context<{ Variables: AuthVariables }>) {
  const userId = c.get("userId");
  const body = await c.req.json().catch(() => null);
  const parsed = retrieveSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", issues: parsed.error.issues },
      400,
    );
  }

  const result = await getContext({
    userId,
    query: parsed.data.query,
    sessionId: parsed.data.sessionId,
    asOf: parsed.data.asOf,
    limit: parsed.data.limit,
    vectorTopK: parsed.data.vectorTopK,
  });

  return c.json(result);
}
