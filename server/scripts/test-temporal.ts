import { randomUUID } from "node:crypto";
import { neo4jDriver } from "../src/utils/neo4j";
import { upsertEntity } from "../src/services/neo4j.service";
import { applyTemporalFacts } from "../src/services/temporal.service";
import type { RawFact } from "../src/services/extraction.service";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000097";
const DOGS_ID = "11111111-1111-1111-1111-111111110001";
const CATS_ID = "11111111-1111-1111-1111-111111110002";

async function setupEntities() {
  await upsertEntity({
    entityId: TEST_USER_ID,
    userId: TEST_USER_ID,
    name: "User",
    normalizedName: "user",
    type: "PERSON",
    summary: "Test self entity.",
  });
  await upsertEntity({
    entityId: DOGS_ID,
    userId: TEST_USER_ID,
    name: "Dogs",
    normalizedName: "dogs",
    type: "CONCEPT",
    summary: "Test entity (dogs).",
  });
  await upsertEntity({
    entityId: CATS_ID,
    userId: TEST_USER_ID,
    name: "Cats",
    normalizedName: "cats",
    type: "CONCEPT",
    summary: "Test entity (cats).",
  });
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

async function dumpFacts() {
  const session = neo4jDriver.session();
  try {
    const result = await session.run(
      `
      MATCH (a:Entity {userId: $userId})-[f:FACT]->(b:Entity)
      RETURN
        f.factId AS factId,
        a.name AS source,
        f.relationType AS rel,
        b.name AS target,
        f.factText AS text,
        f.validFrom AS validFrom,
        f.validUntil AS validUntil,
        f.tCreated AS tCreated,
        f.tExpired AS tExpired,
        coalesce(f.episodeIds, [f.episodeId]) AS episodeIds,
        f.confidence AS confidence,
        f.lastSeenAt AS lastSeenAt
      ORDER BY f.validFrom ASC, b.name ASC
      `,
      { userId: TEST_USER_ID },
    );
    return result.records.map((r) => ({
      factId: r.get("factId") as string,
      source: r.get("source") as string,
      rel: r.get("rel") as string,
      target: r.get("target") as string,
      text: r.get("text") as string,
      validFrom: r.get("validFrom")?.toString() ?? null,
      validUntil: r.get("validUntil")?.toString() ?? null,
      tCreated: r.get("tCreated")?.toString() ?? null,
      tExpired: r.get("tExpired")?.toString() ?? null,
      episodeIds: r.get("episodeIds") as string[],
      confidence: r.get("confidence") as number | null,
      lastSeenAt: r.get("lastSeenAt")?.toString() ?? null,
    }));
  } finally {
    await session.close();
  }
}

function logFacts(label: string) {
  return async () => {
    const facts = await dumpFacts();
    console.log(`\n${label}`);
    if (facts.length === 0) {
      console.log("  (none)");
      return;
    }
    for (const f of facts) {
      const status = f.validUntil ? `closed @ ${f.validUntil}` : "OPEN";
      console.log(`  ${f.source} -[${f.rel}]-> ${f.target} (${status})`);
      console.log(`    "${f.text}"`);
      console.log(`    validFrom: ${f.validFrom}`);
      console.log(`    tCreated:  ${f.tCreated}`);
      if (f.tExpired) console.log(`    tExpired:  ${f.tExpired}`);
      console.log(
        `    episodes:  [${f.episodeIds.length}] ${f.episodeIds.join(", ")}`,
      );
      console.log(
        `    confidence:${f.confidence}  lastSeenAt:${f.lastSeenAt}`,
      );
    }
  };
}

function makeFact(targetId: string, text: string): RawFact {
  return {
    sourceEntityId: TEST_USER_ID,
    targetEntityId: targetId,
    relationType: "LOVES",
    factText: text,
    confidence: 0.99,
  };
}

function assert(cond: unknown, msg: string) {
  if (!cond) {
    console.error(`  ✗ ASSERT FAILED: ${msg}`);
    process.exitCode = 1;
  } else {
    console.log(`  ✓ ${msg}`);
  }
}

async function main() {
  console.log("Cleaning prior test state...");
  await cleanup();
  console.log("Setting up test entities...");
  await setupEntities();

  // Pass 1: User LOVES Dogs at t1 — should create one open edge with
  // tCreated set and episodeIds = [ep1].
  const ep1 = randomUUID();
  const t1 = "2026-05-01T10:00:00.000Z";
  console.log(`\n=== Pass 1 @ ${t1} — User LOVES Dogs (ep ${ep1.slice(0, 8)}) ===`);
  const r1 = await applyTemporalFacts(
    [makeFact(DOGS_ID, "The user loves dogs.")],
    [],
    ep1,
    t1,
  );
  console.log(
    `→ written=${r1.written.length}, closed=${r1.closed.length}, skipped=${r1.skipped}`,
  );
  await logFacts("State after pass 1 (expect: Dogs OPEN, episodeIds=[ep1]):")();
  {
    const facts = await dumpFacts();
    assert(r1.written.length === 1, "pass 1: one fact written");
    assert(r1.closed.length === 0, "pass 1: nothing closed");
    assert(facts.length === 1, "pass 1: one edge total");
    assert(facts[0].tCreated !== null, "pass 1: tCreated set on insert");
    assert(facts[0].tExpired === null, "pass 1: tExpired NOT set yet");
    assert(facts[0].episodeIds.length === 1, "pass 1: episodeIds length 1");
    assert(facts[0].episodeIds[0] === ep1, "pass 1: episodeIds[0] === ep1");
  }

  // Pass 2: User LOVES Cats at t2 — Dogs should be closed (validUntil + tExpired),
  // Cats open.
  const ep2 = randomUUID();
  const t2 = "2026-05-02T10:00:00.000Z";
  console.log(`\n=== Pass 2 @ ${t2} — User LOVES Cats (contradicts Dogs) ===`);
  const r2 = await applyTemporalFacts(
    [makeFact(CATS_ID, "The user loves cats.")],
    [],
    ep2,
    t2,
  );
  console.log(
    `→ written=${r2.written.length}, closed=${r2.closed.length}, skipped=${r2.skipped}`,
  );
  await logFacts(`State after pass 2 (expect: Dogs closed, tExpired set, Cats OPEN):`)();
  {
    const facts = await dumpFacts();
    const dogs = facts.find((f) => f.target === "Dogs");
    const cats = facts.find((f) => f.target === "Cats");
    assert(r2.written.length === 1, "pass 2: one fact written (Cats)");
    assert(r2.closed.length === 1, "pass 2: one fact closed (Dogs)");
    assert(dogs?.validUntil !== null, "pass 2: Dogs has validUntil");
    assert(dogs?.tExpired !== null, "pass 2: Dogs has tExpired (Tier 1.1)");
    assert(cats?.validUntil === null, "pass 2: Cats is open");
  }

  // Pass 3: User LOVES Cats again at t3 — re-affirmation. Was skipped++.
  // Now: reinforceFact appends ep3 to episodeIds and bumps confidence.
  const ep3 = randomUUID();
  const t3 = "2026-05-03T10:00:00.000Z";
  console.log(`\n=== Pass 3 @ ${t3} — User LOVES Cats (re-affirmation) ===`);
  const r3 = await applyTemporalFacts(
    [makeFact(CATS_ID, "The user still loves cats.")],
    [],
    ep3,
    t3,
  );
  console.log(
    `→ written=${r3.written.length}, closed=${r3.closed.length}, skipped=${r3.skipped}`,
  );
  await logFacts("State after pass 3 (expect: Cats episodeIds=[ep2,ep3], conf bumped):")();
  {
    const facts = await dumpFacts();
    const cats = facts.find((f) => f.target === "Cats");
    assert(r3.written.length === 0, "pass 3: no NEW edge written");
    assert(r3.skipped === 1, "pass 3: one reaffirmation skipped");
    assert(cats?.episodeIds.length === 2, "pass 3: Cats episodeIds length 2 (Tier 1.2)");
    assert(cats?.episodeIds.includes(ep2) && cats?.episodeIds.includes(ep3),
      "pass 3: Cats episodeIds contains both ep2 and ep3");
    assert((cats?.confidence ?? 0) > 0.99, "pass 3: confidence bumped above 0.99");
    assert(cats?.lastSeenAt?.startsWith("2026-05-03") ?? false,
      "pass 3: lastSeenAt updated to t3");
  }

  // Pass 4: re-send ep3 (same episodeId) — should be idempotent.
  console.log(`\n=== Pass 4 @ ${t3} — same episode replayed (idempotency check) ===`);
  const r4 = await applyTemporalFacts(
    [makeFact(CATS_ID, "The user still loves cats.")],
    [],
    ep3,
    t3,
  );
  console.log(
    `→ written=${r4.written.length}, closed=${r4.closed.length}, skipped=${r4.skipped}`,
  );
  {
    const facts = await dumpFacts();
    const cats = facts.find((f) => f.target === "Cats");
    assert(cats?.episodeIds.length === 2,
      "pass 4: episodeIds STILL length 2 (idempotent on ep3)");
  }

  // Pass 5: explicit invalidation — User stopped loving Cats.
  const ep4 = randomUUID();
  const t4 = "2026-05-04T10:00:00.000Z";
  console.log(`\n=== Pass 5 @ ${t4} — explicit invalidation: User STOPPED LOVING Cats ===`);
  const r5 = await applyTemporalFacts(
    [],
    [{ sourceEntityId: TEST_USER_ID, targetEntityId: CATS_ID, relationType: "LOVES" }],
    ep4,
    t4,
  );
  console.log(
    `→ written=${r5.written.length}, closed=${r5.closed.length}, skipped=${r5.skipped}`,
  );
  await logFacts("State after pass 5 (expect: Cats CLOSED, tExpired set):")();
  {
    const facts = await dumpFacts();
    const cats = facts.find((f) => f.target === "Cats");
    assert(r5.closed.length === 1, "pass 5: one fact closed via explicit invalidation");
    assert(cats?.validUntil !== null, "pass 5: Cats has validUntil");
    assert(cats?.tExpired !== null, "pass 5: Cats has tExpired");
  }

  console.log("\nCleaning up...");
  await cleanup();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
