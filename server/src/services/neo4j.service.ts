import { neo4jDriver, neo4jDatabase } from "../utils/neo4j";

async function runQuery(
  cypher: string,
  params: Record<string, unknown> = {},
) {
  const session = neo4jDriver.session({
    database: neo4jDatabase ?? undefined,
  });
  try {
    const result = await session.run(cypher, params);
    return result.records;
  } finally {
    await session.close();
  }
}

export async function ensureIndices(): Promise<void> {
  const statements = [
    `CREATE CONSTRAINT entity_id_unique IF NOT EXISTS
       FOR (e:Entity) REQUIRE e.entityId IS UNIQUE`,
    `CREATE INDEX entity_user_normname_idx IF NOT EXISTS
       FOR (e:Entity) ON (e.userId, e.normalizedName)`,
    `CREATE CONSTRAINT episode_id_unique IF NOT EXISTS
       FOR (e:Episode) REQUIRE e.episodeId IS UNIQUE`,
    `CREATE INDEX episode_user_idx IF NOT EXISTS
       FOR (e:Episode) ON (e.userId)`,
    `CREATE CONSTRAINT fact_id_unique IF NOT EXISTS
       FOR ()-[f:FACT]-() REQUIRE f.factId IS UNIQUE`,
  ];
  for (const cypher of statements) {
    await runQuery(cypher);
  }
}

export type GraphEntity = {
  entityId: string;
  userId: string;
  name: string;
  normalizedName: string;
  type: string;
  summary: string;
};

export function normalizeEntityName(name: string): string {
  return name.trim().toLowerCase().replace(/\s+/g, " ");
}

// Used by hybrid entity resolution (Tier 2.7) to fetch full entity props for
// candidate ids surfaced by cosine search.
export async function findEntitiesByIds(
  userId: string,
  entityIds: string[],
): Promise<GraphEntity[]> {
  if (entityIds.length === 0) return [];
  const records = await runQuery(
    `
    MATCH (e:Entity { userId: $userId })
    WHERE e.entityId IN $ids
    RETURN e
    `,
    { userId, ids: entityIds },
  );
  return records.map((record) => {
    const p = record.get("e").properties;
    return {
      entityId: p.entityId,
      userId: p.userId,
      name: p.name,
      normalizedName: p.normalizedName,
      type: p.type,
      summary: p.summary,
    } satisfies GraphEntity;
  });
}

export async function findEntitiesByNormalizedNames(
  userId: string,
  normalizedNames: string[],
): Promise<Map<string, GraphEntity>> {
  if (normalizedNames.length === 0) return new Map();

  const records = await runQuery(
    `
    MATCH (e:Entity { userId: $userId })
    WHERE e.normalizedName IN $names
    RETURN e
    `,
    { userId, names: normalizedNames },
  );

  const map = new Map<string, GraphEntity>();
  for (const record of records) {
    const p = record.get("e").properties;
    map.set(p.normalizedName, {
      entityId: p.entityId,
      userId: p.userId,
      name: p.name,
      normalizedName: p.normalizedName,
      type: p.type,
      summary: p.summary,
    });
  }
  return map;
}

export async function upsertEntity(entity: GraphEntity): Promise<void> {
  await runQuery(
    `
    MERGE (e:Entity { entityId: $entityId })
    ON CREATE SET
      e.userId = $userId,
      e.name = $name,
      e.normalizedName = $normalizedName,
      e.type = $type,
      e.summary = $summary,
      e.createdAt = datetime(),
      e.updatedAt = datetime()
    ON MATCH SET
      e.name = $name,
      e.summary = $summary,
      e.type = $type,
      e.updatedAt = datetime()
    `,
    entity,
  );
}

export async function upsertEntities(entities: GraphEntity[]): Promise<void> {
  if (entities.length === 0) return;
  await runQuery(
    `
    UNWIND $entities AS ent
    MERGE (e:Entity { entityId: ent.entityId })
    ON CREATE SET
      e.userId = ent.userId,
      e.name = ent.name,
      e.normalizedName = ent.normalizedName,
      e.type = ent.type,
      e.summary = ent.summary,
      e.createdAt = datetime(),
      e.updatedAt = datetime()
    ON MATCH SET
      e.name = ent.name,
      e.summary = ent.summary,
      e.type = ent.type,
      e.updatedAt = datetime()
    `,
    { entities },
  );
}

