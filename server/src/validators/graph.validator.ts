import { z } from "zod";

export const graphQuerySchema = z.object({
  sessionId: z.uuid().optional(),
});

export type GraphQueryInput = z.infer<typeof graphQuerySchema>;
