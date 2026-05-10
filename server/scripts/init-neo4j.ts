import { ensureIndices } from "../src/services/neo4j.service";
import { neo4jDriver } from "../src/utils/neo4j";

async function main() {
  console.log("Initializing Neo4j indices and constraints...");
  await ensureIndices();
  console.log("Done.");
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
