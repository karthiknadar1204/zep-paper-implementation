// Tier 2 flag-gated path smoke test.
// Toggles each ZEP_LLM_* flag at runtime, drives a targeted fixture through
// the relevant service, and asserts the flagged-vs-baseline difference.
// Costs ~$0.01 in OpenAI API per run.
import { randomUUID } from "node:crypto";
import { neo4jDriver } from "../src/utils/neo4j";
import {
  findFactsBySourceAndTarget,
  findOpenFactsForSource,
  upsertEntities,
  upsertEntity,
  upsertFact,
  type GraphEntity,
  type GraphFact,
} from "../src/services/neo4j.service";
import { applyTemporalFacts } from "../src/services/temporal.service";
import { resolveEntities } from "../src/services/resolver.service";
import {
  extractEntities,
  type RawEntity,
  type RawFact,
} from "../src/services/extraction.service";
import { upsertEntityVectors } from "../src/services/pinecone.service";

const TEST_USER_ID = "00000000-0000-0000-0000-0000000000a1";

let passed = 0;
let failed = 0;

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`  ✗ ${msg}`);
    failed++;
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
    passed++;
  }
}

function setFlag(name: string, on: boolean) {
  if (on) process.env[name] = "1";
  else delete process.env[name];
}

async function cleanup() {
  const session = neo4jDriver.session();
  try {
    await session.run(
      `MATCH (n) WHERE n.userId = $userId DETACH DELETE n`,
      { userId: TEST_USER_ID },
    );
  } finally {
    await session.close();
  }
}

async function deleteEntityById(entityId: string) {
  const session = neo4jDriver.session();
  try {
    await session.run(
      `MATCH (e:Entity { entityId: $entityId }) DETACH DELETE e`,
      { entityId },
    );
  } finally {
    await session.close();
  }
}

function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function ensureUser(): Promise<GraphEntity> {
  const self: GraphEntity = {
    entityId: TEST_USER_ID,
    userId: TEST_USER_ID,
    name: "User",
    normalizedName: "user",
    type: "PERSON",
    summary: "The user (speaker).",
  };
  await upsertEntity(self);
  return self;
}

// ─── Tier 2.5: LLM temporal extraction ───────────────────────────────
async function testTemporalExtraction() {
  console.log("\n==== Tier 2.5: ZEP_LLM_TEMPORAL ====");
  await cleanup();
  await ensureUser();
  const anthropic: GraphEntity = {
    entityId: randomUUID(),
    userId: TEST_USER_ID,
    name: "Anthropic",
    normalizedName: "anthropic",
    type: "COMPANY",
    summary: "An AI safety company.",
  };
  await upsertEntity(anthropic);

  const occurredAt = "2026-05-12T10:00:00.000Z";
  const facts: RawFact[] = [
    {
      sourceEntityId: TEST_USER_ID,
      targetEntityId: anthropic.entityId,
      relationType: "WORKS_AT",
      factText: "The user started working at Anthropic two years ago.",
      confidence: 0.99,
    },
  ];
  const ctx = {
    current: {
      actor: "user" as const,
      content: "I started at Anthropic two years ago.",
    },
    recent: [],
  };

  // Baseline: flag off → validFrom = occurredAt
  setFlag("ZEP_LLM_TEMPORAL", false);
  await applyTemporalFacts(facts, [], randomUUID(), occurredAt, ctx);
  let opens = await findOpenFactsForSource(TEST_USER_ID);
  assert(opens.length === 1, "baseline: 1 open fact");
  console.log(`    baseline validFrom: ${opens[0].validFrom}`);
  assert(
    opens[0].validFrom.startsWith("2026-05-12"),
    "baseline: validFrom = occurredAt (no LLM rewrite)",
  );

  // Flag on → validFrom shifted backwards
  await cleanup();
  await ensureUser();
  await upsertEntity(anthropic);

  setFlag("ZEP_LLM_TEMPORAL", true);
  await applyTemporalFacts(facts, [], randomUUID(), occurredAt, ctx);
  setFlag("ZEP_LLM_TEMPORAL", false);

  opens = await findOpenFactsForSource(TEST_USER_ID);
  assert(opens.length === 1, "flagged: 1 open fact");
  console.log(`    flagged  validFrom: ${opens[0].validFrom}`);
  const year = parseInt(opens[0].validFrom.slice(0, 4), 10);
  assert(
    year <= 2024,
    `flagged: validFrom year ≤ 2024 (got ${year}; "two years ago" from 2026-05)`,
  );
}

