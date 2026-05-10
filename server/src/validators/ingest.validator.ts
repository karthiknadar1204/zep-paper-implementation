import { z } from "zod";

export const ingestSchema = z.object({
  sessionId: z.uuid(),
  actor: z.enum(["user", "assistant", "system"]),
  content: z.string().min(1).max(50000),
  occurredAt: z.iso.datetime().optional(),
});

export type IngestInput = z.infer<typeof ingestSchema>;
