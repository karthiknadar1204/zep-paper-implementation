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

export async function closeFact(
  factId: string,
  validUntil: string,
): Promise<void> {
  await runQuery(
    `
    MATCH ()-[f:FACT { factId: $factId }]->()
    SET f.validUntil = datetime($validUntil)
    `,
    { factId, validUntil },
  );
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
      f.createdAt = datetime()
    `,
    fact,
  );
}