// ─── Tier 2.6: reflexion on entity extraction ────────────────────────
async function testReflexion() {
  console.log("\n==== Tier 2.6: ZEP_LLM_REFLEXION ====");
  const msg = {
    actor: "user" as const,
    content:
      "I've been getting really into bouldering lately, and also reading more philosophy.",
  };

  setFlag("ZEP_LLM_REFLEXION", false);
  const baseline = await extractEntities(msg);
  console.log(
    `    baseline (${baseline.length}): ${baseline.map((e) => `${e.name}[${e.type}]`).join(", ") || "(none)"}`,
  );

  setFlag("ZEP_LLM_REFLEXION", true);
  const flagged = await extractEntities(msg);
  setFlag("ZEP_LLM_REFLEXION", false);
  console.log(
    `    flagged  (${flagged.length}): ${flagged.map((e) => `${e.name}[${e.type}]`).join(", ") || "(none)"}`,
  );

  // Reflexion is non-deterministic. Only assert the path runs and returns
  // well-formed entities — never assert > or < count, since LLMs vary.
  assert(Array.isArray(flagged), "flagged: returns array");
  assert(
    flagged.every(
      (e) =>
        typeof e.name === "string" &&
        e.name.length > 0 &&
        typeof e.type === "string" &&
        typeof e.summary === "string",
    ),
    "flagged: each entity well-formed (name+type+summary)",
  );
}

// ─── Tier 2.7: hybrid entity resolution (cosine + LLM) ───────────────
async function testHybridResolve() {
  console.log("\n==== Tier 2.7: ZEP_LLM_ENTITY_RESOLVE ====");
  await cleanup();

  // Seed: create "Anthropic" via the real resolver path + put vector in Pinecone
  const rawSeed: RawEntity[] = [
    {
      name: "Anthropic",
      type: "COMPANY",
      summary: "An AI safety company that builds Claude.",
    },
  ];
  const seeded = await resolveEntities(TEST_USER_ID, rawSeed);
  assert(seeded.length === 1 && seeded[0].isNew, "seed: Anthropic created NEW");
  const anthropicId = seeded[0].entityId;
  await upsertEntityVectors(seeded);
  console.log(`    waiting 2s for Pinecone propagation...`);
  await sleep(2000);

  const rawNew: RawEntity[] = [
    {
      name: "Anthropic Inc.",
      type: "COMPANY",
      summary: "The AI safety lab building Claude.",
    },
  ];

  // Baseline: flag off → normalized name differs → new entity
  setFlag("ZEP_LLM_ENTITY_RESOLVE", false);
  const baseline = await resolveEntities(TEST_USER_ID, rawNew);
  assert(baseline.length === 1, "baseline: 1 resolved");
  assert(baseline[0].isNew, "baseline: created NEW (no hybrid path)");
  assert(
    baseline[0].entityId !== anthropicId,
    "baseline: different entityId from seed",
  );
  // Remove the duplicate so the flagged path has a clean starting state
  await deleteEntityById(baseline[0].entityId);

  // Flag on → should resolve back to the seed
  setFlag("ZEP_LLM_ENTITY_RESOLVE", true);
  const flagged = await resolveEntities(TEST_USER_ID, rawNew);
  setFlag("ZEP_LLM_ENTITY_RESOLVE", false);
  assert(flagged.length === 1, "flagged: 1 resolved");
  console.log(
    `    flagged: entityId=${flagged[0].entityId.slice(0, 8)}.. isNew=${flagged[0].isNew} name="${flagged[0].name}"`,
  );
  assert(!flagged[0].isNew, "flagged: resolved to EXISTING entity");
  assert(
    flagged[0].entityId === anthropicId,
    'flagged: same entityId as seed ("Anthropic" ≡ "Anthropic Inc.")',
  );
}

