import { desc, eq } from "drizzle-orm";
import { db } from "../src/models/db";
import { episodes, processingLogs } from "../src/models/schema";
import { neo4jDriver } from "../src/utils/neo4j";
import { queryVectors } from "../src/services/pinecone.service";

async function findMostRecentUserId(): Promise<string | null> {
  const [row] = await db
    .select({ userId: episodes.userId })
    .from(episodes)
    .orderBy(desc(episodes.createdAt))
    .limit(1);
  return row?.userId ?? null;
}

async function checkPostgres(userId: string) {
  console.log("\n" + "=".repeat(70));
  console.log("POSTGRES");
  console.log("=".repeat(70));

  const eps = await db
    .select()
    .from(episodes)
    .where(eq(episodes.userId, userId))
    .orderBy(desc(episodes.occurredAt));

  const statusCounts = eps.reduce<Record<string, number>>((acc, e) => {
    acc[e.status] = (acc[e.status] ?? 0) + 1;
    return acc;
  }, {});
  console.log(`\n${eps.length} episodes total — by status:`, statusCounts);

  console.log(`\nDetails (newest first):`);
  for (const ep of eps) {
    const logs = await db
      .select()
      .from(processingLogs)
      .where(eq(processingLogs.episodeId, ep.id));

    const okCount = logs.filter((l) => l.status === "ok").length;
    const errCount = logs.filter((l) => l.status === "error").length;

    console.log(
      `\n  [${ep.status.toUpperCase()}] ${ep.occurredAt.toISOString()}`,
    );
    console.log(`    "${ep.content.slice(0, 90)}${ep.content.length > 90 ? "..." : ""}"`);
    console.log(`    logs: ${okCount} ok, ${errCount} error`);
    if (errCount > 0) {
      for (const l of logs.filter((x) => x.status === "error")) {
        console.log(`      [ERR] ${l.step}: ${l.message}`);
      }
    }
  }
}

async function checkNeo4j(userId: string) {
  console.log("\n" + "=".repeat(70));
  console.log("NEO4J");
  console.log("=".repeat(70));

  const session = neo4jDriver.session();
  try {
    // Entities
    const entResult = await session.run(
      `MATCH (e:Entity {userId: $userId})
       RETURN e.name AS name, e.type AS type, e.entityId AS id
       ORDER BY e.type, e.name`,
      { userId },
    );
    const entByType: Record<string, number> = {};
    for (const r of entResult.records) {
      const t = r.get("type") as string;
      entByType[t] = (entByType[t] ?? 0) + 1;
    }
    console.log(`\nEntities (${entResult.records.length}) — by type:`, entByType);
    for (const r of entResult.records) {
      console.log(
        `  [${r.get("type")}] ${r.get("name")}  (${(r.get("id") as string).slice(0, 8)}...)`,
      );
    }

    // Facts
    const factResult = await session.run(
      `MATCH (a:Entity {userId: $userId})-[f:FACT]->(b:Entity)
       RETURN a.name AS src, f.relationType AS rel, b.name AS tgt,
              f.factText AS text, f.validFrom AS validFrom, f.validUntil AS validUntil
       ORDER BY f.validFrom`,
      { userId },
    );
    let open = 0;
    let closed = 0;
    console.log(`\nFacts (${factResult.records.length}):`);
    for (const r of factResult.records) {
      const validUntil = r.get("validUntil");
      const isOpen = validUntil === null;
      if (isOpen) open++;
      else closed++;
      const status = isOpen
        ? "OPEN"
        : `CLOSED @ ${validUntil.toString()}`;
      console.log(
        `  ${r.get("src")} -[${r.get("rel")}]-> ${r.get("tgt")}  (${status})`,
      );
      console.log(`    "${r.get("text")}"`);
    }
    console.log(`  → ${open} open, ${closed} closed`);

    // Episodes + mentions
    const mentResult = await session.run(
      `MATCH (ep:Episode {userId: $userId})-[:MENTIONS]->(e:Entity)
       RETURN ep.episodeId AS id, ep.content AS content,
              ep.occurredAt AS ts, collect(e.name) AS mentioned
       ORDER BY ep.occurredAt`,
      { userId },
    );
    console.log(`\nEpisode nodes (${mentResult.records.length}):`);
    for (const r of mentResult.records) {
      const content = r.get("content") as string;
      console.log(`  ${r.get("ts").toString()}`);
      console.log(`    "${content.slice(0, 80)}${content.length > 80 ? "..." : ""}"`);
      console.log(`    mentions: ${(r.get("mentioned") as string[]).join(", ")}`);
    }
  } finally {
    await session.close();
  }
}

async function checkPinecone(userId: string) {
  console.log("\n" + "=".repeat(70));
  console.log("PINECONE");
  console.log("=".repeat(70));

  const queries = [
    "where does the user live",
    "what does the user love now",
    "AI safety company",
    "the user's friend in Japan",
    "Karthik's previous employer",
  ];

  for (const q of queries) {
    console.log(`\nQuery: "${q}"`);
    const matches = await queryVectors(q, userId, 5);
    if (matches.length === 0) {
      console.log("  (no matches)");
      continue;
    }
    for (const m of matches) {
      const md = (m.metadata ?? {}) as Record<string, unknown>;
      const label =
        md.type === "entity"
          ? `entity: ${md.name as string} [${md.entityType as string}]`
          : `fact: "${md.factText as string}"`;
      console.log(`  [${m.score?.toFixed(3)}] ${label}`);
    }
  }
}

async function main() {
  const userId = await findMostRecentUserId();
  if (!userId) {
    console.log("No episodes found in Postgres. Have you ingested anything?");
    return;
  }

  console.log(`Verifying pipeline state for userId=${userId}`);

  await checkPostgres(userId);
  await checkNeo4j(userId);
  await checkPinecone(userId);

  console.log("\n" + "=".repeat(70));
  console.log("Done.");
  console.log("=".repeat(70));
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => neo4jDriver.close());
