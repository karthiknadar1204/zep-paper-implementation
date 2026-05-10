import { extractEntities } from "../src/services/extraction.service";
import { resolveEntities } from "../src/services/resolver.service";
import { neo4jDriver } from "../src/utils/neo4j";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000099";

function logResolved(label: string, resolved: { isNew: boolean; name: string; entityId: string }[]) {
  console.log(`\n${label}`);
  for (const r of resolved) {
    console.log(`  [${r.isNew ? "NEW" : "OLD"}] ${r.name.padEnd(20)} ${r.entityId}`);
  }
}

async function runPass(label: string, content: string) {
  console.log(`\n${"=".repeat(60)}`);
  console.log(`${label}`);
  console.log(`Message: ${content}`);
  const raw = await extractEntities({ actor: "user", content });
  console.log(`Extracted ${raw.length} raw → resolving...`);
  const resolved = await resolveEntities(TEST_USER_ID, raw);
  logResolved("Resolved:", resolved);
  return resolved;
}

async function main() {
  await runPass(
    "Pass 1 — fresh batch, expect all NEW",
    "Hi, my name is Kevin and I work at Grok in San Francisco.",
  );

  await runPass(
    "Pass 2 — same message, expect all OLD with same entityIds",
    "Hi, my name is Kevin and I work at Grok in San Francisco.",
  );

  await runPass(
    "Pass 3 — different casing, expect OLD matches",
    "I told KEVIN about my work at grok yesterday.",
  );

  console.log(`
Test entities left in graph for inspection (userId=${TEST_USER_ID}).
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
