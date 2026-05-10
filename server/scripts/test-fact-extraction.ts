import {
  extractEntities,
  extractFacts,
} from "../src/services/extraction.service";
import {
  resolveEntities,
  getOrCreateSelfEntity,
} from "../src/services/resolver.service";
import { neo4jDriver } from "../src/utils/neo4j";

const TEST_USER_ID = "00000000-0000-0000-0000-000000000098";

const samples = [
  "Hi, my name is Kevin and I work at Grok in San Francisco.",
  "Yesterday I met Karthik at the Anthropic office. He used to work at OpenAI on the Codex project.",
  "I love dogs.",
];

async function main() {
  for (const content of samples) {
    console.log("=".repeat(60));
    console.log(`Message: ${content}`);

    const raw = await extractEntities({ actor: "user", content });
    const resolved = await resolveEntities(TEST_USER_ID, raw);
    const self = await getOrCreateSelfEntity(TEST_USER_ID);
    const allEntities = [self, ...resolved];

    console.log(`\nEntities (${allEntities.length}):`);
    for (const r of allEntities) {
      console.log(
        `  ${r.entityId.slice(0, 8)}.. ${r.isNew ? "[NEW]" : "[OLD]"}  ${r.name} [${r.type}]`,
      );
    }

    const facts = await extractFacts(
      { actor: "user", content },
      [],
      allEntities,
    );

    console.log(`\nFacts (${facts.length}):`);
    for (const f of facts) {
      const src = allEntities.find((e) => e.entityId === f.sourceEntityId);
      const tgt = allEntities.find((e) => e.entityId === f.targetEntityId);
      console.log(
        `  ${src?.name ?? "?"} -[${f.relationType}]-> ${tgt?.name ?? "?"}  (conf ${f.confidence})`,
      );
      console.log(`    "${f.factText}"`);
    }
    console.log();
  }

  console.log(`Cleanup:
  MATCH (e:Entity { userId: '${TEST_USER_ID}' }) DETACH DELETE e
`);
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
