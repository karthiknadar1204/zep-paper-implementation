import { z } from "zod";
import { openai } from "../utils/openai";

const ENTITY_TYPES = [
  "PERSON",
  "COMPANY",
  "LOCATION",
  "CONCEPT",
  "PRODUCT",
  "DATE",
  "OTHER",
] as const;

export const RawEntitySchema = z.object({
  name: z.string().min(1),
  type: z.enum(ENTITY_TYPES),
  summary: z.string(),
});

const EntityListSchema = z.object({
  entities: z.array(RawEntitySchema),
});

export type RawEntity = z.infer<typeof RawEntitySchema>;

export type EpisodeMessage = {
  actor: "user" | "assistant" | "system";
  content: string;
};

const ENTITY_EXTRACTION_SYSTEM = `You are an entity extraction system for a long-term memory layer.

From the user's CURRENT message, extract every distinct thing worth remembering — people, organizations, places, products, dates, AND concepts the speaker has an opinion, preference, plan, or relationship to (hobbies, things they like/dislike, projects they are building, ideas they hold).

For each entity output:
- name: canonical form. "Apple Inc." not "apple". "Dogs" not "dogs". Multi-word noun phrases (e.g., "AI memory system", "machine learning model", "neural search engine") are SINGLE entities — do NOT split them into parts. If the current message refers back to something previously discussed using a shortened form ("the project", "it", "the system", "the company"), and the RECENT CONTEXT makes it unambiguous what's being referred to, use the FULL canonical name from the recent context.
- type: one of PERSON, COMPANY, LOCATION, CONCEPT, PRODUCT, DATE, OTHER
- summary: one short sentence grounded ONLY in what the messages say

Rules:
- Extract ONLY entities that are referenced in the CURRENT message. DO NOT extract entities that appear in the recent context but are not referenced in the current message.
- Do NOT extract the speaker themselves. Their identity is tracked separately by the system.
- Do NOT invent entities that aren't in the text.
- Bare common nouns the speaker has a relationship to (likes, dislikes, owns, is building, plans, etc.) ARE entities — extract them as CONCEPT or PRODUCT.

Examples:

Recent context: (none)
Input: "I love dogs."
Output: { "entities": [ { "name": "Dogs", "type": "CONCEPT", "summary": "Something the speaker loves." } ] }

Recent context: (none)
Input: "Yesterday I met Karthik at the Anthropic office."
Output: { "entities": [
  { "name": "Karthik", "type": "PERSON", "summary": "Someone the speaker met yesterday." },
  { "name": "Anthropic", "type": "COMPANY", "summary": "Company whose office the speaker visited." }
] }

Recent context: (none)
Input: "I'm building an AI memory system at Grok in San Francisco."
Output: { "entities": [
  { "name": "AI memory system", "type": "CONCEPT", "summary": "A project the speaker is building." },
  { "name": "Grok", "type": "COMPANY", "summary": "Where the speaker is building the AI memory system." },
  { "name": "San Francisco", "type": "LOCATION", "summary": "City where the speaker is based." }
] }

Recent context:
user: I'm building an AI memory system at Grok in San Francisco.
Input: "I'm not building the memory system anymore."
Output: { "entities": [
  { "name": "AI memory system", "type": "CONCEPT", "summary": "A project the speaker has stopped working on." }
] }

Recent context:
user: I love dogs. I work at Grok.
Input: "What's the weather?"
Output: { "entities": [] }

Return JSON exactly: { "entities": [ { "name": string, "type": string, "summary": string } ] }`;

