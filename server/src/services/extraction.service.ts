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

From the user's CURRENT message (using the RECENT context only as disambiguation), extract every distinct thing worth remembering — people, organizations, places, products, dates, AND concepts the speaker has an opinion, preference, plan, or relationship to (hobbies, things they like/dislike, projects they are building, ideas they hold).

For each entity output:
- name: canonical form ("Apple Inc." not "apple", "Dogs" not "dogs")
- type: one of PERSON, COMPANY, LOCATION, CONCEPT, PRODUCT, DATE, OTHER
- summary: one short sentence grounded ONLY in what the messages say

Rules:
- Do NOT extract the speaker themselves. Their identity is tracked separately by the system.
- Do NOT invent entities that aren't in the text.
- Bare common nouns the speaker has a relationship to (likes, dislikes, owns, is building, plans, etc.) ARE entities — extract them as CONCEPT or PRODUCT.

Examples:

Input: "I love dogs."
Output: { "entities": [ { "name": "Dogs", "type": "CONCEPT", "summary": "Something the speaker loves." } ] }

Input: "Yesterday I met Karthik at the Anthropic office."
Output: { "entities": [
  { "name": "Karthik", "type": "PERSON", "summary": "Someone the speaker met yesterday." },
  { "name": "Anthropic", "type": "COMPANY", "summary": "Company whose office the speaker visited." }
] }

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

const FactListSchema = z.object({
  facts: z.array(RawFactSchema),
});

export type RawFact = z.infer<typeof RawFactSchema>;

const FACT_EXTRACTION_SYSTEM = `You are a fact extraction system for a knowledge graph.

Given a message and a list of entities, extract relationships BETWEEN those entities. Each fact is a triple: source → relation → target.

Rules:
- Use ONLY the entity IDs from the list below. Do NOT invent entities.
- Both source and target must be in the list.
- The list may include a "User" entity — that represents the speaker. Use it as source for facts about the speaker themselves (preferences, opinions, plans, where they live, who they know).
- relationType: a short verb phrase in UPPER_SNAKE_CASE (e.g., WORKS_AT, LIVES_IN, FOUNDED, KNOWS, MET_AT, USED_TO_WORK_AT, LIKES, LOVES, WORKED_ON, BUILDING).
- factText: ONE short atomic sentence describing ONLY this triple. Do NOT verbatim-copy the source message — extract just the relationship and write it as a clean standalone fact.
- confidence: 0.0 to 1.0 — how strongly the message supports this fact.
- Resolve pronouns to their subject. "He used to work..." refers to the previously mentioned PERSON; use that PERSON's entityId as the source, NOT a different entity.
- Skip facts that aren't explicitly stated or strongly implied.
- Skip self-loops (source equals target).

Examples:

Entities:
  e1 → "Kevin" [PERSON]
  e2 → "Grok" [COMPANY]
Message: "Kevin works at Grok."
Output: { "facts": [ { "sourceEntityId": "e1", "targetEntityId": "e2", "relationType": "WORKS_AT", "factText": "Kevin works at Grok.", "confidence": 0.99 } ] }

Entities:
  e1 → "Karthik" [PERSON]
  e2 → "OpenAI" [COMPANY]
  e3 → "Codex" [PRODUCT]
Message: "Karthik used to work at OpenAI on the Codex project."
Output: { "facts": [
  { "sourceEntityId": "e1", "targetEntityId": "e2", "relationType": "USED_TO_WORK_AT", "factText": "Karthik used to work at OpenAI.", "confidence": 0.99 },
  { "sourceEntityId": "e1", "targetEntityId": "e3", "relationType": "WORKED_ON", "factText": "Karthik worked on the Codex project.", "confidence": 0.95 }
] }

Entities:
  u1 → "User" [PERSON]
  e1 → "Dogs" [CONCEPT]
Message: "I love dogs."
Output: { "facts": [
  { "sourceEntityId": "u1", "targetEntityId": "e1", "relationType": "LOVES", "factText": "The user loves dogs.", "confidence": 0.99 }
] }

Entities:
  e1 → "Karthik" [PERSON]
  e2 → "Anthropic" [COMPANY]
Message: "What's the weather?"
Output: { "facts": [] }

Return JSON exactly: { "facts": [ { "sourceEntityId": string, "targetEntityId": string, "relationType": string, "factText": string, "confidence": number } ] }`;

export async function extractFacts(
  current: EpisodeMessage,
  recent: EpisodeMessage[],
  entities: FactExtractionEntity[],
): Promise<RawFact[]> {
  if (entities.length < 2) return [];

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
  if (!raw) return [];

  const json = JSON.parse(raw);
  const validated = FactListSchema.parse(json);

  const validIds = new Set(entities.map((e) => e.entityId));
  return validated.facts.filter(
    (f) =>
      validIds.has(f.sourceEntityId) &&
      validIds.has(f.targetEntityId) &&
      f.sourceEntityId !== f.targetEntityId,
  );
}
