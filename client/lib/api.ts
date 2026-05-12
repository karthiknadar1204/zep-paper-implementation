const BASE_URL = process.env.NEXT_PUBLIC_API_URL || "http://localhost:3002";

const TOKEN_STORAGE_KEY = "zep.token";
const USER_STORAGE_KEY = "zep.user";

export type StoredUser = {
  userId: string;
  email: string;
};

export function getToken(): string | null {
  if (typeof window === "undefined") return null;
  return window.localStorage.getItem(TOKEN_STORAGE_KEY);
}

export function getStoredUser(): StoredUser | null {
  if (typeof window === "undefined") return null;
  const raw = window.localStorage.getItem(USER_STORAGE_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as StoredUser;
  } catch {
    return null;
  }
}

export function saveSession(token: string, user: StoredUser) {
  window.localStorage.setItem(TOKEN_STORAGE_KEY, token);
  window.localStorage.setItem(USER_STORAGE_KEY, JSON.stringify(user));
}

export function clearSession() {
  window.localStorage.removeItem(TOKEN_STORAGE_KEY);
  window.localStorage.removeItem(USER_STORAGE_KEY);
}

export class ApiError extends Error {
  status: number;
  body: unknown;
  constructor(status: number, body: unknown, message: string) {
    super(message);
    this.status = status;
    this.body = body;
    this.name = "ApiError";
  }
}

type FetchOptions = {
  method?: string;
  body?: unknown;
  authenticated?: boolean;
  signal?: AbortSignal;
};

export async function api<T = unknown>(
  path: string,
  options: FetchOptions = {},
): Promise<T> {
  const {
    method = "GET",
    body,
    authenticated = true,
    signal,
  } = options;

  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };

  if (authenticated) {
    const token = getToken();
    if (token) headers["Authorization"] = `Bearer ${token}`;
  }

  const res = await fetch(`${BASE_URL}${path}`, {
    method,
    headers,
    body: body !== undefined ? JSON.stringify(body) : undefined,
    signal,
  });

  let parsed: unknown = null;
  const text = await res.text();
  if (text) {
    try {
      parsed = JSON.parse(text);
    } catch {
      parsed = text;
    }
  }

  if (!res.ok) {
    if (res.status === 401) {
      clearSession();
    }
    const message =
      (parsed && typeof parsed === "object" && "error" in parsed
        ? String((parsed as { error: unknown }).error)
        : null) ?? `Request failed with status ${res.status}`;
    throw new ApiError(res.status, parsed, message);
  }

  return parsed as T;
}

export type AuthResponse = {
  token: string;
  userId: string;
  email: string;
};

export type Session = {
  id: string;
  userId: string;
  title: string | null;
  createdAt: string;
};

export type EpisodeStatus = "queued" | "processing" | "processed" | "failed";

export type Episode = {
  id: string;
  userId: string;
  sessionId: string;
  actor: "user" | "assistant" | "system";
  content: string;
  status: EpisodeStatus;
  metadata: unknown;
  occurredAt: string;
  createdAt: string;
  processedAt: string | null;
};

export type ProcessingLog = {
  id: string;
  episodeId: string;
  step: string;
  status: "ok" | "error";
  message: string | null;
  durationMs: number | null;
  createdAt: string;
};

export type IngestResponse = {
  episodeId: string;
  status: EpisodeStatus;
};

export type GraphEntityNode = {
  entityId: string;
  name: string;
  normalizedName: string;
  type: string;
  summary: string;
};

export type GraphFactEdge = {
  factId: string;
  sourceId: string;
  targetId: string;
  relationType: string;
  factText: string;
  validFrom: string;
  validUntil: string | null;
  confidence: number;
};

export type GraphEpisodeNode = {
  episodeId: string;
  sessionId: string;
  actor: string;
  content: string;
  occurredAt: string;
};

export type GraphMentionEdge = {
  episodeId: string;
  entityId: string;
};

export type GraphSnapshot = {
  entities: GraphEntityNode[];
  facts: GraphFactEdge[];
  episodes: GraphEpisodeNode[];
  mentions: GraphMentionEdge[];
};

export type GraphNodeDetail = {
  kind: "entity" | "episode";
  properties: Record<string, unknown>;
  outgoing: Array<{
    type: string;
    relationType?: string;
    properties: Record<string, unknown>;
    other: { id: string; kind: "entity" | "episode"; name?: string };
  }>;
  incoming: Array<{
    type: string;
    relationType?: string;
    properties: Record<string, unknown>;
    other: { id: string; kind: "entity" | "episode"; name?: string };
  }>;
};

export type ScoredFact = {
  factId: string;
  sourceId: string;
  sourceName: string;
  sourceType: string;
  relationType: string;
  targetId: string;
  targetName: string;
  targetType: string;
  factText: string;
  validFrom: string;
  validUntil: string | null;
  confidence: number;
  hop: number;
  vectorScore: number;
  recencyScore: number;
  hopScore: number;
  llmScore?: number;
  totalScore: number;
};

export type RetrievalResult = {
  answer: string;
  context: string;
  facts: ScoredFact[];
  recentMessages: Array<{
    actor: string;
    content: string;
    occurredAt: string;
  }>;
  asOf: string;
};