export async function extractEntities(
  current: EpisodeMessage,
  recent: EpisodeMessage[] = [],
): Promise<RawEntity[]> {
  const recentBlock = recent.length
    ? recent.map((m) => `${m.actor}: ${m.content}`).join("\n")
    : "(none)";

  const userPrompt = `[Recent context]
${recentBlock}

[Current message]
${current.actor}: ${current.content}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: ENTITY_EXTRACTION_SYSTEM },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return [];

  const json = JSON.parse(raw);
  const validated = EntityListSchema.parse(json);
  return validated.entities;
}

export type FactExtractionEntity = {
  entityId: string;
  name: string;
  type: string;
};

export const RawFactSchema = z.object({
  sourceEntityId: z.string().min(1),
  targetEntityId: z.string().min(1),
  relationType: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
  factText: z.string().min(1),
  confidence: z.number().min(0).max(1),
});

export const RawInvalidationSchema = z.object({
  sourceEntityId: z.string().min(1),
  targetEntityId: z.string().min(1),
  relationType: z.string().regex(/^[A-Z][A-Z0-9_]*$/),
});

const FactsResponseSchema = z.object({
  facts: z.array(RawFactSchema),
  invalidations: z.array(RawInvalidationSchema),
});

export type RawFact = z.infer<typeof RawFactSchema>;
export type RawInvalidation = z.infer<typeof RawInvalidationSchema>;
export type FactsExtractionResult = {
  facts: RawFact[];
  invalidations: RawInvalidation[];
};

const FACT_EXTRACTION_SYSTEM = `You are a fact extraction system for a temporal knowledge graph.

Given a message and a list of entities, extract TWO things:
1. NEW relationships between those entities ("facts").
2. EXISTING relationships that this message says are now ENDED ("invalidations").

Each fact is a triple: source → relation → target.
Each invalidation identifies a previously-true triple that should now be considered no longer current.

Rules:
- Use ONLY the entity IDs from the list below. Do NOT invent entities.
- Both source and target of every fact AND every invalidation must be in the list.
- The list may include a "User" entity — that represents the speaker. Use it as source for facts/invalidations about the speaker themselves.
- relationType: a short verb phrase in UPPER_SNAKE_CASE (e.g., WORKS_AT, LIVES_IN, FOUNDED, KNOWS, MET_AT, USED_TO_WORK_AT, LIKES, LOVES, WORKED_ON, BUILDING).
- factText: ONE short atomic sentence describing ONLY this triple. Do NOT verbatim-copy the source message — extract just the relationship and write it as a clean standalone fact.
- confidence: 0.0 to 1.0 — how strongly the message supports this fact.
- Resolve pronouns to their subject. "He used to work..." refers to the previously mentioned PERSON; use that PERSON's entityId as the source, NOT a different entity.
- Skip self-loops (source equals target).

NEGATION HANDLING (very important):
- Do NOT extract negation/cessation as a positive fact. Phrases like "I left X", "I quit X", "I no longer like Y", "X stopped working at Z" must NOT produce facts like LEFT_COMPANY, NO_LONGER_LIKES, STOPPED_WORKING_AT.
- Instead, emit an entry in \`invalidations\` naming the previously-true relation that has now ended. Use the canonical positive predicate (e.g., WORKS_AT, LIKES) — NOT a negation.
- If the message states both an ending AND a new state ("I left Grok and joined Anthropic"), emit a new fact for the new state AND an invalidation for the old one.

Examples:

Entities:
  e1 → "Kevin" [PERSON]
  e2 → "Grok" [COMPANY]
Message: "Kevin works at Grok."
Output: { "facts": [ { "sourceEntityId": "e1", "targetEntityId": "e2", "relationType": "WORKS_AT", "factText": "Kevin works at Grok.", "confidence": 0.99 } ], "invalidations": [] }

Entities:
  e1 → "Karthik" [PERSON]
  e2 → "OpenAI" [COMPANY]
  e3 → "Codex" [PRODUCT]
Message: "Karthik used to work at OpenAI on the Codex project."
Output: { "facts": [
  { "sourceEntityId": "e1", "targetEntityId": "e2", "relationType": "USED_TO_WORK_AT", "factText": "Karthik used to work at OpenAI.", "confidence": 0.99 },
  { "sourceEntityId": "e1", "targetEntityId": "e3", "relationType": "WORKED_ON", "factText": "Karthik worked on the Codex project.", "confidence": 0.95 }
], "invalidations": [] }

Entities:
  u1 → "User" [PERSON]
  e1 → "Dogs" [CONCEPT]
Message: "I love dogs."
Output: { "facts": [
  { "sourceEntityId": "u1", "targetEntityId": "e1", "relationType": "LOVES", "factText": "The user loves dogs.", "confidence": 0.99 }
], "invalidations": [] }

Entities:
  u1 → "User" [PERSON]
  e1 → "Grok" [COMPANY]
Message: "I left Grok last month."
Output: { "facts": [], "invalidations": [
  { "sourceEntityId": "u1", "targetEntityId": "e1", "relationType": "WORKS_AT" }
] }

Entities:
  u1 → "User" [PERSON]
  e1 → "Grok" [COMPANY]
  e2 → "Anthropic" [COMPANY]
Message: "I left Grok and joined Anthropic."
Output: { "facts": [
  { "sourceEntityId": "u1", "targetEntityId": "e2", "relationType": "WORKS_AT", "factText": "The user works at Anthropic.", "confidence": 0.99 }
], "invalidations": [
  { "sourceEntityId": "u1", "targetEntityId": "e1", "relationType": "WORKS_AT" }
] }

Entities:
  e1 → "Karthik" [PERSON]
  e2 → "Anthropic" [COMPANY]
Message: "What's the weather?"
Output: { "facts": [], "invalidations": [] }

Return JSON exactly: {
  "facts": [ { "sourceEntityId": string, "targetEntityId": string, "relationType": string, "factText": string, "confidence": number } ],
  "invalidations": [ { "sourceEntityId": string, "targetEntityId": string, "relationType": string } ]
}`;

export async function extractFacts(
  current: EpisodeMessage,
  recent: EpisodeMessage[],
  entities: FactExtractionEntity[],
): Promise<FactsExtractionResult> {
  const empty: FactsExtractionResult = { facts: [], invalidations: [] };
  if (entities.length < 2) return empty;

  const entityList = entities
    .map((e) => `  ${e.entityId} → "${e.name}" [${e.type}]`)
    .join("\n");

  const recentBlock = recent.length
    ? recent.map((m) => `${m.actor}: ${m.content}`).join("\n")
    : "(none)";

  const userPrompt = `Entities:
${entityList}

[Recent context]
${recentBlock}

[Current message]
${current.actor}: ${current.content}`;

  const completion = await openai.chat.completions.create({
    model: "gpt-4o-mini",
    response_format: { type: "json_object" },
    messages: [
      { role: "system", content: FACT_EXTRACTION_SYSTEM },
      { role: "user", content: userPrompt },
    ],
  });

  const raw = completion.choices[0]?.message?.content;
  if (!raw) return empty;

  const json = JSON.parse(raw);
  const validated = FactsResponseSchema.parse(json);

  const validIds = new Set(entities.map((e) => e.entityId));

  const facts = validated.facts.filter(
    (f) =>
      validIds.has(f.sourceEntityId) &&
      validIds.has(f.targetEntityId) &&
      f.sourceEntityId !== f.targetEntityId,
  );

  const invalidations = validated.invalidations.filter(
    (i) =>
      validIds.has(i.sourceEntityId) &&
      validIds.has(i.targetEntityId) &&
      i.sourceEntityId !== i.targetEntityId,
  );

  return { facts, invalidations };
}
