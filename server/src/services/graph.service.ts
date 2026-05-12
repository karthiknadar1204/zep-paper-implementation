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

export type GraphEntityNode = {
  entityId: string;
  name: string;
  normalizedName: string;
  type: string;
  summary: string;
};

export type GraphFactEdge = {
  factId: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  factText: string;
  validFrom: string;
  validUntil: string | null;
  confidence: number;
};

export type GraphEpisodeNode = {
  episodeId: string;
  sessionId: string;
  actor: string;
  content: string;
  occurredAt: string;
};

export type GraphMentionEdge = {
  episodeId: string;
  entityId: string;
};

export type GraphSnapshot = {
  entities: GraphEntityNode[];
  facts: GraphFactEdge[];
  episodes: GraphEpisodeNode[];
  mentions: GraphMentionEdge[];
};

export async function getUserGraph(
  userId: string,
  sessionId?: string,
): Promise<GraphSnapshot> {
  const entityRecords = await runQuery(
    `
    MATCH (e:Entity { userId: $userId })
    RETURN
      e.entityId AS entityId,
      e.name AS name,
      e.normalizedName AS normalizedName,
      e.type AS type,
      e.summary AS summary
    ORDER BY e.name
    `,
    { userId },
  );
  const entities: GraphEntityNode[] = entityRecords.map((r) => ({
    entityId: r.get("entityId") as string,
    name: r.get("name") as string,
    normalizedName: r.get("normalizedName") as string,
    type: r.get("type") as string,
    summary: (r.get("summary") as string) ?? "",
  }));

  const factRecords = await runQuery(
    `
    MATCH (a:Entity { userId: $userId })-[f:FACT]->(b:Entity)
    RETURN
      f.factId AS factId,
      a.entityId AS sourceId,
      b.entityId AS targetId,
      f.relationType AS relationType,
      f.factText AS factText,
      toString(f.validFrom) AS validFrom,
      toString(f.validUntil) AS validUntil,
      coalesce(f.confidence, 1.0) AS confidence
    `,
    { userId },
  );
  const facts: GraphFactEdge[] = factRecords.map((r) => ({
    factId: r.get("factId") as string,
    sourceId: r.get("sourceId") as string,
    targetId: r.get("targetId") as string,
    relationType: r.get("relationType") as string,
    factText: (r.get("factText") as string) ?? "",
    validFrom: r.get("validFrom") as string,
    validUntil: (r.get("validUntil") as string | null) ?? null,
    confidence: Number(r.get("confidence")),
  }));

  const episodeCypher = sessionId
    ? `
      MATCH (ep:Episode { userId: $userId, sessionId: $sessionId })
      RETURN
        ep.episodeId AS episodeId,
        ep.sessionId AS sessionId,
        ep.actor AS actor,
        ep.content AS content,
        toString(ep.occurredAt) AS occurredAt
      ORDER BY ep.occurredAt
      `
    : `
      MATCH (ep:Episode { userId: $userId })
      RETURN
        ep.episodeId AS episodeId,
        ep.sessionId AS sessionId,
        ep.actor AS actor,
        ep.content AS content,
        toString(ep.occurredAt) AS occurredAt
      ORDER BY ep.occurredAt
      `;
  const episodeRecords = await runQuery(episodeCypher, { userId, sessionId });
  const episodes: GraphEpisodeNode[] = episodeRecords.map((r) => ({
    episodeId: r.get("episodeId") as string,
    sessionId: r.get("sessionId") as string,
    actor: r.get("actor") as string,
    content: r.get("content") as string,
    occurredAt: r.get("occurredAt") as string,
  }));

  const episodeIdSet = new Set(episodes.map((e) => e.episodeId));
  const mentionRecords = await runQuery(
    `
    MATCH (ep:Episode { userId: $userId })-[:MENTIONS]->(e:Entity)
    RETURN
      ep.episodeId AS episodeId,
      e.entityId AS entityId
    `,
    { userId },
  );
  const mentions: GraphMentionEdge[] = mentionRecords
    .map((r) => ({
      episodeId: r.get("episodeId") as string,
      entityId: r.get("entityId") as string,
    }))
    .filter((m) => episodeIdSet.has(m.episodeId));

  return { entities, facts, episodes, mentions };
}

