import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  findEntitiesByIds,
  findEntitiesByNormalizedNames,
  normalizeEntityName,
  upsertEntities,
  upsertEntity,
  type GraphEntity,
} from "./neo4j.service";
import { embed, queryVectorsByEmbedding } from "./pinecone.service";
import type { RawEntity } from "./extraction.service";
import { openai } from "../utils/openai";

export type ResolvedEntity = GraphEntity & { isNew: boolean };

const LLM_RESOLVE_FLAG = "ZEP_LLM_ENTITY_RESOLVE";
const SEMANTIC_TOPK = 5;
const SEMANTIC_MIN_SCORE = 0.55;

const ENTITY_RESOLUTION_SYSTEM = `You decide whether a NEW entity extracted from a conversation is the same real-world entity as one of a small list of EXISTING entities.

Use the entity's name AND summary to judge. Duplicate entities may have different names ("Apple" vs "Apple Inc.", "Karthik" vs "Karthik Nadar"). Do NOT merge entities of clearly different types (e.g. a PERSON named "Apple" is not the COMPANY "Apple").

Return JSON exactly:
{ "is_duplicate": boolean, "existingEntityId": string|null, "canonicalName": string|null }

Rules:
1. If is_duplicate is false, set existingEntityId and canonicalName to null.
2. If is_duplicate is true, existingEntityId MUST be one of the IDs in the EXISTING list.
3. canonicalName should be the most complete and canonical full name (often from the existing entity).
4. Be conservative — when in doubt, return false.`;

const ResolutionResponseSchema = z.object({
  is_duplicate: z.boolean(),
  existingEntityId: z.string().nullable(),
  canonicalName: z.string().nullable(),
});

async function llmJudgeDuplicate(
  raw: RawEntity,
  candidates: GraphEntity[],
): Promise<{ id: string; canonicalName: string } | null> {
  if (candidates.length === 0) return null;

  const candidatesBlock = candidates
    .map(
      (c) =>
        `- id=${c.entityId} name="${c.name}" type=${c.type} summary="${c.summary}"`,
    )
    .join("\n");

  const userPrompt = `[EXISTING ENTITIES]
${candidatesBlock}

[NEW ENTITY]
name="${raw.name}" type=${raw.type} summary="${raw.summary}"`;

  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: ENTITY_RESOLUTION_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = completion.choices[0]?.message?.content;
    if (!text) return null;
    const json = JSON.parse(text);
    const validated = ResolutionResponseSchema.parse(json);
    if (!validated.is_duplicate || !validated.existingEntityId) return null;
    const hit = candidates.find(
      (c) => c.entityId === validated.existingEntityId,
    );
    if (!hit) return null;
    return {
      id: hit.entityId,
      canonicalName: validated.canonicalName ?? hit.name,
    };
  } catch (err) {
    console.error(
      "[resolver] LLM resolution failed; falling back to create-new:",
      err instanceof Error ? err.message : err,
    );
    return null;
  }
}

async function semanticResolve(
  userId: string,
  raw: RawEntity,
): Promise<GraphEntity | null> {
  const vector = await embed(`${raw.name}: ${raw.summary}`);
  const matches = await queryVectorsByEmbedding(
    vector,
    userId,
    SEMANTIC_TOPK,
    { type: "entity" },
  );
  const candidateIds = matches
    .filter((m) => (m.score ?? 0) >= SEMANTIC_MIN_SCORE)
    .map((m) => m.id);
  if (candidateIds.length === 0) return null;

  const candidates = await findEntitiesByIds(userId, candidateIds);
  // Skip candidates of clearly different type — paper §2.2.1 considers
  // type-mismatched names different entities.
  const typeFiltered = candidates.filter((c) => c.type === raw.type);
  if (typeFiltered.length === 0) return null;

  const verdict = await llmJudgeDuplicate(raw, typeFiltered);
  if (!verdict) return null;

  const matched = typeFiltered.find((c) => c.entityId === verdict.id);
  if (!matched) return null;
  return { ...matched, name: verdict.canonicalName };
}

export async function resolveEntities(
  userId: string,
  rawEntities: RawEntity[],
): Promise<ResolvedEntity[]> {
  if (rawEntities.length === 0) return [];

  const byNorm = new Map<string, RawEntity>();
  for (const raw of rawEntities) {
    const norm = normalizeEntityName(raw.name);
    if (!byNorm.has(norm)) byNorm.set(norm, raw);
  }

  const norms = Array.from(byNorm.keys());
  const existing = await findEntitiesByNormalizedNames(userId, norms);

  const resolved: ResolvedEntity[] = [];
  const newEntities: GraphEntity[] = [];

  const semanticEnabled = process.env[LLM_RESOLVE_FLAG] === "1";

  for (const [norm, raw] of byNorm) {
    const hit = existing.get(norm);
    if (hit) {
      resolved.push({ ...hit, isNew: false });
      continue;
    }

    if (semanticEnabled) {
      const semanticHit = await semanticResolve(userId, raw);
      if (semanticHit) {
        // Update the canonical name on the matched entity if the LLM proposed a
        // more complete form, but keep the existing entityId.
        const merged: GraphEntity = { ...semanticHit, userId };
        await upsertEntity(merged);
        resolved.push({ ...merged, isNew: false });
        continue;
      }
    }

    const entity: GraphEntity = {
      entityId: randomUUID(),
      userId,
      name: raw.name,
      normalizedName: norm,
      type: raw.type,
      summary: raw.summary,
    };
    newEntities.push(entity);
    resolved.push({ ...entity, isNew: true });
  }

  if (newEntities.length > 0) {
    await upsertEntities(newEntities);
  }

  return resolved;
}

export async function getOrCreateSelfEntity(
  userId: string,
): Promise<ResolvedEntity> {
  const entity: GraphEntity = {
    entityId: userId,
    userId,
    name: "User",
    normalizedName: "user",
    type: "PERSON",
    summary: "The user (speaker).",
  };
  await upsertEntity(entity);
  return { ...entity, isNew: false };
}
