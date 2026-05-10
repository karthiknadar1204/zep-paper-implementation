import {
  ensureIndices,
  upsertEntity,
  findEntitiesByNormalizedNames,
  normalizeEntityName,
} from "../src/services/neo4j.service";
import { neo4jDriver } from "../src/utils/neo4j";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000001";
const TEST_ENTITY_ID = "11111111-1111-1111-1111-111111111111";

async function main() {
  console.log("Ensuring indices...");
  await ensureIndices();

  console.log("\nUpserting test entity 'Karthik'...");
  const name = "Karthik";
  await upsertEntity({
    entityId: TEST_ENTITY_ID,
    userId: TEST_USER_ID,
    name,
    normalizedName: normalizeEntityName(name),
    type: "PERSON",
    summary: "A test entity (round-trip check).",
  });

  console.log("\nLooking up entities by normalized name...");
  const found = await findEntitiesByNormalizedNames(TEST_USER_ID, [
    normalizeEntityName("karthik"),
    normalizeEntityName("  KARTHIK  "),
    normalizeEntityName("Nonexistent Entity"),
  ]);
  console.log(`Found ${found.size} match(es):`);
  for (const [key, val] of found) {
    console.log(`  ${key} →`, val);
  }

  console.log(`
Test entity left in the graph for inspection:
  entityId: ${TEST_ENTITY_ID}

In Neo4j Browser, run:
  MATCH (e:Entity) RETURN e

To remove it later:
  MATCH (e:Entity { entityId: '${TEST_ENTITY_ID}' }) DETACH DELETE e
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
