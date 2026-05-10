import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../models/db";
import { episodes, processingLogs } from "../models/schema";
import {
  INGESTION_QUEUE_NAME,
  type IngestionJobData,
} from "../queues/ingestion.queue";
import { redisConnection } from "../queues/connection";

async function processEpisode(job: Job<IngestionJobData>) {
  const { episodeId } = job.data;
  const startedAt = Date.now();

  await db
    .update(episodes)
    .set({ status: "processing" })
    .where(eq(episodes.id, episodeId));

  // Pipeline steps land here in Phase E+ (LLM extract → resolve → facts → Neo4j + Pinecone).
  // For now the worker just transitions status so we can verify queue plumbing.

  await db
    .update(episodes)
    .set({ status: "processed", processedAt: new Date() })
    .where(eq(episodes.id, episodeId));

  await db.insert(processingLogs).values({
    episodeId,
    step: "stub-pipeline",
    status: "ok",
    durationMs: Date.now() - startedAt,
  });
}

const worker = new Worker<IngestionJobData>(
  INGESTION_QUEUE_NAME,
  processEpisode,
  {
    connection: redisConnection,
    concurrency: 4,
  },
);

worker.on("completed", (job) => {
  console.log(
    `[worker] completed ${job.id} (episode ${job.data.episodeId})`,
  );
});

worker.on("failed", async (job, err) => {
  console.error(`[worker] failed ${job?.id}:`, err.message);
  if (!job) return;

  await db.insert(processingLogs).values({
    episodeId: job.data.episodeId,
    step: "stub-pipeline",
    status: "error",
    message: err.message,
  });

  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isFinalAttempt) {
    await db
      .update(episodes)
      .set({ status: "failed" })
      .where(eq(episodes.id, job.data.episodeId));
  }
});

console.log(`[worker] listening on ${INGESTION_QUEUE_NAME}`);
