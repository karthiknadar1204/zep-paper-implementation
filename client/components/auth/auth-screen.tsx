"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { useAuth } from "@/components/providers/auth-provider";
import { ApiError } from "@/lib/api";
import { Brain } from "lucide-react";

type Mode = "login" | "signup";

export function AuthScreen() {
  const { login, signup } = useAuth();
  const [mode, setMode] = useState<Mode>("login");
  const [email, setEmail] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  async function onSubmit(e: React.FormEvent) {
    e.preventDefault();
    setError(null);
    setBusy(true);
    try {
      if (mode === "login") {
        await login(email, password);
      } else {
        await signup(email, password);
      }
    } catch (err) {
      if (err instanceof ApiError) {
        if (err.status === 401) {
          setError("Invalid email or password.");
        } else if (err.status === 409) {
          setError("An account with this email already exists.");
        } else if (err.status === 400) {
          setError("Email must be valid and password must be at least 8 characters.");
        } else {
          setError(err.message);
        }
      } else {
        setError(err instanceof Error ? err.message : "Something went wrong.");
      }
    } finally {
      setBusy(false);
    }
  }

  return (
    <div className="min-h-screen flex items-center justify-center px-6 bg-muted/30">
      <div className="w-full max-w-md flex flex-col items-center">
        <div className="flex items-center gap-2 mb-8 text-foreground">
          <Brain className="h-6 w-6" strokeWidth={1.75} />
          <span className="font-semibold tracking-tight text-lg">Zep Memory</span>
        </div>
        <Card className="w-full">
          <CardHeader>
            <CardTitle className="text-xl">
              {mode === "login" ? "Sign in" : "Create an account"}
            </CardTitle>
            <CardDescription>
              {mode === "login"
                ? "Welcome back. Enter your credentials to continue."
                : "A new email + password is all you need."}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form onSubmit={onSubmit} className="flex flex-col gap-4">
              <div className="flex flex-col gap-2">
                <Label htmlFor="email">Email</Label>
                <Input
                  id="email"
                  type="email"
                  autoComplete="email"
                  required
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  disabled={busy}
                  placeholder="you@example.com"
                />
              </div>
              <div className="flex flex-col gap-2">
                <Label htmlFor="password">Password</Label>
                <Input
                  id="password"
                  type="password"
                  autoComplete={mode === "login" ? "current-password" : "new-password"}
                  required
                  minLength={8}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  disabled={busy}
                  placeholder="At least 8 characters"
                />
              </div>
              {error ? (
                <div className="text-sm text-destructive rounded-md border border-destructive/30 bg-destructive/5 px-3 py-2">
                  {error}
                </div>
              ) : null}
              <Button type="submit" disabled={busy} className="mt-2">
                {busy ? "Working…" : mode === "login" ? "Sign in" : "Create account"}
              </Button>
            </form>
            <div className="mt-4 text-sm text-muted-foreground text-center">
              {mode === "login" ? (
                <>
                  No account?{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground hover:underline"
                    onClick={() => {
                      setMode("signup");
                      setError(null);
                    }}
                  >
                    Sign up
                  </button>
                </>
              ) : (
                <>
                  Already have one?{" "}
                  <button
                    type="button"
                    className="font-medium text-foreground hover:underline"
                    onClick={() => {
                      setMode("login");
                      setError(null);
                    }}
                  >
                    Sign in
                  </button>
                </>
              )}
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
