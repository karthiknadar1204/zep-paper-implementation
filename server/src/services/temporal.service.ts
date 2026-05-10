import { randomUUID } from "node:crypto";
import {
  closeFact,
  findOpenFactsForSourceAndRelation,
  upsertFact,
  type GraphFact,
} from "./neo4j.service";
import type { RawFact, RawInvalidation } from "./extraction.service";

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
): Promise<TemporalResult> {
  if (rawFacts.length === 0 && invalidations.length === 0) {
    return { written: [], closed: [], skipped: 0 };
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
  for (const [key, existings] of existingByGroup) {
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
  for (const raw of rawFacts) {
    const key = groupKey(raw.sourceEntityId, raw.relationType);
    const existings = existingByGroup.get(key) ?? [];
    const reaffirmation = existings.find(
      (e) => e.targetEntityId === raw.targetEntityId,
    );
    if (reaffirmation) {
      skipped++;
      continue;
    }

    const fact: GraphFact = {
      factId: randomUUID(),
      sourceEntityId: raw.sourceEntityId,
      targetEntityId: raw.targetEntityId,
      relationType: raw.relationType,
      factText: raw.factText,
      validFrom: occurredAt,
      validUntil: null,
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

  return {
    written,
    closed: [...closed, ...invalidationCloses],
    skipped,
  };
}