export type GraphNodeDetail = {
  kind: "entity" | "episode";
  properties: Record<string, unknown>;
  outgoing: Array<{
    type: string;
    relationType?: string;
    properties: Record<string, unknown>;
    other: { id: string; kind: "entity" | "episode"; name?: string };
  }>;
  incoming: Array<{
    type: string;
    relationType?: string;
    properties: Record<string, unknown>;
    other: { id: string; kind: "entity" | "episode"; name?: string };
  }>;
};

function plainProps(props: Record<string, unknown>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(props)) {
    if (v === null || v === undefined) {
      out[k] = v;
    } else if (typeof v === "object" && v !== null && "toString" in v) {
      out[k] = (v as { toString: () => string }).toString();
    } else {
      out[k] = v;
    }
  }
  return out;
}

export class GraphNodeNotFoundError extends Error {
  constructor() {
    super("GRAPH_NODE_NOT_FOUND");
    this.name = "GraphNodeNotFoundError";
  }
}

export async function getNodeDetail(
  userId: string,
  nodeId: string,
): Promise<GraphNodeDetail> {
  const records = await runQuery(
    `
    MATCH (n)
    WHERE n.userId = $userId
      AND (n.entityId = $nodeId OR n.episodeId = $nodeId)
    OPTIONAL MATCH (n)-[rOut]->(mOut)
    OPTIONAL MATCH (mIn)-[rIn]->(n)
    RETURN
      n AS node,
      labels(n) AS labels,
      collect(DISTINCT { rel: rOut, other: mOut, dir: 'out' }) AS outgoing,
      collect(DISTINCT { rel: rIn, other: mIn, dir: 'in' }) AS incoming
    `,
    { userId, nodeId },
  );

  if (records.length === 0) {
    throw new GraphNodeNotFoundError();
  }

  const r = records[0];
  const node = r.get("node");
  if (!node) throw new GraphNodeNotFoundError();

  const labels = r.get("labels") as string[];
  const kind: "entity" | "episode" = labels.includes("Entity")
    ? "entity"
    : "episode";
  const nodeIdValue =
    node.properties.entityId ?? node.properties.episodeId;
  const properties = plainProps(node.properties);

  const otherKind = (other: { properties: Record<string, unknown> }) =>
    other.properties.entityId ? "entity" : "episode";

  const outgoingRaw = (r.get("outgoing") as Array<{
    rel: { type: string; properties: Record<string, unknown> } | null;
    other: { properties: Record<string, unknown> } | null;
  }>) ?? [];
  const outgoing = outgoingRaw
    .filter((x) => x.rel && x.other)
    .map((x) => {
      const otherProps = x.other!.properties;
      const k = otherKind({ properties: otherProps });
      return {
        type: x.rel!.type,
        relationType:
          (x.rel!.properties.relationType as string | undefined) ?? undefined,
        properties: plainProps(x.rel!.properties),
        other: {
          id: (otherProps.entityId ?? otherProps.episodeId) as string,
          kind: k as "entity" | "episode",
          name:
            (otherProps.name as string | undefined) ??
            (otherProps.content
              ? String(otherProps.content).slice(0, 50)
              : undefined),
        },
      };
    });

  const incomingRaw = (r.get("incoming") as Array<{
    rel: { type: string; properties: Record<string, unknown> } | null;
    other: { properties: Record<string, unknown> } | null;
  }>) ?? [];
  const incoming = incomingRaw
    .filter((x) => x.rel && x.other)
    .map((x) => {
      const otherProps = x.other!.properties;
      const k = otherKind({ properties: otherProps });
      return {
        type: x.rel!.type,
        relationType:
          (x.rel!.properties.relationType as string | undefined) ?? undefined,
        properties: plainProps(x.rel!.properties),
        other: {
          id: (otherProps.entityId ?? otherProps.episodeId) as string,
          kind: k as "entity" | "episode",
          name:
            (otherProps.name as string | undefined) ??
            (otherProps.content
              ? String(otherProps.content).slice(0, 50)
              : undefined),
        },
      };
    });

  return {
    kind,
    properties: { ...properties, _id: nodeIdValue as string },
    outgoing,
    incoming,
  };
}
