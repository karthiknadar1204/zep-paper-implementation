import {
  upsertEntityVectors,
  upsertFactVectors,
  queryVectors,
} from "../src/services/pinecone.service";
import { pineconeIndex } from "../src/utils/pinecone";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000096";
const E_KARTHIK = "11111111-1111-1111-1111-111111110011";
const E_ANTHROPIC = "11111111-1111-1111-1111-111111110012";
const F_WORKS_AT = "22222222-2222-2222-2222-222222220011";

async function sleep(ms: number) {
  return new Promise((r) => setTimeout(r, ms));
}

async function main() {
  console.log("Upserting test entities (2)...");
  const nEnt = await upsertEntityVectors([
    {
      entityId: E_KARTHIK,
      userId: TEST_USER_ID,
      name: "Karthik",
      normalizedName: "karthik",
      type: "PERSON",
      summary: "A senior engineer at Anthropic working on memory systems.",
      isNew: true,
    },
    {
      entityId: E_ANTHROPIC,
      userId: TEST_USER_ID,
      name: "Anthropic",
      normalizedName: "anthropic",
      type: "COMPANY",
      summary: "An AI safety company.",
      isNew: true,
    },
  ]);
  console.log(`  upserted ${nEnt} entity vector(s)`);

  console.log("\nUpserting test fact (1)...");
  const nFact = await upsertFactVectors(TEST_USER_ID, [
    {
      factId: F_WORKS_AT,
      sourceEntityId: E_KARTHIK,
      targetEntityId: E_ANTHROPIC,
      relationType: "WORKS_AT",
      factText: "Karthik works at Anthropic.",
      validFrom: "2026-01-01T00:00:00.000Z",
      validUntil: null,
      confidence: 0.99,
      episodeId: "00000000-0000-0000-0000-0000000000aa",
      isNew: true,
    },
  ]);
  console.log(`  upserted ${nFact} fact vector(s)`);

  console.log("\nWaiting 1.5s for index propagation...");
  await sleep(1500);

  console.log("\nQuery 1 — 'AI safety company' (should hit Anthropic):");
  const r1 = await queryVectors("AI safety company", TEST_USER_ID, 5);
  for (const m of r1) {
    console.log(
      `  score=${m.score?.toFixed(3)}  type=${m.metadata?.type}  name/text=${m.metadata?.name ?? m.metadata?.factText}  (id=${m.id})`,
    );
  }

  console.log("\nQuery 2 — 'engineer at Anthropic' (should hit Karthik + the fact):");
  const r2 = await queryVectors("engineer at Anthropic", TEST_USER_ID, 5);
  for (const m of r2) {
    console.log(
      `  score=${m.score?.toFixed(3)}  type=${m.metadata?.type}  name/text=${m.metadata?.name ?? m.metadata?.factText}  (id=${m.id})`,
    );
  }

  console.log("\nQuery 3 — entity-only filter on 'who works at Anthropic':");
  const r3 = await queryVectors("who works at Anthropic", TEST_USER_ID, 5, {
    type: "entity",
  });
  for (const m of r3) {
    console.log(
      `  score=${m.score?.toFixed(3)}  type=${m.metadata?.type}  name=${m.metadata?.name}  (id=${m.id})`,
    );
  }

  console.log("\nCleaning up test vectors...");
  await pineconeIndex.deleteMany({ ids: [E_KARTHIK, E_ANTHROPIC, F_WORKS_AT] });
  console.log("Done.");
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
