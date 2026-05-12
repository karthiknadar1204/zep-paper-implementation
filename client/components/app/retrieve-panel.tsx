"use client";

import { useState } from "react";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Textarea } from "@/components/ui/textarea";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from "@/components/ui/collapsible";
import { Separator } from "@/components/ui/separator";
import { useSessions } from "@/components/providers/session-provider";
import { api, type RetrievalResult } from "@/lib/api";
import { Loader2, Search, ChevronDown, Sparkles } from "lucide-react";
import { toast } from "sonner";
import { cn } from "@/lib/utils";

export function RetrievePanel() {
  const { currentSessionId } = useSessions();
  const [query, setQuery] = useState("");
  const [busy, setBusy] = useState(false);
  const [result, setResult] = useState<RetrievalResult | null>(null);
  const [factsOpen, setFactsOpen] = useState(false);

  async function handleSubmit(e: React.FormEvent) {
    e.preventDefault();
    if (!currentSessionId) return;
    const q = query.trim();
    if (!q) return;
    setBusy(true);
    try {
      const res = await api<RetrievalResult>("/retrieve", {
        method: "POST",
        body: { query: q, sessionId: currentSessionId, limit: 8 },
      });
      setResult(res);
    } catch (err) {
      toast.error(err instanceof Error ? err.message : "Retrieval failed");
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card className="h-full flex flex-col gap-0 overflow-hidden">
      <CardHeader className="border-b">
        <CardTitle className="text-sm font-medium tracking-wide uppercase text-muted-foreground">
          Ask
        </CardTitle>
      </CardHeader>
      <CardContent className="flex-1 flex flex-col gap-3 overflow-hidden p-4">
        <form onSubmit={handleSubmit} className="flex flex-col gap-2">
          <Textarea
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            placeholder="Ask the memory anything. e.g. 'what does the user love?'"
            disabled={busy || !currentSessionId}
            rows={3}
            className="resize-none"
            onKeyDown={(e) => {
              if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                e.preventDefault();
                if (!busy && query.trim() && currentSessionId) {
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
              disabled={busy || !query.trim() || !currentSessionId}
            >
              {busy ? (
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
              ) : (
                <Search className="h-3.5 w-3.5" />
              )}
              {busy ? "Asking…" : "Ask"}
            </Button>
          </div>
        </form>

        <div className="flex-1 min-h-0 flex flex-col">
          <ScrollArea className="flex-1 -mx-2 px-2">
            {!result ? (
              <div className="text-xs text-muted-foreground py-8 text-center border border-dashed rounded-md">
                Answers will appear here. The system answers from its memory of this session.
              </div>
            ) : (
              <div className="flex flex-col gap-4">
                <div className="rounded-md border bg-muted/30 p-3 flex flex-col gap-2">
                  <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
                    <Sparkles className="h-2.5 w-2.5" /> Answer
                  </div>
                  <p className="text-sm leading-relaxed whitespace-pre-wrap">
                    {result.answer}
                  </p>
                </div>

                {result.facts.length > 0 ? (
                  <Collapsible open={factsOpen} onOpenChange={setFactsOpen}>
                    <CollapsibleTrigger asChild>
                      <button className="flex items-center justify-between w-full text-left rounded-md hover:bg-muted/40 px-2 py-1.5 transition-colors">
                        <span className="text-[10px] uppercase tracking-wider text-muted-foreground">
                          Facts used ({result.facts.length})
                        </span>
                        <ChevronDown
                          className={cn(
                            "h-3.5 w-3.5 text-muted-foreground transition-transform",
                            factsOpen && "rotate-180",
                          )}
                        />
                      </button>
                    </CollapsibleTrigger>
                    <CollapsibleContent>
                      <div className="flex flex-col gap-1.5 pt-2">
                        {result.facts.map((f) => (
                          <div
                            key={f.factId}
                            className="rounded-md border bg-background px-2.5 py-2 flex flex-col gap-1"
                          >
                            <div className="flex items-center gap-1.5 justify-between">
                              <span className="text-[10px] font-medium tracking-wider uppercase text-muted-foreground">
                                {f.sourceName} → {f.relationType} → {f.targetName}
                              </span>
                              <Badge variant="outline" className="text-[9px]">
                                {(f.llmScore ?? f.totalScore).toFixed(2)}
                              </Badge>
                            </div>
                            <p className="text-xs leading-snug">{f.factText}</p>
                          </div>
                        ))}
                      </div>
                    </CollapsibleContent>
                  </Collapsible>
                ) : null}

                {result.recentMessages.length > 0 ? (
                  <div className="flex flex-col gap-2">
                    <Separator />
                    <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
                      Conversation tail
                    </div>
                    <div className="flex flex-col gap-1.5">
                      {result.recentMessages.map((m, idx) => (
                        <div
                          key={idx}
                          className="rounded-md bg-muted/20 px-2.5 py-1.5 text-xs leading-snug"
                        >
                          <span className="text-muted-foreground">[{m.actor}] </span>
                          {m.content}
                        </div>
                      ))}
                    </div>
                  </div>
                ) : null}
              </div>
            )}
          </ScrollArea>
        </div>
      </CardContent>
    </Card>
  );
}
