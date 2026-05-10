import { eq, desc } from "drizzle-orm";
import { db } from "../models/db";
import { sessions } from "../models/schema";

export type SessionRow = typeof sessions.$inferSelect;

export async function createSession(
  userId: string,
  title?: string,
): Promise<SessionRow> {
  const [row] = await db
    .insert(sessions)
    .values({ userId, title: title ?? null })
    .returning();
  return row;
}

export async function listSessionsForUser(
  userId: string,
): Promise<SessionRow[]> {
  return db
    .select()
    .from(sessions)
    .where(eq(sessions.userId, userId))
    .orderBy(desc(sessions.createdAt));
}
