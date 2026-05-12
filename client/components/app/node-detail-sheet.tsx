"use client";

import { useEffect, useState } from "react";
import {
  Sheet,
  SheetContent,
  SheetDescription,
  SheetHeader,
  SheetTitle,
} from "@/components/ui/sheet";
import { ScrollArea } from "@/components/ui/scroll-area";
import { Badge } from "@/components/ui/badge";
import { Separator } from "@/components/ui/separator";
import { api, type GraphNodeDetail } from "@/lib/api";
import { Loader2, ArrowDown, ArrowUp } from "lucide-react";
import { format } from "date-fns";

type Props = {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  nodeId: string | null;
  nodeKind: "entity" | "episode" | null;
};

export function NodeDetailSheet({ open, onOpenChange, nodeId, nodeKind }: Props) {
  const [detail, setDetail] = useState<GraphNodeDetail | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!open || !nodeId) {
      setDetail(null);
      setError(null);
      return;
    }
    let cancelled = false;
    setLoading(true);
    setError(null);
    void (async () => {
      try {
        const d = await api<GraphNodeDetail>(`/graph/node/${nodeId}`);
        if (!cancelled) setDetail(d);
      } catch (err) {
        if (!cancelled)
          setError(err instanceof Error ? err.message : "Failed to load");
      } finally {
        if (!cancelled) setLoading(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [open, nodeId]);

  const headerName = detail
    ? detail.kind === "entity"
      ? String(detail.properties.name ?? "Entity")
      : `Episode ${String(detail.properties.episodeId ?? "").slice(0, 8)}`
    : nodeKind === "entity"
      ? "Entity"
      : "Episode";

  return (
    <Sheet open={open} onOpenChange={onOpenChange}>
      <SheetContent className="w-[420px] sm:w-[440px] sm:max-w-[440px] flex flex-col gap-0">
        <SheetHeader className="border-b">
          <div className="flex items-center gap-2">
            <Badge variant="secondary" className="text-[10px] uppercase tracking-wider">
              {detail?.kind ?? nodeKind ?? "node"}
            </Badge>
            {detail?.kind === "entity" && detail.properties.type ? (
              <Badge variant="outline" className="text-[10px]">
                {String(detail.properties.type)}
              </Badge>
            ) : null}
          </div>
          <SheetTitle className="text-base font-semibold truncate">{headerName}</SheetTitle>
          {detail?.kind === "entity" && detail.properties.summary ? (
            <SheetDescription className="text-xs leading-relaxed">
              {String(detail.properties.summary)}
            </SheetDescription>
          ) : detail?.kind === "episode" && detail.properties.content ? (
            <SheetDescription className="text-xs leading-relaxed">
              {String(detail.properties.content)}
            </SheetDescription>
          ) : null}
        </SheetHeader>

        <ScrollArea className="flex-1">
          <div className="p-4 flex flex-col gap-5">
            {loading ? (
              <div className="flex items-center gap-2 text-sm text-muted-foreground">
                <Loader2 className="h-4 w-4 animate-spin" /> Loading node…
              </div>
            ) : error ? (
              <div className="text-sm text-destructive">{error}</div>
            ) : !detail ? null : (
              <>
                <Properties detail={detail} />
                <RelationshipsList
                  title="Outgoing"
                  icon={<ArrowDown className="h-3.5 w-3.5" />}
                  items={detail.outgoing}
                />
                <RelationshipsList
                  title="Incoming"
                  icon={<ArrowUp className="h-3.5 w-3.5" />}
                  items={detail.incoming}
                />
              </>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

function Properties({ detail }: { detail: GraphNodeDetail }) {
  const entries = Object.entries(detail.properties).filter(
    ([k]) => k !== "summary" && k !== "content" && k !== "_id" && k !== "name",
  );
  if (entries.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="text-[10px] uppercase tracking-wider text-muted-foreground">
        Properties
      </div>
      <div className="rounded-md border bg-muted/30 divide-y">
        {entries.map(([k, v]) => (
          <div key={k} className="flex items-baseline gap-3 px-2.5 py-1.5">
            <span className="text-[10px] uppercase tracking-wider text-muted-foreground min-w-[100px] flex-shrink-0">
              {k}
            </span>
            <span className="text-xs font-mono break-all">
              {formatValue(k, v)}
            </span>
          </div>
        ))}
      </div>
    </div>
  );
}

function formatValue(key: string, value: unknown): string {
  if (value === null || value === undefined) return "null";
  if (typeof value === "string") {
    if (
      (key.endsWith("At") || key === "occurredAt" || key === "validFrom" || key === "validUntil") &&
      value.match(/^\d{4}-\d{2}-\d{2}/)
    ) {
      try {
        return format(new Date(value), "yyyy-MM-dd HH:mm:ss");
      } catch {
        return value;
      }
    }
    return value;
  }
  return JSON.stringify(value);
}

function RelationshipsList({
  title,
  icon,
  items,
}: {
  title: string;
  icon: React.ReactNode;
  items: GraphNodeDetail["outgoing"];
}) {
  if (items.length === 0) return null;
  return (
    <div className="flex flex-col gap-2">
      <div className="flex items-center gap-1.5 text-[10px] uppercase tracking-wider text-muted-foreground">
        {icon} {title} ({items.length})
      </div>
      <div className="flex flex-col gap-1.5">
        {items.map((r, idx) => {
          const label = r.relationType ?? r.type;
          const closed = r.properties.validUntil !== null && r.properties.validUntil !== undefined && r.properties.validUntil !== "null";
          return (
            <div
              key={`${r.other.id}-${idx}`}
              className="rounded-md border bg-background px-2.5 py-2 flex items-center justify-between gap-2"
            >
              <div className="min-w-0 flex-1 flex flex-col gap-0.5">
                <div className="text-[10px] uppercase font-medium tracking-wider text-muted-foreground">
                  {label}
                </div>
                <div className="text-xs truncate">
                  {r.other.name ?? r.other.id}
                </div>
              </div>
              {closed ? (
                <Badge variant="outline" className="text-[9px]">
                  closed
                </Badge>
              ) : r.type === "FACT" ? (
                <Badge variant="secondary" className="text-[9px]">
                  open
                </Badge>
              ) : null}
            </div>
          );
        })}
      </div>
    </div>
  );
}
