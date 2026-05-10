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

function tag(episodeId: string): string {
  return `[${episodeId.slice(0, 8)}]`;
}

function nameById(
  list: Array<{ entityId: string; name: string }>,
  id: string,
): string {
  return list.find((e) => e.entityId === id)?.name ?? "?";
}

async function processEpisode(job: Job<IngestionJobData>) {
  const { episodeId } = job.data;
  const t = tag(episodeId);
  const startedAt = Date.now();

  await db
    .update(episodes)
    .set({ status: "processing" })
    .where(eq(episodes.id, episodeId));

  const episode = await step(episodeId, "fetch_episode", async () => {
    const ep = await fetchEpisodeById(episodeId);
    if (!ep) throw new Error("episode not found");
    return ep;
  });
  const preview =
    episode.content.length > 70
      ? `${episode.content.slice(0, 70)}...`
      : episode.content;
  console.log(`${t} start "${preview}"`);

  const recent = await step(episodeId, "fetch_recent", () =>
    getRecentMessages(episode.sessionId, 6, episodeId),
  );
  console.log(`${t} recent: ${recent.length} prior message(s) loaded`);

  const currentMsg = { actor: episode.actor, content: episode.content };

  const rawEntities = await step(episodeId, "extract_entities", () =>
    extractEntities(currentMsg, recent),
  );
  console.log(
    `${t} extracted ${rawEntities.length} entit${rawEntities.length === 1 ? "y" : "ies"}: ${
      rawEntities.length === 0
        ? "(none)"
        : rawEntities.map((e) => `${e.name}[${e.type}]`).join(", ")
    }`,
  );

  const resolved = await step(episodeId, "resolve_entities", () =>
    resolveEntities(episode.userId, rawEntities),
  );
  const newCount = resolved.filter((r) => r.isNew).length;
  console.log(
    `${t} resolved ${resolved.length} (${newCount} new): ${
      resolved.length === 0
        ? "(none)"
        : resolved
            .map((r) => `${r.name}${r.isNew ? "*" : ""}`)
            .join(", ")
    }`,
  );

  const self = await step(episodeId, "get_self_entity", () =>
    getOrCreateSelfEntity(episode.userId),
  );

  const allEntities = [self, ...resolved];

  const factsResult = await step(episodeId, "extract_facts", () =>
    extractFacts(currentMsg, recent, allEntities),
  );
  const factsLine =
    factsResult.facts.length === 0
      ? "(none)"
      : factsResult.facts
          .map(
            (f) =>
              `${nameById(allEntities, f.sourceEntityId)}-${f.relationType}->${nameById(allEntities, f.targetEntityId)}`,
          )
          .join(", ");
  const invLine =
    factsResult.invalidations.length === 0
      ? "(none)"
      : factsResult.invalidations
          .map(
            (i) =>
              `${nameById(allEntities, i.sourceEntityId)}-${i.relationType}->${nameById(allEntities, i.targetEntityId)}`,
          )
          .join(", ");
  console.log(`${t} facts (${factsResult.facts.length}): ${factsLine}`);
  console.log(
    `${t} invalidations (${factsResult.invalidations.length}): ${invLine}`,
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
  console.log(
    `${t} temporal: written=${temporal.written.length} closed=${temporal.closed.length} skipped=${temporal.skipped}`,
  );

  const entVecCount = await step(episodeId, "upsert_entity_vectors", () =>
    upsertEntityVectors(resolved),
  );
  const factVecCount = await step(episodeId, "upsert_fact_vectors", () =>
    upsertFactVectors(episode.userId, temporal.written),
  );
  console.log(
    `${t} pinecone: ${entVecCount} entity vector(s), ${factVecCount} fact vector(s) upserted`,
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
  console.log(
    `${t} graph: episode node + ${allEntities.length} :MENTIONS edge(s) written`,
  );

  await db
    .update(episodes)
    .set({ status: "processed", processedAt: new Date() })
    .where(eq(episodes.id, episodeId));

  console.log(`${t} done in ${Date.now() - startedAt}ms`);
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