export type GraphEpisode = {
  episodeId: string;
  userId: string;
  sessionId: string;
  actor: string;
  content: string;
  occurredAt: string;
};

export async function createEpisodeNode(
  episode: GraphEpisode,
): Promise<void> {
  await runQuery(
    `
    MERGE (e:Episode { episodeId: $episodeId })
    ON CREATE SET
      e.userId = $userId,
      e.sessionId = $sessionId,
      e.actor = $actor,
      e.content = $content,
      e.occurredAt = datetime($occurredAt),
      e.createdAt = datetime()
    `,
    episode,
  );
}

export async function linkEpisodeToEntities(
  episodeId: string,
  entityIds: string[],
  occurredAt: string,
): Promise<void> {
  if (entityIds.length === 0) return;
  await runQuery(
    `
    MATCH (ep:Episode { episodeId: $episodeId })
    UNWIND $entityIds AS eid
    MATCH (ent:Entity { entityId: eid })
    MERGE (ep)-[m:MENTIONS]->(ent)
    ON CREATE SET m.timestamp = datetime($occurredAt)
    `,
    { episodeId, entityIds, occurredAt },
  );
}

export type GraphFact = {
  factId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  factText: string;
  validFrom: string;
  validUntil: string | null;
  confidence: number;
  episodeId: string;
};

export async function findOpenFactsForSourceAndRelation(
  sourceEntityId: string,
  relationType: string,
): Promise<Array<{ factId: string; targetEntityId: string }>> {
  const records = await runQuery(
    `
    MATCH (a:Entity { entityId: $sourceEntityId })
          -[f:FACT { relationType: $relationType }]->
          (b:Entity)
    WHERE f.validUntil IS NULL
    RETURN f.factId AS factId, b.entityId AS targetEntityId
    `,
    { sourceEntityId, relationType },
  );
  return records.map((r) => ({
    factId: r.get("factId") as string,
    targetEntityId: r.get("targetEntityId") as string,
  }));
}

// tExpired tracks transaction-time invalidation (when the system learned the
// fact ended), distinct from validUntil which is event-time. Paper §2.2.3.
export async function closeFact(
  factId: string,
  validUntil: string,
): Promise<void> {
  await runQuery(
    `
    MATCH ()-[f:FACT { factId: $factId }]->()
    SET f.validUntil = datetime($validUntil),
        f.tExpired = coalesce(f.tExpired, datetime())
    `,
    { factId, validUntil },
  );
}

// Reaffirmation: append the new episode to provenance and bump confidence
// instead of writing a duplicate edge. Idempotent on (factId, episodeId).
export async function reinforceFact(
  factId: string,
  episodeId: string,
  occurredAt: string,
  confidenceBump: number = 0.01,
): Promise<void> {
  await runQuery(
    `
    MATCH ()-[f:FACT { factId: $factId }]->()
    WITH f,
      coalesce(f.episodeIds, [f.episodeId]) AS currentIds,
      coalesce(f.confidence, 1.0) AS currentConf
    SET
      f.episodeIds = CASE
        WHEN $episodeId IN currentIds THEN currentIds
        ELSE currentIds + $episodeId
      END,
      f.confidence = CASE
        WHEN currentConf + $bump > 1.0 THEN 1.0
        ELSE currentConf + $bump
      END,
      f.lastSeenAt = datetime($occurredAt)
    `,
    { factId, episodeId, occurredAt, bump: confidenceBump },
  );
}

export type OpenFactRow = {
  factId: string;
  sourceEntityId: string;
  targetEntityId: string;
  relationType: string;
  factText: string;
  validFrom: string;
};

// All open facts on a source entity, used for semantic invalidation (Tier 2.8).
// Optionally filtered by source.
export async function findOpenFactsForSource(
  sourceEntityId: string,
): Promise<OpenFactRow[]> {
  const records = await runQuery(
    `
    MATCH (a:Entity { entityId: $sourceEntityId })-[f:FACT]->(b:Entity)
    WHERE f.validUntil IS NULL
    RETURN
      f.factId AS factId,
      a.entityId AS sourceEntityId,
      b.entityId AS targetEntityId,
      f.relationType AS relationType,
      f.factText AS factText,
      toString(f.validFrom) AS validFrom
    `,
    { sourceEntityId },
  );
  return records.map((r) => ({
    factId: r.get("factId") as string,
    sourceEntityId: r.get("sourceEntityId") as string,
    targetEntityId: r.get("targetEntityId") as string,
    relationType: r.get("relationType") as string,
    factText: (r.get("factText") as string) ?? "",
    validFrom: r.get("validFrom") as string,
  }));
}

