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
        f.validUntil AS validUntil
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

async function main() {
  console.log("Setting up test entities...");
  await setupEntities();

  // Pass 1: User LOVES Dogs at t1 — should create one open edge
  const t1 = "2026-05-01T10:00:00.000Z";
  console.log(`\n=== Pass 1 @ ${t1} — User LOVES Dogs ===`);
  const r1 = await applyTemporalFacts(
    [makeFact(DOGS_ID, "The user loves dogs.")],
    randomUUID(),
    t1,
  );
  console.log(
    `→ written=${r1.written.length}, closed=${r1.closed.length}, skipped=${r1.skipped}`,
  );
  await logFacts("State after pass 1 (expect: Dogs OPEN):")();

  // Pass 2: User LOVES Cats at t2 — Dogs should be closed, Cats open
  const t2 = "2026-05-02T10:00:00.000Z";
  console.log(`\n=== Pass 2 @ ${t2} — User LOVES Cats (contradicts Dogs) ===`);
  const r2 = await applyTemporalFacts(
    [makeFact(CATS_ID, "The user loves cats.")],
    randomUUID(),
    t2,
  );
  console.log(
    `→ written=${r2.written.length}, closed=${r2.closed.length}, skipped=${r2.skipped}`,
  );
  await logFacts(`State after pass 2 (expect: Dogs closed @ ${t2}, Cats OPEN):`)();

  // Pass 3: User LOVES Cats again at t3 — re-affirmation, no changes
  const t3 = "2026-05-03T10:00:00.000Z";
  console.log(`\n=== Pass 3 @ ${t3} — User LOVES Cats (re-affirmation) ===`);
  const r3 = await applyTemporalFacts(
    [makeFact(CATS_ID, "The user still loves cats.")],
    randomUUID(),
    t3,
  );
  console.log(
    `→ written=${r3.written.length}, closed=${r3.closed.length}, skipped=${r3.skipped}`,
  );
  await logFacts("State after pass 3 (expect: unchanged from pass 2):")();

  console.log(`
Test entities + facts left in graph for inspection (userId=${TEST_USER_ID}).
Cleanup:
  MATCH (e:Entity { userId: '${TEST_USER_ID}' }) DETACH DELETE e
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
