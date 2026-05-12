import { openai } from "../utils/openai";
import { pineconeIndex } from "../utils/pinecone";
import type { ResolvedEntity } from "./resolver.service";
import type { TemporalFact } from "./temporal.service";

const EMBEDDING_MODEL = "text-embedding-3-small";

export async function embed(text: string): Promise<number[]> {
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: text,
  });
  return response.data[0].embedding;
}

export async function embedMany(texts: string[]): Promise<number[][]> {
  if (texts.length === 0) return [];
  const response = await openai.embeddings.create({
    model: EMBEDDING_MODEL,
    input: texts,
  });
  return response.data.map((d) => d.embedding);
}

export async function upsertEntityVectors(
  entities: ResolvedEntity[],
): Promise<number> {
  const newOnes = entities.filter((e) => e.isNew);
  if (newOnes.length === 0) return 0;

  const texts = newOnes.map((e) => `${e.name}: ${e.summary}`);
  const vectors = await embedMany(texts);

  const records = newOnes.map((e, i) => ({
    id: e.entityId,
    values: vectors[i],
    metadata: {
      type: "entity",
      userId: e.userId,
      neo4jId: e.entityId,
      name: e.name,
      entityType: e.type,
    },
  }));

  await pineconeIndex.upsert({ records });
  return records.length;
}

// Metadata-only update for fact vectors whose underlying :FACT edge just got
// closed in Neo4j. Pinecone's `update` API patches metadata without touching
// the embedding, so we pay no embedding cost. Fail-soft: a Pinecone error here
// does NOT abort the ingestion — Neo4j is the source of truth, Pinecone metadata
// is just a recall-layer optimisation.
export type FactClosureUpdate = {
  factId: string;
  closedAt: string; // ISO timestamp = the new validUntil on the edge
};

export async function markFactVectorsClosed(
  closures: FactClosureUpdate[],
): Promise<number> {
  if (closures.length === 0) return 0;

  let successCount = 0;
  await Promise.all(
    closures.map(async (c) => {
      const validUntilMs = new Date(c.closedAt).getTime();
      if (!Number.isFinite(validUntilMs)) return;
      try {
        await pineconeIndex.update({
          id: c.factId,
          metadata: { isOpen: false, validUntilMs },
        });
        successCount++;
      } catch (err) {
        console.error(
          `[pinecone] failed to mark fact ${c.factId.slice(0, 8)} closed:`,
          err instanceof Error ? err.message : err,
        );
      }
    }),
  );
  return successCount;
}

export async function upsertFactVectors(
  userId: string,
  facts: TemporalFact[],
): Promise<number> {
  if (facts.length === 0) return 0;

  const texts = facts.map((f) => f.factText);
  const vectors = await embedMany(texts);

  const records = facts.map((f, i) => {
    // Mirror temporal data on the vector so coarse pruning can happen at the
    // vector layer (PLAN.md §4 / §6). Pinecone metadata only supports scalar
    // types — store as epoch-ms numbers; null becomes a sentinel "open" marker.
    const validFromMs = new Date(f.validFrom).getTime();
    const validUntilMs = f.validUntil
      ? new Date(f.validUntil).getTime()
      : null;
    return {
      id: f.factId,
      values: vectors[i],
      metadata: {
        type: "fact",
        userId,
        neo4jId: f.factId,
        sourceId: f.sourceEntityId,
        targetId: f.targetEntityId,
        relationType: f.relationType,
        factText: f.factText,
        validFromMs,
        isOpen: validUntilMs === null,
        ...(validUntilMs !== null ? { validUntilMs } : {}),
      },
    };
  });

  await pineconeIndex.upsert({ records });
  return records.length;
}

export type VectorMatch = {
  id: string;
  score: number | undefined;
  metadata: Record<string, unknown> | undefined;
};

export async function queryVectors(
  text: string,
  userId: string,
  topK: number = 10,
  extraFilter?: Record<string, unknown>,
): Promise<VectorMatch[]> {
  const vector = await embed(text);
  const filter: Record<string, unknown> = { userId };
  if (extraFilter) Object.assign(filter, extraFilter);

  const result = await pineconeIndex.query({
    vector,
    topK,
    filter,
    includeMetadata: true,
  });

  return (result.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata as Record<string, unknown> | undefined,
  }));
}

// Used by hybrid entity resolution (Tier 2.7) and semantic invalidation (2.8/2.9).
// Embeds the text once and queries Pinecone against an existing filter.
export async function queryVectorsByEmbedding(
  vector: number[],
  userId: string,
  topK: number = 10,
  extraFilter?: Record<string, unknown>,
): Promise<VectorMatch[]> {
  const filter: Record<string, unknown> = { userId };
  if (extraFilter) Object.assign(filter, extraFilter);

  const result = await pineconeIndex.query({
    vector,
    topK,
    filter,
    includeMetadata: true,
  });

  return (result.matches ?? []).map((m) => ({
    id: m.id,
    score: m.score,
    metadata: m.metadata as Record<string, unknown> | undefined,
  }));
}
