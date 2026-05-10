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

export async function upsertFactVectors(
  userId: string,
  facts: TemporalFact[],
): Promise<number> {
  if (facts.length === 0) return 0;

  const texts = facts.map((f) => f.factText);
  const vectors = await embedMany(texts);

  const records = facts.map((f, i) => ({
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
    },
  }));

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
