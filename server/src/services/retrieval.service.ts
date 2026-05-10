import { queryVectors } from "./pinecone.service";
import { expandFromIds, type ExpandedFact } from "./neo4j.service";
import { getRecentMessages, type RecentMessage } from "./episodes.service";

export type RetrievalOptions = {
  userId: string;
  query: string;
  sessionId?: string;
  asOf?: string;
  limit?: number;
  vectorTopK?: number;
};

export type ScoredFact = ExpandedFact & {
  vectorScore: number;
  recencyScore: number;
  hopScore: number;
  totalScore: number;
};

export type RetrievalResult = {
  context: string;
  facts: ScoredFact[];
  recentMessages: RecentMessage[];
  asOf: string;
};

const RECENT_MESSAGE_TAIL = 5;

const WEIGHT_VECTOR = 0.6;
const WEIGHT_RECENCY = 0.25;
const WEIGHT_HOP = 0.15;

function computeRecencyScore(validFrom: string, asOf: string): number {
  const ageMs =
    new Date(asOf).getTime() - new Date(validFrom).getTime();
  const ageDays = Math.max(0, ageMs / (1000 * 60 * 60 * 24));
  if (ageDays <= 7) return 1;
  if (ageDays >= 365) return 0;
  return 1 - (ageDays - 7) / (365 - 7);
}

function formatContext(
  facts: ScoredFact[],
  messages: RecentMessage[],
  asOf: string,
): string {
  const lines: string[] = [];
  lines.push(`Context as of ${asOf}.`);

  if (facts.length > 0) {
    lines.push("");
    lines.push("Relevant facts (currently true):");
    for (const f of facts) {
      const since = f.validFrom.slice(0, 10);
      lines.push(`- ${f.factText} (since ${since})`);
    }
  }

  if (messages.length > 0) {
    lines.push("");
    lines.push("Recent messages in this session:");
    for (const m of messages) {
      const ts = m.occurredAt.toISOString().slice(0, 16).replace("T", " ");
      lines.push(`> [${m.actor} @ ${ts}] ${m.content}`);
    }
  }

  if (facts.length === 0 && messages.length === 0) {
    lines.push("");
    lines.push("(no relevant facts or recent messages)");
  }

  return lines.join("\n");
}

export async function getContext(
  opts: RetrievalOptions,
): Promise<RetrievalResult> {
  const { userId, query, sessionId } = opts;
  const limit = opts.limit ?? 10;
  const vectorTopK = opts.vectorTopK ?? 25;
  const asOf = opts.asOf ?? new Date().toISOString();

  const matches = await queryVectors(query, userId, vectorTopK);

  const entityIds: string[] = [];
  const factIds: string[] = [];
  const vectorScoreById = new Map<string, number>();
  for (const m of matches) {
    if (m.score !== undefined) vectorScoreById.set(m.id, m.score);
    const type = m.metadata?.type;
    if (type === "entity") entityIds.push(m.id);
    else if (type === "fact") factIds.push(m.id);
  }

  const expanded = await expandFromIds(userId, {
    entityIds,
    factIds,
    asOf,
  });

  const dedup = new Map<string, ExpandedFact>();
  for (const f of expanded) dedup.set(f.factId, f);

  const scored: ScoredFact[] = Array.from(dedup.values()).map((f) => {
    const vScoreDirect = vectorScoreById.get(f.factId) ?? 0;
    const vScoreSrc = vectorScoreById.get(f.sourceId) ?? 0;
    const vScoreTgt = vectorScoreById.get(f.targetId) ?? 0;
    const vectorScore = Math.max(vScoreDirect, vScoreSrc * 0.7, vScoreTgt * 0.7);

    const recencyScore = computeRecencyScore(f.validFrom, asOf);
    const hopScore = f.hop === 0 ? 1 : 0.5;
    const totalScore =
      WEIGHT_VECTOR * vectorScore +
      WEIGHT_RECENCY * recencyScore +
      WEIGHT_HOP * hopScore;

    return {
      ...f,
      vectorScore,
      recencyScore,
      hopScore,
      totalScore,
    };
  });

  scored.sort((a, b) => b.totalScore - a.totalScore);
  const topFacts = scored.slice(0, limit);

  const recentMessages = sessionId
    ? await getRecentMessages(sessionId, RECENT_MESSAGE_TAIL)
    : [];

  const context = formatContext(topFacts, recentMessages, asOf);

  return { context, facts: topFacts, recentMessages, asOf };
}
