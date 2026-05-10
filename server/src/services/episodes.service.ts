import { and, asc, eq } from "drizzle-orm";
import { db } from "../models/db";
import { sessions, episodes, processingLogs } from "../models/schema";

export class SessionNotFoundError extends Error {
  constructor() {
    super("SESSION_NOT_FOUND");
    this.name = "SessionNotFoundError";
  }
}

export class EpisodeNotFoundError extends Error {
  constructor() {
    super("EPISODE_NOT_FOUND");
    this.name = "EpisodeNotFoundError";
  }
}

export type EpisodeRow = typeof episodes.$inferSelect;
export type ProcessingLogRow = typeof processingLogs.$inferSelect;

export type CreateEpisodeInput = {
  sessionId: string;
  actor: "user" | "assistant" | "system";
  content: string;
  occurredAt?: string;
};

export async function createEpisode(
  userId: string,
  input: CreateEpisodeInput,
): Promise<EpisodeRow> {
  const [session] = await db
    .select({ id: sessions.id })
    .from(sessions)
    .where(and(eq(sessions.id, input.sessionId), eq(sessions.userId, userId)))
    .limit(1);

  if (!session) {
    throw new SessionNotFoundError();
  }

  const occurredAt = input.occurredAt ? new Date(input.occurredAt) : new Date();

  const [row] = await db
    .insert(episodes)
    .values({
      userId,
      sessionId: input.sessionId,
      actor: input.actor,
      content: input.content,
      occurredAt,
    })
    .returning();

  return row;
}

export async function getEpisodeWithLogs(
  userId: string,
  episodeId: string,
): Promise<{ episode: EpisodeRow; logs: ProcessingLogRow[] }> {
  const [episode] = await db
    .select()
    .from(episodes)
    .where(and(eq(episodes.id, episodeId), eq(episodes.userId, userId)))
    .limit(1);

  if (!episode) throw new EpisodeNotFoundError();

  const logs = await db
    .select()
    .from(processingLogs)
    .where(eq(processingLogs.episodeId, episodeId))
    .orderBy(asc(processingLogs.createdAt));

  return { episode, logs };
}
