import { z } from "zod";
import { queryVectors } from "./pinecone.service";
import { expandFromIds, type ExpandedFact } from "./neo4j.service";
import { getRecentMessages, type RecentMessage } from "./episodes.service";
import { openai } from "../utils/openai";

export type RetrievalOptions = {
  userId: string;
  query: string;
  sessionId?: string;
  asOf?: string;
  limit?: number;
  vectorTopK?: number;
  minVectorScore?: number;
};

export type ScoredFact = ExpandedFact & {
  vectorScore: number;
  recencyScore: number;
  hopScore: number;
  llmScore?: number;
  totalScore: number;
};

export type RetrievalResult = {
  answer: string;
  context: string;
  facts: ScoredFact[];
  recentMessages: RecentMessage[];
  asOf: string;
};

const RECENT_MESSAGE_TAIL = 5;

const WEIGHT_VECTOR = 0.6;
const WEIGHT_RECENCY = 0.25;
const WEIGHT_HOP = 0.15;

const DEFAULT_MIN_VECTOR_SCORE = 0.3;

const LLM_RERANK_MODEL = "gpt-4o-mini";
const LLM_RERANK_INPUT_CAP = 20;

const LLM_RERANK_SYSTEM = `You are reranking facts retrieved from a knowledge graph by relevance to a user query.

For each candidate fact, judge how directly it answers or informs the query.

Score guide:
- 0.9–1.0: directly answers the query
- 0.6–0.8: strong supporting context
- 0.3–0.5: tangentially related
- 0.0–0.2: not relevant — DROP

Drop irrelevant facts entirely. Return ONLY the relevant ones, ordered most-to-least relevant.

Return JSON exactly: { "ranked": [ { "factId": string, "score": number } ] }`;

const LlmRerankResponseSchema = z.object({
  ranked: z.array(
    z.object({
      factId: z.string(),
      score: z.number().min(0).max(1),
    }),
  ),
});

const LLM_ANSWER_SYSTEM = `You are a memory assistant. Given retrieved facts about the user and the recent conversation, write a concise direct answer to the user's query.

Rules:
- 1-3 sentences. Plain prose, no preamble, no markdown, no bullet points.
- Use ONLY the facts and messages provided. Do NOT invent details.
- If a fact has a date range, you may reference time naturally ("the user used to..." for closed facts).
- If nothing relevant is provided, reply exactly: "I don't have information about that yet."
- Refer to the speaker as "the user" or "you" — match the framing the query uses.`;

async function llmAnswer(
  query: string,
  facts: ScoredFact[],
  recent: RecentMessage[],
): Promise<string> {
  const factsBlock =
    facts.length === 0
      ? "(no relevant facts)"
      : facts
          .map((f) => {
            const since = f.validFrom.slice(0, 10);
            const until = f.validUntil ? f.validUntil.slice(0, 10) : null;
            const range = until ? `from ${since} to ${until}` : `since ${since}`;
            return `- ${f.factText} (${range})`;
          })
          .join("\n");

  const recentBlock =
    recent.length === 0
      ? "(no recent messages)"
      : recent
          .map((m) => `> [${m.actor}] ${m.content}`)
          .join("\n");

  const userPrompt = `Query: ${query}

Relevant facts:
${factsBlock}

Recent conversation:
${recentBlock}`;

  try {
    const completion = await openai.chat.completions.create({
      model: LLM_RERANK_MODEL,
      messages: [
        { role: "system", content: LLM_ANSWER_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });
    const text = completion.choices[0]?.message?.content?.trim();
    return text || "(unable to generate answer)";
  } catch (err) {
    console.error(
      "[retrieval] LLM answer synthesis failed:",
      err instanceof Error ? err.message : err,
    );
    return "(unable to generate answer)";
  }
}

async function llmRerank(
  query: string,
  candidates: ScoredFact[],
): Promise<ScoredFact[]> {
  if (candidates.length === 0) return candidates;

  const input = candidates.slice(0, LLM_RERANK_INPUT_CAP);
  const candidatesBlock = input
    .map(
      (f, i) =>
        `${i + 1}. [${f.factId}] ${f.sourceName} -[${f.relationType}]-> ${f.targetName}: "${f.factText}"`,
    )
    .join("\n");

  const userPrompt = `Query: ${query}

Candidates:
${candidatesBlock}`;

  try {
    const completion = await openai.chat.completions.create({
      model: LLM_RERANK_MODEL,
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: LLM_RERANK_SYSTEM },
        { role: "user", content: userPrompt },
      ],
    });

    const raw = completion.choices[0]?.message?.content;
    if (!raw) return candidates;

    const json = JSON.parse(raw);
    const validated = LlmRerankResponseSchema.parse(json);

    const byId = new Map(input.map((c) => [c.factId, c]));
    const reranked: ScoredFact[] = [];
    const seen = new Set<string>();

    for (const r of validated.ranked) {
      if (seen.has(r.factId)) continue;
      const fact = byId.get(r.factId);
      if (!fact) continue;
      seen.add(r.factId);
      reranked.push({
        ...fact,
        llmScore: r.score,
        totalScore: r.score,
      });
    }

    reranked.sort((a, b) => (b.llmScore ?? 0) - (a.llmScore ?? 0));
    return reranked;
  } catch (err) {
    console.error(
      "[retrieval] LLM rerank failed; falling back to score-based order:",
      err instanceof Error ? err.message : err,
    );
    return candidates;
  }
}

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
  const minVectorScore = opts.minVectorScore ?? DEFAULT_MIN_VECTOR_SCORE;
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

  const filtered = scored.filter((f) => f.vectorScore >= minVectorScore);
  filtered.sort((a, b) => b.totalScore - a.totalScore);

  const reranked = await llmRerank(query, filtered);

  const topFacts = reranked.slice(0, limit);

  const recentMessages = sessionId
    ? await getRecentMessages(sessionId, RECENT_MESSAGE_TAIL)
    : [];

  const context = formatContext(topFacts, recentMessages, asOf);
  const answer = await llmAnswer(query, topFacts, recentMessages);

  return { answer, context, facts: topFacts, recentMessages, asOf };
}