// All facts (any open/closed state) between a specific (source, target) pair.
// Used for pair-scoped dedup (Tier 2.9).
export async function findFactsBySourceAndTarget(
  sourceEntityId: string,
  targetEntityId: string,
): Promise<OpenFactRow[]> {
  const records = await runQuery(
    `
    MATCH (a:Entity { entityId: $sourceEntityId })
          -[f:FACT]->
          (b:Entity { entityId: $targetEntityId })
    WHERE f.validUntil IS NULL
    RETURN
      f.factId AS factId,
      a.entityId AS sourceEntityId,
      b.entityId AS targetEntityId,
      f.relationType AS relationType,
      f.factText AS factText,
      toString(f.validFrom) AS validFrom
    `,
    { sourceEntityId, targetEntityId },
  );
  return records.map((r) => ({
    factId: r.get("factId") as string,
    sourceEntityId: r.get("sourceEntityId") as string,
    targetEntityId: r.get("targetEntityId") as string,
    relationType: r.get("relationType") as string,
    factText: (r.get("factText") as string) ?? "",
    validFrom: r.get("validFrom") as string,
  }));
}

export type ExpandedFact = {
  factId: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  relationType: string;
  targetId: string;
  targetName: string;
  targetType: string;
  factText: string;
  validFrom: string;
  validUntil: string | null;
  confidence: number;
  hop: number;
};

export async function expandFromIds(
  userId: string,
  input: { entityIds: string[]; factIds: string[]; asOf: string },
): Promise<ExpandedFact[]> {
  const { entityIds, factIds, asOf } = input;
  if (entityIds.length === 0 && factIds.length === 0) return [];

  const records = await runQuery(
    `
    MATCH (a:Entity { userId: $userId })-[f:FACT]->(b:Entity)
    WHERE (
      f.factId IN $factIds
      OR a.entityId IN $entityIds
      OR b.entityId IN $entityIds
    )
    AND f.validFrom <= datetime($asOf)
    AND coalesce(f.validUntil, datetime('9999-01-01')) >= datetime($asOf)
    RETURN
      f.factId AS factId,
      a.entityId AS sourceId, a.name AS sourceName, a.type AS sourceType,
      f.relationType AS relationType,
      b.entityId AS targetId, b.name AS targetName, b.type AS targetType,
      f.factText AS factText,
      toString(f.validFrom) AS validFrom,
      toString(f.validUntil) AS validUntil,
      coalesce(f.confidence, 1.0) AS confidence,
      CASE WHEN f.factId IN $factIds THEN 0 ELSE 1 END AS hop
    `,
    { userId, factIds, entityIds, asOf },
  );

  return records.map((r) => ({
    factId: r.get("factId") as string,
    sourceId: r.get("sourceId") as string,
    sourceName: r.get("sourceName") as string,
    sourceType: r.get("sourceType") as string,
    relationType: r.get("relationType") as string,
    targetId: r.get("targetId") as string,
    targetName: r.get("targetName") as string,
    targetType: r.get("targetType") as string,
    factText: r.get("factText") as string,
    validFrom: r.get("validFrom") as string,
    validUntil: (r.get("validUntil") as string | null) ?? null,
    confidence: Number(r.get("confidence")),
    hop: Number(r.get("hop")),
  }));
}

export async function upsertFact(fact: GraphFact): Promise<void> {
  await runQuery(
    `
    MATCH (a:Entity { entityId: $sourceEntityId })
    MATCH (b:Entity { entityId: $targetEntityId })
    MERGE (a)-[f:FACT { factId: $factId }]->(b)
    ON CREATE SET
      f.relationType = $relationType,
      f.factText = $factText,
      f.validFrom = datetime($validFrom),
      f.validUntil = CASE WHEN $validUntil IS NULL THEN NULL ELSE datetime($validUntil) END,
      f.confidence = $confidence,
      f.episodeId = $episodeId,
      f.episodeIds = [$episodeId],
      f.createdAt = datetime(),
      f.tCreated = datetime(),
      f.lastSeenAt = datetime($validFrom)
    `,
    fact,
  );
}
