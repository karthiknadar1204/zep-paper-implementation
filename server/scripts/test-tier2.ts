// Paper-faithful path smoke test.
// All five previously-flagged paths are now ALWAYS ON. This test verifies that
// each one produces its expected outcome on a targeted fixture. Costs ~$0.01 in
// OpenAI API per run.
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

// ─── LLM event-time extraction (was Tier 2.5) ────────────────────────
async function testTemporalExtraction() {
  console.log("\n==== LLM event-time extraction ====");
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

  await applyTemporalFacts(facts, [], randomUUID(), occurredAt, ctx);
  const opens = await findOpenFactsForSource(TEST_USER_ID);
  assert(opens.length === 1, "1 open fact written");
  console.log(`    validFrom: ${opens[0].validFrom}`);
  const year = parseInt(opens[0].validFrom.slice(0, 4), 10);
  assert(
    year <= 2024,
    `validFrom year ≤ 2024 (got ${year}; "two years ago" from 2026-05)`,
  );
}

// ─── Reflexion entity-extraction pass (was Tier 2.6) ─────────────────
async function testReflexion() {
  console.log("\n==== Reflexion entity-extraction pass ====");
  const msg = {
    actor: "user" as const,
    content:
      "I've been getting really into bouldering lately, and also reading more philosophy.",
  };

  const result = await extractEntities(msg);
  console.log(
    `    extracted (${result.length}): ${result.map((e) => `${e.name}[${e.type}]`).join(", ") || "(none)"}`,
  );

  // Non-deterministic. Only assert the path runs and returns well-formed entities.
  assert(Array.isArray(result), "returns array");
  assert(
    result.every(
      (e) =>
        typeof e.name === "string" &&
        e.name.length > 0 &&
        typeof e.type === "string" &&
        typeof e.summary === "string",
    ),
    "each entity well-formed (name+type+summary)",
  );
}

// ─── Hybrid entity resolution (was Tier 2.7) ─────────────────────────
async function testHybridResolve() {
  console.log("\n==== Hybrid cosine+LLM entity resolution ====");
  await cleanup();

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

  const result = await resolveEntities(TEST_USER_ID, rawNew);
  assert(result.length === 1, "1 resolved");
  console.log(
    `    entityId=${result[0].entityId.slice(0, 8)}.. isNew=${result[0].isNew} name="${result[0].name}"`,
  );
  assert(!result[0].isNew, "resolved to EXISTING entity (hybrid path)");
  assert(
    result[0].entityId === anthropicId,
    'same entityId as seed ("Anthropic" ≡ "Anthropic Inc.")',
  );
}

// ─── Semantic edge invalidation (was Tier 2.8) ───────────────────────
async function testSemanticInvalidation() {
  console.log("\n==== Semantic edge invalidation ====");
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

  // New fact: same idea, different relationType ⇒ rule path alone cannot catch
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

  await applyTemporalFacts([newFact], [], randomUUID(), occurredAt, ctx);

  const opens = await findOpenFactsForSource(TEST_USER_ID);
  console.log(`    open facts after ingest: ${opens.length}`);
  for (const o of opens) {
    console.log(`      ${o.relationType}: "${o.factText}"`);
  }
  assert(
    opens.find((o) => o.relationType === "LIVES_IN") === undefined,
    "Boston/LIVES_IN CLOSED via semantic invalidation (cross-predicate)",
  );
  assert(
    opens.find((o) => o.relationType === "RESIDES_IN") !== undefined,
    "Tokyo/RESIDES_IN still open",
  );
}

// ─── Pair-scoped semantic fact dedup (was Tier 2.9) ──────────────────
async function testPairScopedDedup() {
  console.log("\n==== Pair-scoped semantic fact dedup ====");
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

  const newEpId = randomUUID();
  await applyTemporalFacts([newFact], [], newEpId, occurredAt, ctx);

  const pair = await findFactsBySourceAndTarget(TEST_USER_ID, company.entityId);
  console.log(`    edges after ingest: ${pair.length}`);
  for (const p of pair) console.log(`      ${p.relationType}: "${p.factText}"`);
  assert(pair.length === 1, "1 edge (semantic dedup merged the duplicate)");

  // Verify the seed got reinforced (not the other way around)
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
      assert(false, "seed factId still present");
    } else {
      const eps = rec.get("eps") as string[];
      const conf = rec.get("conf") as number;
      const lastSeenAt = rec.get("lastSeenAt") as string;
      console.log(
        `    seed fact after reinforce: episodeIds=[${eps.length}], conf=${conf}, lastSeenAt=${lastSeenAt}`,
      );
      assert(
        eps.includes(newEpId),
        "seed.episodeIds contains the new episode",
      );
      assert(conf >= 0.91, "seed confidence bumped");
      assert(
        lastSeenAt?.startsWith("2026-05-12") ?? false,
        "seed lastSeenAt updated to new occurredAt",
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
