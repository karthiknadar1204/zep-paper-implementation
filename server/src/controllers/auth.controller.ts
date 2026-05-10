import type { Context } from "hono";
import { signupSchema, loginSchema } from "../validators/auth.validator";
import {
  createUser,
  authenticateUser,
  EmailTakenError,
  InvalidCredentialsError,
} from "../services/auth.service";
import { signToken } from "../utils/auth";

export async function signup(c: Context) {
  const body = await c.req.json().catch(() => null);
  const parsed = signupSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const user = await createUser(parsed.data.email, parsed.data.password);
    const token = await signToken(user.id);
    return c.json({ token, userId: user.id, email: user.email }, 201);
  } catch (err) {
    if (err instanceof EmailTakenError) {
      return c.json({ error: "EMAIL_TAKEN" }, 409);
    }
    throw err;
  }
}

export async function login(c: Context) {
  const body = await c.req.json().catch(() => null);
  const parsed = loginSchema.safeParse(body);
  if (!parsed.success) {
    return c.json(
      { error: "VALIDATION_ERROR", issues: parsed.error.issues },
      400,
    );
  }

  try {
    const user = await authenticateUser(
      parsed.data.email,
      parsed.data.password,
    );
    const token = await signToken(user.id);
    return c.json({ token, userId: user.id, email: user.email });
  } catch (err) {
    if (err instanceof InvalidCredentialsError) {
      return c.json({ error: "INVALID_CREDENTIALS" }, 401);
    }
    throw err;
  }
}
