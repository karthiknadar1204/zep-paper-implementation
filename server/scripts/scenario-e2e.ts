// End-to-end scenario test against the running HTTP API.
//
// Prereqs (in two other terminals):
//   bun run dev      (server on :3002)
//   bun run worker
//
// All paper-faithful LLM paths (temporal extraction, reflexion, hybrid entity
// resolution, semantic invalidation, pair-scoped fact dedup) are ALWAYS ON.
const BASE = process.env.SCENARIO_BASE_URL ?? "http://localhost:3002";
const EMAIL = `e2e+${Date.now()}@x.com`;
const PASSWORD = "hunter22hunter22";

type JSONObj = Record<string, unknown>;

async function req<T = JSONObj>(
  method: "GET" | "POST",
  path: string,
  body?: JSONObj,
  token?: string,
): Promise<T> {
  const r = await fetch(`${BASE}${path}`, {
    method,
    headers: {
      "content-type": "application/json",
      ...(token ? { authorization: `Bearer ${token}` } : {}),
    },
    body: body ? JSON.stringify(body) : undefined,
  });
  const text = await r.text();
  if (!r.ok) {
    throw new Error(`${method} ${path} → ${r.status}: ${text}`);
  }
  return text ? (JSON.parse(text) as T) : ({} as T);
}

function sleep(ms: number) {
  return new Promise((res) => setTimeout(res, ms));
}

const MESSAGES = [
  "I love dogs. I'm building an AI memory system at Grok in San Francisco.",
  "I love cats now, not dogs.",
  "Yesterday I met Karthik at the Anthropic office. He used to work at OpenAI on the Codex project.",
  "My friend Mei lives in Tokyo and runs a startup called Aria.",
  "I'm not building the memory system anymore.",
];

const QUERIES = [
  "what does the user love",
  "tell me about my friend in Japan",
  "Karthik's work history",
  "what is the user currently building",
];

async function pollUntilProcessed(
  episodeId: string,
  token: string,
  maxWaitMs = 90_000,
): Promise<"processed" | "failed"> {
  const start = Date.now();
  while (Date.now() - start < maxWaitMs) {
    const { episode } = (await req<{ episode: { status: string } }>(
      "GET",
      `/episodes/${episodeId}`,
      undefined,
      token,
    )) as { episode: { status: string } };
    if (episode.status === "processed" || episode.status === "failed") {
      return episode.status as "processed" | "failed";
    }
    await sleep(1500);
  }
  throw new Error(`episode ${episodeId} did not finish within ${maxWaitMs}ms`);
}

async function main() {
  console.log(`Base: ${BASE}\n`);

  // signup + JWT
  console.log(`Signing up ${EMAIL}...`);
  const { token, userId } = (await req("POST", "/auth/signup", {
    email: EMAIL,
    password: PASSWORD,
  })) as { token: string; userId: string };
  console.log(`  userId=${userId}`);

  // session
  const { session } = (await req(
    "POST",
    "/sessions",
    { title: "scenario" },
    token,
  )) as { session: { id: string } };
  console.log(`  sessionId=${session.id}\n`);

  // ingest each message; space occurredAt 1 day apart so temporal ordering is clean
  const baseTime = new Date();
  baseTime.setUTCDate(baseTime.getUTCDate() - MESSAGES.length);

  const episodeIds: string[] = [];
  for (let i = 0; i < MESSAGES.length; i++) {
    const occurredAt = new Date(baseTime);
    occurredAt.setUTCDate(baseTime.getUTCDate() + i);
    occurredAt.setUTCHours(10, 0, 0, 0);

    console.log(
      `[ingest ${i + 1}/${MESSAGES.length} @ ${occurredAt.toISOString().slice(0, 16)}] "${MESSAGES[i]}"`,
    );
    const { episodeId } = (await req(
      "POST",
      "/ingest",
      {
        sessionId: session.id,
        actor: "user",
        content: MESSAGES[i],
        occurredAt: occurredAt.toISOString(),
      },
      token,
    )) as { episodeId: string };
    episodeIds.push(episodeId);
    console.log(`  → episodeId=${episodeId.slice(0, 8)}..`);
  }

  console.log(`\nWaiting for worker to process ${episodeIds.length} episodes...`);
  for (let i = 0; i < episodeIds.length; i++) {
    const status = await pollUntilProcessed(episodeIds[i], token);
    console.log(`  [${i + 1}] ${episodeIds[i].slice(0, 8)}.. → ${status}`);
    if (status === "failed") {
      const { logs } = (await req(
        "GET",
        `/episodes/${episodeIds[i]}`,
        undefined,
        token,
      )) as { logs: Array<{ step: string; status: string; message: string }> };
      for (const l of logs.filter((l) => l.status === "error")) {
        console.error(`    [ERR] ${l.step}: ${l.message}`);
      }
    }
  }

  // retrieve
  console.log(`\n${"=".repeat(72)}`);
  console.log(`RETRIEVAL`);
  console.log("=".repeat(72));

  for (const query of QUERIES) {
    console.log(`\n──── Q: ${query} ────`);
    const r = (await req(
      "POST",
      "/retrieve",
      { query, sessionId: session.id, limit: 6 },
      token,
    )) as {
      answer: string;
      facts: Array<{
        sourceName: string;
        relationType: string;
        targetName: string;
        factText: string;
        validFrom: string;
        validUntil: string | null;
        totalScore: number;
      }>;
    };
    console.log(`A: ${r.answer}`);
    console.log(`\nTop facts:`);
    if (r.facts.length === 0) {
      console.log(`  (none)`);
    } else {
      for (const f of r.facts) {
        const status = f.validUntil
          ? `closed @ ${f.validUntil.slice(0, 10)}`
          : "OPEN";
        console.log(
          `  [${f.totalScore.toFixed(2)}] ${f.sourceName} -[${f.relationType}]-> ${f.targetName} (${status})`,
        );
        console.log(`        "${f.factText}"`);
      }
    }
  }

  console.log(`\nDone. Inspect:\n  bun run verify`);
}

main().catch((err) => {
  console.error(err);
  process.exitCode = 1;
});