// ─── Tier 2.8: semantic edge invalidation ────────────────────────────
async function testSemanticInvalidation() {
  console.log("\n==== Tier 2.8: ZEP_LLM_INVALIDATE ====");
  await cleanup();
  await ensureUser();

  const boston: GraphEntity = {
    entityId: randomUUID(),
    userId: TEST_USER_ID,
    name: "Boston",
    normalizedName: "boston",
    type: "LOCATION",
    summary: "A city in Massachusetts.",
  };
  const tokyo: GraphEntity = {
    entityId: randomUUID(),
    userId: TEST_USER_ID,
    name: "Tokyo",
    normalizedName: "tokyo",
    type: "LOCATION",
    summary: "The capital of Japan.",
  };
  await upsertEntities([boston, tokyo]);

  function makeSeedFact(): GraphFact {
    return {
      factId: randomUUID(),
      sourceEntityId: TEST_USER_ID,
      targetEntityId: boston.entityId,
      relationType: "LIVES_IN",
      factText: "The user lives in Boston.",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: null,
      confidence: 0.99,
      episodeId: randomUUID(),
    };
  }
  await upsertFact(makeSeedFact());

  // New fact: same idea, different relationType ⇒ rule path can't catch it
  const newFact: RawFact = {
    sourceEntityId: TEST_USER_ID,
    targetEntityId: tokyo.entityId,
    relationType: "RESIDES_IN",
    factText: "The user resides in Tokyo.",
    confidence: 0.99,
  };
  const occurredAt = "2026-05-12T10:00:00.000Z";
  const ctx = {
    current: { actor: "user" as const, content: "I now live in Tokyo." },
    recent: [],
  };

  // Baseline: rule misses cross-predicate contradiction
  setFlag("ZEP_LLM_INVALIDATE", false);
  await applyTemporalFacts([newFact], [], randomUUID(), occurredAt, ctx);
  let opens = await findOpenFactsForSource(TEST_USER_ID);
  assert(
    opens.find((o) => o.relationType === "LIVES_IN") !== undefined,
    "baseline: Boston/LIVES_IN STILL open (rule path can't see cross-predicate)",
  );
  assert(
    opens.find((o) => o.relationType === "RESIDES_IN") !== undefined,
    "baseline: Tokyo/RESIDES_IN written",
  );

  // Reset + flag on
  await cleanup();
  await ensureUser();
  await upsertEntities([boston, tokyo]);
  await upsertFact(makeSeedFact());

  setFlag("ZEP_LLM_INVALIDATE", true);
  await applyTemporalFacts([newFact], [], randomUUID(), occurredAt, ctx);
  setFlag("ZEP_LLM_INVALIDATE", false);

  opens = await findOpenFactsForSource(TEST_USER_ID);
  console.log(`    open facts after flagged: ${opens.length}`);
  for (const o of opens) {
    console.log(`      ${o.relationType}: "${o.factText}"`);
  }
  assert(
    opens.find((o) => o.relationType === "LIVES_IN") === undefined,
    "flagged: Boston CLOSED via semantic invalidation (Tier 2.8)",
  );
  assert(
    opens.find((o) => o.relationType === "RESIDES_IN") !== undefined,
    "flagged: Tokyo still open",
  );
}

