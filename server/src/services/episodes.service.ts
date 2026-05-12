import { and, asc, desc, eq, ne } from "drizzle-orm";
import { db } from "../models/db";
import { sessions, episodes, processingLogs } from "../models/schema";
import { enqueueEpisodeProcessing } from "../queues/ingestion.queue";

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
  type?: "message" | "text" | "json";
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
  // Episode type stored in metadata jsonb (no schema migration) — default
  // "message". The worker reads this via episodeType() below.
  const metadata = input.type ? { type: input.type } : null;

  const [row] = await db
    .insert(episodes)
    .values({
      userId,
      sessionId: input.sessionId,
      actor: input.actor,
      content: input.content,
      occurredAt,
      metadata,
    })
    .returning();

  await enqueueEpisodeProcessing(row.id);

  return row;
}

export function episodeType(ep: EpisodeRow): "message" | "text" | "json" {
  const meta = ep.metadata as { type?: unknown } | null | undefined;
  const t = meta?.type;
  if (t === "text" || t === "json" || t === "message") return t;
  return "message";
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

export async function fetchEpisodeById(
  episodeId: string,
): Promise<EpisodeRow | null> {
  const [row] = await db
    .select()
    .from(episodes)
    .where(eq(episodes.id, episodeId))
    .limit(1);
  return row ?? null;
}

export type RecentMessage = {
  actor: "user" | "assistant" | "system";
  content: string;
  occurredAt: Date;
};

export async function getRecentMessages(
  sessionId: string,
  limit: number,
  excludeEpisodeId?: string,
): Promise<RecentMessage[]> {
  const where = excludeEpisodeId
    ? and(eq(episodes.sessionId, sessionId), ne(episodes.id, excludeEpisodeId))
    : eq(episodes.sessionId, sessionId);

  const rows = await db
    .select({
      actor: episodes.actor,
      content: episodes.content,
      occurredAt: episodes.occurredAt,
    })
    .from(episodes)
    .where(where)
    .orderBy(desc(episodes.occurredAt))
    .limit(limit);

  return rows.reverse();
}
