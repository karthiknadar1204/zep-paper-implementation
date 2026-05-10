import { desc } from "drizzle-orm";
import { db } from "../src/models/db";
import { episodes } from "../src/models/schema";
import { neo4jDriver } from "../src/utils/neo4j";
import { getContext } from "../src/services/retrieval.service";

async function findMostRecentUserId(): Promise<string | null> {
  const [row] = await db
    .select({ userId: episodes.userId })
    .from(episodes)
    .orderBy(desc(episodes.createdAt))
    .limit(1);
  return row?.userId ?? null;
}

const QUERIES = [
  "where does the user work and live",
  "what does the user love",
  "tell me about Karthik's career",
  "the user's friend in Japan",
  "what did the user used to love",
  "AI safety",
];

async function main() {
  const userId = await findMostRecentUserId();
  if (!userId) {
    console.log("No episodes found. Ingest something first.");
    return;
  }
  console.log(`Retrieval test for userId=${userId}\n`);

  for (const query of QUERIES) {
    console.log("=".repeat(72));
    console.log(`Q: ${query}`);
    console.log("=".repeat(72));

    const result = await getContext({ userId, query, limit: 6 });

    console.log("\n--- ranked facts ---");
    if (result.facts.length === 0) {
      console.log("  (none)");
    } else {
      for (const f of result.facts) {
        console.log(
          `  [total=${f.totalScore.toFixed(3)} v=${f.vectorScore.toFixed(2)} r=${f.recencyScore.toFixed(2)} h=${f.hop}]`,
        );
        console.log(
          `    ${f.sourceName} -[${f.relationType}]-> ${f.targetName}`,
        );
        console.log(`    "${f.factText}"`);
      }
    }

    console.log("\n--- formatted context (what an agent would see) ---");
    console.log(result.context);
    console.log();
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