// ─── Tier 2.9: pair-scoped semantic fact dedup ───────────────────────
async function testPairScopedDedup() {
  console.log("\n==== Tier 2.9: ZEP_LLM_FACT_DEDUP ====");
  await cleanup();
  await ensureUser();

  const company: GraphEntity = {
    entityId: randomUUID(),
    userId: TEST_USER_ID,
    name: "Anthropic",
    normalizedName: "anthropic",
    type: "COMPANY",
    summary: "AI safety company.",
  };
  await upsertEntity(company);

  const seedFactId = randomUUID();
  function makeSeedFact(): GraphFact {
    return {
      factId: seedFactId,
      sourceEntityId: TEST_USER_ID,
      targetEntityId: company.entityId,
      relationType: "WORKS_AT",
      factText: "The user works at Anthropic.",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: null,
      confidence: 0.9,
      episodeId: randomUUID(),
    };
  }
  await upsertFact(makeSeedFact());

  // Same (source, target), different relationType, semantically equivalent text
  const newFact: RawFact = {
    sourceEntityId: TEST_USER_ID,
    targetEntityId: company.entityId,
    relationType: "EMPLOYED_BY",
    factText: "The user is employed by Anthropic.",
    confidence: 0.95,
  };
  const occurredAt = "2026-05-12T10:00:00.000Z";
  const ctx = {
    current: {
      actor: "user" as const,
      content: "I'm employed by Anthropic.",
    },
    recent: [],
  };

  // Baseline: two edges
  setFlag("ZEP_LLM_FACT_DEDUP", false);
  await applyTemporalFacts([newFact], [], randomUUID(), occurredAt, ctx);
  let pair = await findFactsBySourceAndTarget(TEST_USER_ID, company.entityId);
  assert(pair.length === 2, `baseline: 2 edges (got ${pair.length})`);

  // Reset + flag on
  await cleanup();
  await ensureUser();
  await upsertEntity(company);
  await upsertFact(makeSeedFact());

  setFlag("ZEP_LLM_FACT_DEDUP", true);
  const newEpId = randomUUID();
  await applyTemporalFacts([newFact], [], newEpId, occurredAt, ctx);
  setFlag("ZEP_LLM_FACT_DEDUP", false);

  pair = await findFactsBySourceAndTarget(TEST_USER_ID, company.entityId);
  console.log(`    edges after flagged: ${pair.length}`);
  for (const p of pair) console.log(`      ${p.relationType}: "${p.factText}"`);
  assert(pair.length === 1, "flagged: 1 edge (semantic dedup merged)");

  // Verify the merge reinforced the seed (not the other way around)
  const session = neo4jDriver.session();
  try {
    const result = await session.run(
      `MATCH ()-[f:FACT { factId: $factId }]->()
       RETURN coalesce(f.episodeIds, [f.episodeId]) AS eps,
              f.confidence AS conf,
              toString(f.lastSeenAt) AS lastSeenAt`,
      { factId: seedFactId },
    );
    const rec = result.records[0];
    if (!rec) {
      assert(false, "flagged: seed factId still present");
    } else {
      const eps = rec.get("eps") as string[];
      const conf = rec.get("conf") as number;
      const lastSeenAt = rec.get("lastSeenAt") as string;
      console.log(
        `    seed fact after reinforce: episodeIds=[${eps.length}], conf=${conf}, lastSeenAt=${lastSeenAt}`,
      );
      assert(
        eps.includes(newEpId),
        "flagged: seed.episodeIds contains the new episode",
      );
      assert(conf >= 0.91, "flagged: seed confidence bumped");
      assert(
        lastSeenAt?.startsWith("2026-05-12") ?? false,
        "flagged: seed lastSeenAt updated to new occurredAt",
      );
    }
  } finally {
    await session.close();
  }
}

async function main() {
  await testTemporalExtraction();
  await testReflexion();
  await testHybridResolve();
  await testSemanticInvalidation();
  await testPairScopedDedup();

  console.log("\nCleaning up...");
  await cleanup();

  console.log(`\n==== ${passed} passed, ${failed} failed ====`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
