import { extractEntities } from "../src/services/extraction.service";

const samples = [
  "Hi, my name is Kevin and I work at Grok in San Francisco. I'm building a memory system for AI agents.",
  "Yesterday I met Karthik at the Anthropic office. He used to work at OpenAI on the Codex project.",
  "I love dogs.",
];

async function main() {
  for (const content of samples) {
    console.log("=".repeat(60));
    console.log("Input:", content);
    const entities = await extractEntities({ actor: "user", content });
    console.log("Extracted:");
    console.log(JSON.stringify(entities, null, 2));
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
