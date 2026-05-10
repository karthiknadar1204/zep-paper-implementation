import { z } from "zod";

export const createSessionSchema = z.object({
  title: z.string().min(1).max(200).optional(),
});

export type CreateSessionInput = z.infer<typeof createSessionSchema>;
