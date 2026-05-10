import { randomUUID } from "node:crypto";
import {
  findEntitiesByNormalizedNames,
  normalizeEntityName,
  upsertEntities,
  upsertEntity,
  type GraphEntity,
} from "./neo4j.service";
import type { RawEntity } from "./extraction.service";

export type ResolvedEntity = GraphEntity & { isNew: boolean };

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

  for (const [norm, raw] of byNorm) {
    const hit = existing.get(norm);
    if (hit) {
      resolved.push({ ...hit, isNew: false });
      continue;
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
