import { z } from "zod";

// Episode types per paper §2.1: message | text | JSON.
// Default is "message" — preserves existing client behavior.
export const EPISODE_TYPES = ["message", "text", "json"] as const;
export type EpisodeType = (typeof EPISODE_TYPES)[number];

export const ingestSchema = z.object({
  sessionId: z.uuid(),
  actor: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(50000),
  occurredAt: z.iso.datetime().optional(),
  type: z.enum(EPISODE_TYPES).optional(),
});

export type IngestInput = z.infer<typeof ingestSchema>;
