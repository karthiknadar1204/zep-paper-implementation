"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import { api, type Session } from "@/lib/api";
import { useAuth } from "./auth-provider";

type SessionState = {
  sessions: Session[];
  currentSessionId: string | null;
  setCurrentSessionId: (id: string | null) => void;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
  createSession: (title?: string) => Promise<Session>;
};

const SessionContext = createContext<SessionState | null>(null);

const ACTIVE_SESSION_KEY = "zep.activeSessionId";

export function SessionsProvider({ children }: { children: React.ReactNode }) {
  const { user } = useAuth();
  const [sessions, setSessions] = useState<Session[]>([]);
  const [currentSessionId, setCurrentSessionIdState] = useState<string | null>(
    null,
  );
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!user) {
      setSessions([]);
      setCurrentSessionIdState(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const res = await api<{ sessions: Session[] }>("/sessions");
      setSessions(res.sessions);
      const storedActive =
        typeof window !== "undefined"
          ? window.localStorage.getItem(ACTIVE_SESSION_KEY)
          : null;
      if (storedActive && res.sessions.some((s) => s.id === storedActive)) {
        setCurrentSessionIdState(storedActive);
      } else if (res.sessions.length > 0 && !currentSessionId) {
        setCurrentSessionIdState(res.sessions[0].id);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to load sessions");
    } finally {
      setLoading(false);
    }
  }, [user, currentSessionId]);

  useEffect(() => {
    void refresh();
  }, [user]);

  const setCurrentSessionId = useCallback((id: string | null) => {
    setCurrentSessionIdState(id);
    if (typeof window !== "undefined") {
      if (id) {
        window.localStorage.setItem(ACTIVE_SESSION_KEY, id);
      } else {
        window.localStorage.removeItem(ACTIVE_SESSION_KEY);
      }
    }
  }, []);

  const createSession = useCallback(
    async (title?: string): Promise<Session> => {
      const body = title ? { title } : {};
      const res = await api<{ session: Session }>("/sessions", {
        method: "POST",
        body,
      });
      setSessions((prev) => [res.session, ...prev]);
      setCurrentSessionId(res.session.id);
      return res.session;
    },
    [setCurrentSessionId],
  );

  const value = useMemo<SessionState>(
    () => ({
      sessions,
      currentSessionId,
      setCurrentSessionId,
      loading,
      error,
      refresh,
      createSession,
    }),
    [sessions, currentSessionId, loading, error, refresh, createSession, setCurrentSessionId],
  );

  return (
    <SessionContext.Provider value={value}>{children}</SessionContext.Provider>
  );
}

export function useSessions(): SessionState {
  const ctx = useContext(SessionContext);
  if (!ctx) throw new Error("useSessions must be used within SessionsProvider");
  return ctx;
}
