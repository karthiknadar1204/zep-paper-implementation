import { Queue } from "bullmq";
import { redisConnection } from "./connection";

export const INGESTION_QUEUE_NAME = "memory-ingestion";

export type IngestionJobData = {
  episodeId: string;
};

export const ingestionQueue = new Queue<IngestionJobData>(
  INGESTION_QUEUE_NAME,
  {
    connection: redisConnection,
    defaultJobOptions: {
      attempts: 3,
      backoff: { type: "exponential", delay: 1000 },
      removeOnComplete: { age: 60 * 60 * 24 },
      removeOnFail: { age: 60 * 60 * 24 * 7 },
    },
  },
);

export async function enqueueEpisodeProcessing(episodeId: string) {
  return ingestionQueue.add(
    "process-episode",
    { episodeId },
    { jobId: episodeId },
  );
}
