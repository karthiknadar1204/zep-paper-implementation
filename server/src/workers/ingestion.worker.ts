import { Worker, type Job } from "bullmq";
import { eq } from "drizzle-orm";
import { db } from "../models/db";
import { episodes, processingLogs } from "../models/schema";
import {
  INGESTION_QUEUE_NAME,
  type IngestionJobData,
} from "../queues/ingestion.queue";
import { redisConnection } from "../queues/connection";
import {
  fetchEpisodeById,
  getRecentMessages,
} from "../services/episodes.service";
import {
  extractEntities,
  extractFacts,
} from "../services/extraction.service";
import {
  resolveEntities,
  getOrCreateSelfEntity,
} from "../services/resolver.service";
import { applyTemporalFacts } from "../services/temporal.service";
import {
  upsertEntityVectors,
  upsertFactVectors,
} from "../services/pinecone.service";
import {
  createEpisodeNode,
  linkEpisodeToEntities,
} from "../services/neo4j.service";

async function logStep(
  episodeId: string,
  stepName: string,
  status: "ok" | "error",
  durationMs: number,
  message?: string,
) {
  await db.insert(processingLogs).values({
    episodeId,
    step: stepName,
    status,
    durationMs,
    message: message ?? null,
  });
}

async function step<T>(
  episodeId: string,
  stepName: string,
  fn: () => Promise<T>,
): Promise<T> {
  const t0 = Date.now();
  try {
    const result = await fn();
    await logStep(episodeId, stepName, "ok", Date.now() - t0);
    return result;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    await logStep(episodeId, stepName, "error", Date.now() - t0, msg);
    throw err;
  }
}

async function processEpisode(job: Job<IngestionJobData>) {
  const { episodeId } = job.data;

  await db
    .update(episodes)
    .set({ status: "processing" })
    .where(eq(episodes.id, episodeId));

  const episode = await step(episodeId, "fetch_episode", async () => {
    const ep = await fetchEpisodeById(episodeId);
    if (!ep) throw new Error("episode not found");
    return ep;
  });

  const recent = await step(episodeId, "fetch_recent", () =>
    getRecentMessages(episode.sessionId, 6, episodeId),
  );

  const currentMsg = { actor: episode.actor, content: episode.content };

  const rawEntities = await step(episodeId, "extract_entities", () =>
    extractEntities(currentMsg, recent),
  );

  const resolved = await step(episodeId, "resolve_entities", () =>
    resolveEntities(episode.userId, rawEntities),
  );

  const self = await step(episodeId, "get_self_entity", () =>
    getOrCreateSelfEntity(episode.userId),
  );

  const allEntities = [self, ...resolved];

  const factsResult = await step(episodeId, "extract_facts", () =>
    extractFacts(currentMsg, recent, allEntities),
  );

  const occurredAtIso = episode.occurredAt.toISOString();

  const temporal = await step(episodeId, "apply_temporal", () =>
    applyTemporalFacts(
      factsResult.facts,
      factsResult.invalidations,
      episodeId,
      occurredAtIso,
    ),
  );

  await step(episodeId, "upsert_entity_vectors", () =>
    upsertEntityVectors(resolved),
  );

  await step(episodeId, "upsert_fact_vectors", () =>
    upsertFactVectors(episode.userId, temporal.written),
  );

  await step(episodeId, "create_episode_node", () =>
    createEpisodeNode({
      episodeId,
      userId: episode.userId,
      sessionId: episode.sessionId,
      actor: episode.actor,
      content: episode.content,
      occurredAt: occurredAtIso,
    }),
  );

  await step(episodeId, "link_episode_entities", () =>
    linkEpisodeToEntities(
      episodeId,
      allEntities.map((e) => e.entityId),
      occurredAtIso,
    ),
  );

  await db
    .update(episodes)
    .set({ status: "processed", processedAt: new Date() })
    .where(eq(episodes.id, episodeId));
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

  const isFinalAttempt = job.attemptsMade >= (job.opts.attempts ?? 1);
  if (isFinalAttempt) {
    await db
      .update(episodes)
      .set({ status: "failed" })
      .where(eq(episodes.id, job.data.episodeId));
  }
});

console.log(`[worker] listening on ${INGESTION_QUEUE_NAME}`);
