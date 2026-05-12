"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { useSessions } from "@/components/providers/session-provider";
import { api, ApiError, type Episode, type EpisodeStatus, type IngestResponse } from "@/lib/api";
import { format } from "date-fns";
import { Loader2, Send, CheckCircle2, XCircle, Clock } from "lucide-react";
import { toast } from "sonner";

type IngestPanelProps = {
  onProcessed: () => void;
};

type Tracked = {
  id: string;
  content: string;
  status: EpisodeStatus;
  occurredAt: string;
};

export function IngestPanel({ onProcessed }: IngestPanelProps) {
  const { currentSessionId } = useSessions();
  const [content, setContent] = useState("");
  const [sending, setSending] = useState(false);
  const [tracked, setTracked] = useState<Tracked[]>([]);
  const pollersRef = useRef(new Map<string, ReturnType<typeof setInterval>>());
  const lastProcessedNotifyRef = useRef<Set<string>>(new Set());

  useEffect(() => {
    setTracked([]);
    for (const interval of pollersRef.current.values()) clearInterval(interval);
    pollersRef.current.clear();
    lastProcessedNotifyRef.current.clear();
  }, [currentSessionId]);

  useEffect(() => {
    return () => {
      for (const interval of pollersRef.current.values()) clearInterval(interval);
      pollersRef.current.clear();
    };
  }, []);

  const updateTracked = useCallback(
    (id: string, patch: Partial<Tracked>) => {
      setTracked((prev) =>
        prev.map((t) => (t.id === id ? { ...t, ...patch } : t)),
      );
    },
    [],
  );

  const startPolling = useCallback(
    (episodeId: string) => {
      if (pollersRef.current.has(episodeId)) return;
      const interval = setInterval(async () => {
        try {
          const res = await api<{ episode: Episode }>(`/episodes/${episodeId}`);
          updateTracked(episodeId, { status: res.episode.status });
          if (
            res.episode.status === "processed" ||
            res.episode.status === "failed"
          ) {
            const i = pollersRef.current.get(episodeId);
            if (i) clearInterval(i);
            pollersRef.current.delete(episodeId);
            if (
              res.episode.status === "processed" &&
              !lastProcessedNotifyRef.current.has(episodeId)
            ) {
              lastProcessedNotifyRef.current.add(episodeId);
              onProcessed();
            }
            if (res.episode.status === "failed") {
              toast.error("Episode failed to process. Check server logs.");
            }
          }
        } catch (err) {
          if (err instanceof ApiError && err.status === 404) {
            const i = pollersRef.current.get(episodeId);
            if (i) clearInterval(i);
            pollersRef.current.delete(episodeId);
          }
        }
      }, 1500);
      pollersRef.current.set(episodeId, interval);
    },
    [updateTracked, onProcessed],
  );

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentSessionId) return;
    const trimmed = content.trim();
    if (!trimmed) return;
    setSending(true);
    try {
      const res = await api<IngestResponse>("/ingest", {
        method: "POST",
        body: {
          sessionId: currentSessionId,
          actor: "user",
          content: trimmed,
        },
      });
      const optimistic: Tracked = {
        id: res.episodeId,
        content: trimmed,
        status: res.status,
        occurredAt: new Date().toISOString(),
      };
      setTracked((prev) => [optimistic, ...prev]);
      setContent("");
      startPolling(res.episodeId);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Failed to ingest");
    } finally {
      setSending(false);
    }
  }

  return (
    <Card className="h-full flex flex-col gap-0 overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle className="text-sm font-medium tracking-wide uppercase text-muted-foreground">
          Ingest
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-3 overflow-hidden p-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <Textarea
            value={content}
            onChange={(e) => setContent(e.target.value)}
            placeholder="Tell the system something about you. Try 'I love dogs.' or 'I work at Anthropic.'"
            disabled={sending || !currentSessionId}
            rows={3}
            className="resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!sending && content.trim() && currentSessionId) {
                  void handleSubmit(e as unknown as React.FormEvent);
                }
              }
            }}
          />
          <div className="flex items-center justify-between">
            <span className="text-[10px] text-muted-foreground">
              ⌘/Ctrl + Enter
            </span>
            <Button
              type="submit"
              size="sm"
              disabled={sending || !content.trim() || !currentSessionId}
            >
              {sending ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Send className="h-3.5 w-3.5" />
              )}
              {sending ? "Sending…" : "Send"}
            </Button>
          </div>
        </form>

        <div className="flex-1 min-h-0 flex flex-col gap-2">
          <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
            Recent
          </div>
          <ScrollArea className="flex-1 -mx-2 px-2">
            <div className="flex flex-col gap-2">
              {tracked.length === 0 ? (
                <div className="text-xs text-muted-foreground py-6 text-center border border-dashed rounded-md">
                  Ingested messages appear here.
                </div>
              ) : (
                tracked.map((t) => <IngestRow key={t.id} t={t} />)
              )}
            </div>
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  );
}

function IngestRow({ t }: { t: Tracked }) {
  return (
    <div className="flex flex-col gap-1.5 rounded-md border bg-background p-2.5">
      <p className="text-sm leading-snug">{t.content}</p>
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground">
          {format(new Date(t.occurredAt), "HH:mm:ss")}
        </span>
        <StatusBadge status={t.status} />
      </div>
    </div>
  );
}

function StatusBadge({ status }: { status: EpisodeStatus }) {
  if (status === "queued")
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <Clock className="h-2.5 w-2.5" /> queued
      </Badge>
    );
  if (status === "processing")
    return (
      <Badge variant="secondary" className="gap-1 text-[10px]">
        <Loader2 className="h-2.5 w-2.5 animate-spin" /> processing
      </Badge>
    );
  if (status === "processed")
    return (
      <Badge variant="default" className="gap-1 text-[10px]">
        <CheckCircle2 className="h-2.5 w-2.5" /> processed
      </Badge>
    );
  return (
    <Badge variant="destructive" className="gap-1 text-[10px]">
      <XCircle className="h-2.5 w-2.5" /> failed
    </Badge>
  );
}
