"use client";

import { createContext, useCallback, useContext, useEffect, useMemo, useState } from "react";
import {
  api,
  type AuthResponse,
  clearSession,
  getStoredUser,
  saveSession,
  type StoredUser,
} from "@/lib/api";

type AuthState = {
  user: StoredUser | null;
  loading: boolean;
  login: (email: string, password: string) => Promise<void>;
  signup: (email: string, password: string) => Promise<void>;
  logout: () => void;
};

const AuthContext = createContext<AuthState | null>(null);

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<StoredUser | null>(null);
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    setUser(getStoredUser());
    setLoading(false);
  }, []);

  const login = useCallback(async (email: string, password: string) => {
    const res = await api<AuthResponse>("/auth/login", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
    saveSession(res.token, { userId: res.userId, email: res.email });
    setUser({ userId: res.userId, email: res.email });
  }, []);

  const signup = useCallback(async (email: string, password: string) => {
    const res = await api<AuthResponse>("/auth/signup", {
      method: "POST",
      body: { email, password },
      authenticated: false,
    });
    saveSession(res.token, { userId: res.userId, email: res.email });
    setUser({ userId: res.userId, email: res.email });
  }, []);

  const logout = useCallback(() => {
    clearSession();
    setUser(null);
  }, []);

  const value = useMemo<AuthState>(
    () => ({ user, loading, login, signup, logout }),
    [user, loading, login, signup, logout],
  );

  return <AuthContext.Provider value={value}>{children}</AuthContext.Provider>;
}

export function useAuth(): AuthState {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error("useAuth must be used within AuthProvider");
  return ctx;
}
