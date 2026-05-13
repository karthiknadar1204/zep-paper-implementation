import { randomUUID } from "node:crypto";
import { z } from "zod";
import {
  closeFact,
  findFactsBySourceAndTarget,
  findOpenFactsForSource,
  findOpenFactsForSourceAndRelation,
  reinforceFact,
  upsertFact,
  type GraphFact,
  type OpenFactRow,
} from "./neo4j.service";
import { embed } from "./pinecone.service";
import {
  extractTemporal,
  type EpisodeMessage,
  type RawFact,
  type RawInvalidation,
} from "./extraction.service";
import { openai } from "../utils/openai";

// Cosine similarity for semantic-invalidation candidate filtering. Threshold is
// permissive — the LLM judge does the precise contradiction decision.
const SEMANTIC_INVALIDATE_MIN_SIM = 0.45;
const SEMANTIC_INVALIDATE_TOPK = 5;

// Pair-scoped dedup threshold — high because we want strong confidence the
// existing fact is *the same fact* before merging into it.
const PAIR_DEDUP_MIN_SIM = 0.85;

export type TemporalContext = {
  current: EpisodeMessage;
  recent: EpisodeMessage[];
};

function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i];
    na += a[i] * a[i];
    nb += b[i] * b[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

const INVALIDATION_JUDGE_SYSTEM = `You decide whether a NEW fact contradicts (and therefore invalidates) an EXISTING open fact from the same source entity.

A contradiction means both facts cannot be simultaneously true. Examples:
- "User lives in Boston" vs new "User lives in Tokyo" → contradicts.
- "User is married to Alice" vs new "User is divorced from Alice" → contradicts.
- "User works at Grok" vs new "User joined Anthropic full-time" → contradicts.

Non-contradictions:
- "User likes dogs" vs "User likes cats" — both can be true.
- "User worked at OpenAI" vs "User works at Anthropic" — different times, both can be true historically.

Return JSON exactly: { "is_contradiction": boolean }`;

const InvalidationJudgeSchema = z.object({
  is_contradiction: z.boolean(),
});

async function llmJudgeContradiction(
  newFactText: string,
  existingFactText: string,
): Promise<boolean> {
  try {
    const completion = await openai.chat.completions.create({
      model: "gpt-4o-mini",
      response_format: { type: "json_object" },
      messages: [
        { role: "system", content: INVALIDATION_JUDGE_SYSTEM },
        {
          role: "user",
          content: `EXISTING FACT: ${existingFactText}\nNEW FACT: ${newFactText}`,
        },
      ],
    });
    const text = completion.choices[0]?.message?.content;
    if (!text) return false;
    const json = JSON.parse(text);
    const validated = InvalidationJudgeSchema.parse(json);
    return validated.is_contradiction;
  } catch (err) {
    console.error(
      "[temporal] LLM contradiction judge failed; not closing:",
      err instanceof Error ? err.message : err,
    );
    return false;
  }
}

// Tier 2.8: after rule-based closures, look for SEMANTICALLY-related open
// edges on the same source (via cosine) and ask the LLM to judge contradictions.
// Returns ids of edges that were closed by this pass.
async function semanticInvalidate(
  rawFacts: RawFact[],
  alreadyClosedFactIds: Set<string>,
  occurredAt: string,
): Promise<string[]> {
  const newlyClosed: string[] = [];

  // Group candidate open edges by source so we embed each source's open edges once.
  const sources = Array.from(new Set(rawFacts.map((f) => f.sourceEntityId)));
  const openBySource = new Map<string, OpenFactRow[]>();
  await Promise.all(
    sources.map(async (sid) => {
      openBySource.set(sid, await findOpenFactsForSource(sid));
    }),
  );

  for (const raw of rawFacts) {
    const opens = (openBySource.get(raw.sourceEntityId) ?? []).filter(
      (o) =>
        !alreadyClosedFactIds.has(o.factId) &&
        // Skip exact (source, relation, target) matches — handled by rule-based path.
        !(
          o.relationType === raw.relationType &&
          o.targetEntityId === raw.targetEntityId
        ),
    );
    if (opens.length === 0) continue;

    const [newVec, ...openVecs] = await Promise.all([
      embed(raw.factText),
      ...opens.map((o) => embed(o.factText)),
    ]);

    const ranked = opens
      .map((o, i) => ({ open: o, sim: cosineSimilarity(newVec, openVecs[i]) }))
      .filter((r) => r.sim >= SEMANTIC_INVALIDATE_MIN_SIM)
      .sort((a, b) => b.sim - a.sim)
      .slice(0, SEMANTIC_INVALIDATE_TOPK);

    for (const { open } of ranked) {
      if (alreadyClosedFactIds.has(open.factId)) continue;
      const contradicts = await llmJudgeContradiction(
        raw.factText,
        open.factText,
      );
      if (contradicts) {
        await closeFact(open.factId, occurredAt);
        alreadyClosedFactIds.add(open.factId);
        newlyClosed.push(open.factId);
      }
    }
  }

  return newlyClosed;
}

export type TemporalFact = GraphFact & { isNew: boolean };

export type ClosedEdge = {
  factId: string;
  targetEntityId: string;
  closedAt: string;
};

export type TemporalResult = {
  written: TemporalFact[];
  closed: ClosedEdge[];
  skipped: number;
};

export async function applyTemporalFacts(
  rawFacts: RawFact[],
  invalidations: RawInvalidation[],
  episodeId: string,
  occurredAt: string,
  ctx?: TemporalContext,
): Promise<TemporalResult> {
  if (rawFacts.length === 0 && invalidations.length === 0) {
    return { written: [], closed: [], skipped: 0 };
  }

  // LLM event-time extraction is always on whenever ctx is provided. Per-fact
  // result of null falls back to occurredAt at the write site. Callers that
  // omit ctx (e.g. in-process unit tests) skip this LLM call entirely.
  const temporalByIndex = new Map<
    number,
    { validAt: string | null; invalidAt: string | null }
  >();
  if (ctx !== undefined) {
    await Promise.all(
      rawFacts.map(async (f, i) => {
        const t = await extractTemporal(
          f.factText,
          ctx.current,
          ctx.recent,
          occurredAt,
        );
        temporalByIndex.set(i, t);
      }),
    );
  }

  const groupKey = (sourceId: string, relation: string) =>
    `${sourceId}|${relation}`;

  const uniqueGroups = new Map<string, { sourceId: string; relation: string }>();
  for (const f of rawFacts) {
    const key = groupKey(f.sourceEntityId, f.relationType);
    if (!uniqueGroups.has(key)) {
      uniqueGroups.set(key, {
        sourceId: f.sourceEntityId,
        relation: f.relationType,
      });
    }
  }

  const existingByGroup = new Map<
    string,
    Array<{ factId: string; targetEntityId: string }>
  >();
  await Promise.all(
    Array.from(uniqueGroups.entries()).map(async ([key, { sourceId, relation }]) => {
      const opens = await findOpenFactsForSourceAndRelation(sourceId, relation);
      existingByGroup.set(key, opens);
    }),
  );

  const newTargetsByGroup = new Map<string, Set<string>>();
  for (const f of rawFacts) {
    const key = groupKey(f.sourceEntityId, f.relationType);
    if (!newTargetsByGroup.has(key)) newTargetsByGroup.set(key, new Set());
    newTargetsByGroup.get(key)!.add(f.targetEntityId);
  }

  const toClose: Array<{ factId: string; targetEntityId: string }> = [];
  for (const [key, existings] of Array.from(existingByGroup.entries())) {
    const newTargets = newTargetsByGroup.get(key) ?? new Set<string>();
    for (const old of existings) {
      if (!newTargets.has(old.targetEntityId)) {
        toClose.push(old);
      }
    }
  }

  await Promise.all(
    toClose.map((edge) => closeFact(edge.factId, occurredAt)),
  );
  const closed: ClosedEdge[] = toClose.map((edge) => ({
    factId: edge.factId,
    targetEntityId: edge.targetEntityId,
    closedAt: occurredAt,
  }));

  const written: TemporalFact[] = [];
  let skipped = 0;

  const writes: Promise<void>[] = [];
  for (let i = 0; i < rawFacts.length; i++) {
    const raw = rawFacts[i];
    const key = groupKey(raw.sourceEntityId, raw.relationType);
    const existings = existingByGroup.get(key) ?? [];
    const reaffirmation = existings.find(
      (e) => e.targetEntityId === raw.targetEntityId,
    );
    if (reaffirmation) {
      // Reaffirmation: append episode to provenance and bump confidence on the
      // existing edge instead of writing a duplicate. Idempotent.
      writes.push(reinforceFact(reaffirmation.factId, episodeId, occurredAt));
      skipped++;
      continue;
    }

    // Pair-scoped semantic dedup (always on). Catches cases where the same
    // fact is re-expressed with a different relationType label (e.g. WORKS_AT
    // vs EMPLOYED_BY). Only merges on HIGH cosine similarity to avoid false
    // positives.
    {
      const pairFacts = await findFactsBySourceAndTarget(
        raw.sourceEntityId,
        raw.targetEntityId,
      );
      if (pairFacts.length > 0) {
        const [newVec, ...pairVecs] = await Promise.all([
          embed(raw.factText),
          ...pairFacts.map((p) => embed(p.factText)),
        ]);
        let bestSim = 0;
        let bestFactId: string | null = null;
        for (let j = 0; j < pairFacts.length; j++) {
          const sim = cosineSimilarity(newVec, pairVecs[j]);
          if (sim > bestSim) {
            bestSim = sim;
            bestFactId = pairFacts[j].factId;
          }
        }
        if (bestFactId && bestSim >= PAIR_DEDUP_MIN_SIM) {
          writes.push(reinforceFact(bestFactId, episodeId, occurredAt));
          skipped++;
          continue;
        }
      }
    }

    const t = temporalByIndex.get(i);
    const validFrom = t?.validAt ?? occurredAt;
    let validUntil = t?.invalidAt ?? null;
    // Guard: reject degenerate LLM output where the fact would close at or before
    // it began (e.g. "loves cats now" mis-parsed as closed-on-arrival). A newly
    // arriving edge stays OPEN unless the LLM gave a strictly-later end time.
    if (validUntil !== null) {
      const from = Date.parse(validFrom);
      const until = Date.parse(validUntil);
      if (!Number.isFinite(from) || !Number.isFinite(until) || until <= from) {
        validUntil = null;
      }
    }

    const fact: GraphFact = {
      factId: randomUUID(),
      sourceEntityId: raw.sourceEntityId,
      targetEntityId: raw.targetEntityId,
      relationType: raw.relationType,
      factText: raw.factText,
      validFrom,
      validUntil,
      confidence: raw.confidence,
      episodeId,
    };
    writes.push(upsertFact(fact));
    written.push({ ...fact, isNew: true });
  }
  await Promise.all(writes);

  // Explicit invalidations: close any open edge matching (source, relationType, target).
  // Idempotent: edges already closed by contradiction logic above are simply re-stamped
  // with the same `validUntil` (no-op).
  const invalidationGroups = new Map<
    string,
    Array<{ factId: string; targetEntityId: string }>
  >();
  await Promise.all(
    invalidations.map(async (inv) => {
      const key = groupKey(inv.sourceEntityId, inv.relationType);
      if (invalidationGroups.has(key)) return;
      const opens =
        existingByGroup.get(key) ??
        (await findOpenFactsForSourceAndRelation(
          inv.sourceEntityId,
          inv.relationType,
        ));
      invalidationGroups.set(key, opens);
    }),
  );

  const invalidationCloses: ClosedEdge[] = [];
  await Promise.all(
    invalidations.map(async (inv) => {
      const key = groupKey(inv.sourceEntityId, inv.relationType);
      const opens = invalidationGroups.get(key) ?? [];
      const matching = opens.filter(
        (e) => e.targetEntityId === inv.targetEntityId,
      );
      for (const m of matching) {
        await closeFact(m.factId, occurredAt);
        invalidationCloses.push({
          factId: m.factId,
          targetEntityId: m.targetEntityId,
          closedAt: occurredAt,
        });
      }
    }),
  );

  // Semantic invalidation pass (always on). Operates ONLY on edges not already
  // closed by the rule path above, so it can only close MORE, never override
  // prior decisions. If the LLM judge errors per-candidate, nothing closes.
  const semanticClosed: ClosedEdge[] = [];
  if (rawFacts.length > 0) {
    const alreadyClosed = new Set<string>([
      ...closed.map((c) => c.factId),
      ...invalidationCloses.map((c) => c.factId),
    ]);
    const newlyClosedIds = await semanticInvalidate(
      rawFacts,
      alreadyClosed,
      occurredAt,
    );
    for (const factId of newlyClosedIds) {
      semanticClosed.push({
        factId,
        targetEntityId: "", // unknown without re-fetch; not used downstream
        closedAt: occurredAt,
      });
    }
  }

  return {
    written,
    closed: [...closed, ...invalidationCloses, ...semanticClosed],
    skipped,
  };
}
