import { eq } from "drizzle-orm";
import { db } from "../models/db";
import { users } from "../models/schema";
import { hashPassword, verifyPassword } from "../utils/auth";

export class EmailTakenError extends Error {
  constructor() {
    super("EMAIL_TAKEN");
    this.name = "EmailTakenError";
  }
}

export class InvalidCredentialsError extends Error {
  constructor() {
    super("INVALID_CREDENTIALS");
    this.name = "InvalidCredentialsError";
  }
}

export type PublicUser = {
  id: string;
  email: string;
};

export async function createUser(
  email: string,
  password: string,
): Promise<PublicUser> {
  const existing = await db
    .select({ id: users.id })
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (existing.length > 0) {
    throw new EmailTakenError();
  }

  const passwordHash = await hashPassword(password);
  const [row] = await db
    .insert(users)
    .values({ email, passwordHash })
    .returning({ id: users.id, email: users.email });

  return row;
}

export async function authenticateUser(
  email: string,
  password: string,
): Promise<PublicUser> {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, email))
    .limit(1);

  if (!user) throw new InvalidCredentialsError();

  const ok = await verifyPassword(password, user.passwordHash);
  if (!ok) throw new InvalidCredentialsError();

  return { id: user.id, email: user.email };
}
