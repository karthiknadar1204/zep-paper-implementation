import { z } from "zod";

export const retrieveSchema = z.object({
  query: z.string().min(1).max(2000),
  sessionId: z.uuid().optional(),
  asOf: z.iso.datetime().optional(),
  limit: z.number().int().min(1).max(50).optional(),
  vectorTopK: z.number().int().min(1).max(100).optional(),
});

export type RetrieveInput = z.infer<typeof retrieveSchema>;
