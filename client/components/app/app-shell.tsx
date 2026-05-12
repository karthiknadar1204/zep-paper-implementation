"use client";

import { useCallback, useState } from "react";
import { SidebarInset, SidebarProvider, SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { useAuth } from "@/components/providers/auth-provider";
import { useSessions } from "@/components/providers/session-provider";
import { SessionsSidebar } from "./sessions-sidebar";
import { IngestPanel } from "./ingest-panel";
import { GraphPanel } from "./graph-panel";
import { RetrievePanel } from "./retrieve-panel";
import { AuthScreen } from "@/components/auth/auth-screen";
import { Button } from "@/components/ui/button";
import { Plus, Loader2 } from "lucide-react";

export function AppShell() {
  const { user, loading: authLoading } = useAuth();
  const [graphRefreshSignal, setGraphRefreshSignal] = useState(0);

  const bumpGraph = useCallback(() => {
    setGraphRefreshSignal((n) => n + 1);
  }, []);

  if (authLoading) {
    return (
      <div className="min-h-screen flex items-center justify-center">
        <Loader2 className="h-5 w-5 animate-spin text-muted-foreground" />
      </div>
    );
  }

  if (!user) {
    return <AuthScreen />;
  }

  return (
    <SidebarProvider defaultOpen>
      <SessionsSidebar />
      <SidebarInset className="h-svh overflow-hidden">
        <ShellHeader />
        <Separator />
        <MainArea
          graphRefreshSignal={graphRefreshSignal}
          onIngestProcessed={bumpGraph}
        />
      </SidebarInset>
    </SidebarProvider>
  );
}

function ShellHeader() {
  const { sessions, currentSessionId } = useSessions();
  const current = sessions.find((s) => s.id === currentSessionId);
  return (
    <header className="flex h-12 items-center gap-3 px-3 shrink-0">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="h-4!" />
      <div className="flex flex-col leading-tight">
        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
          Session
        </span>
        <span className="text-sm font-medium truncate max-w-[280px]">
          {current?.title?.trim() ||
            (current ? "Untitled session" : "No session selected")}
        </span>
      </div>
    </header>
  );
}

function MainArea({
  graphRefreshSignal,
  onIngestProcessed,
}: {
  graphRefreshSignal: number;
  onIngestProcessed: () => void;
}) {
  const { currentSessionId, sessions, createSession } = useSessions();
  const [creating, setCreating] = useState(false);

  if (!currentSessionId) {
    return (
      <div className="flex items-center justify-center p-8 overflow-hidden">
        <div className="max-w-md w-full flex flex-col items-center gap-3 text-center">
          <div className="text-sm text-muted-foreground">
            {sessions.length === 0
              ? "Welcome. Start by creating your first session."
              : "Select a session from the sidebar or create a new one."}
          </div>
          <Button
            onClick={async () => {
              setCreating(true);
              try {
                await createSession();
              } finally {
                setCreating(false);
              }
            }}
            disabled={creating}
          >
            <Plus className="h-3.5 w-3.5" />
            {creating ? "Creating…" : "New session"}
          </Button>
        </div>
      </div>
    );
  }

  return (
    <div className="flex-1 min-h-0 overflow-hidden p-3">
      <div className="flex h-full w-full gap-3">
        <aside className="w-[340px] shrink-0 overflow-hidden">
          <IngestPanel onProcessed={onIngestProcessed} />
        </aside>
        <main className="flex-1 min-w-0 overflow-hidden">
          <GraphPanel refreshSignal={graphRefreshSignal} />
        </main>
        <aside className="w-[400px] shrink-0 overflow-hidden">
          <RetrievePanel />
        </aside>
      </div>
    </div>
  );
}
