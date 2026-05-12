"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import {
  Background,
  BackgroundVariant,
  ConnectionLineType,
  Controls,
  Handle,
  MarkerType,
  Position,
  ReactFlow,
  ReactFlowProvider,
  useEdgesState,
  useNodesState,
  type Edge,
  type Node,
  type NodeProps,
} from "@xyflow/react";
import "@xyflow/react/dist/style.css";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import { Switch } from "@/components/ui/switch";
import { Label } from "@/components/ui/label";
import { useSessions } from "@/components/providers/session-provider";
import { api, ApiError, type GraphSnapshot } from "@/lib/api";
import { layoutGraph } from "@/lib/graph-layout";
import { Loader2, RefreshCw, Sparkles } from "lucide-react";
import { cn } from "@/lib/utils";
import { NodeDetailSheet } from "./node-detail-sheet";

const ENTITY_COLORS: Record<string, string> = {
  PERSON: "border-blue-300 bg-blue-50 text-blue-900 dark:border-blue-800 dark:bg-blue-950/40 dark:text-blue-100",
  COMPANY: "border-violet-300 bg-violet-50 text-violet-900 dark:border-violet-800 dark:bg-violet-950/40 dark:text-violet-100",
  LOCATION: "border-emerald-300 bg-emerald-50 text-emerald-900 dark:border-emerald-800 dark:bg-emerald-950/40 dark:text-emerald-100",
  CONCEPT: "border-amber-300 bg-amber-50 text-amber-900 dark:border-amber-800 dark:bg-amber-950/40 dark:text-amber-100",
  PRODUCT: "border-pink-300 bg-pink-50 text-pink-900 dark:border-pink-800 dark:bg-pink-950/40 dark:text-pink-100",
  DATE: "border-cyan-300 bg-cyan-50 text-cyan-900 dark:border-cyan-800 dark:bg-cyan-950/40 dark:text-cyan-100",
  OTHER: "border-zinc-300 bg-zinc-50 text-zinc-900 dark:border-zinc-700 dark:bg-zinc-900 dark:text-zinc-100",
};

type EntityNodeData = {
  label: string;
  entityType: string;
  isSelf: boolean;
};

type EpisodeNodeData = {
  content: string;
  occurredAt: string;
};

function EntityNode({ data, selected }: NodeProps) {
  const d = data as unknown as EntityNodeData;
  const palette = ENTITY_COLORS[d.entityType] ?? ENTITY_COLORS.OTHER;
  return (
    <div
      className={cn(
        "relative rounded-md border px-3 py-2 shadow-sm min-w-[140px] transition-all",
        palette,
        selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
        d.isSelf && "border-dashed",
      )}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex flex-col gap-0.5">
        <div className="text-[9px] font-medium uppercase tracking-wider opacity-60">
          {d.isSelf ? "Self · PERSON" : d.entityType}
        </div>
        <div className="text-xs font-semibold leading-tight truncate">
          {d.label}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

function EpisodeNode({ data, selected }: NodeProps) {
  const d = data as unknown as EpisodeNodeData;
  return (
    <div
      className={cn(
        "relative rounded-md border bg-muted/40 px-3 py-2 shadow-sm w-[220px] transition-all",
        selected && "ring-2 ring-foreground ring-offset-2 ring-offset-background",
      )}
    >
      <Handle type="target" position={Position.Top} className="!opacity-0" />
      <div className="flex flex-col gap-1">
        <div className="text-[9px] font-medium uppercase tracking-wider text-muted-foreground">
          Episode · {new Date(d.occurredAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" })}
        </div>
        <div className="text-xs leading-snug text-foreground/90 line-clamp-2">
          {d.content}
        </div>
      </div>
      <Handle type="source" position={Position.Bottom} className="!opacity-0" />
    </div>
  );
}

const nodeTypes = { entity: EntityNode, episode: EpisodeNode } as const;

export type GraphPanelHandle = {
  refresh: () => Promise<void>;
};

export function GraphPanel({
  refreshSignal,
}: {
  refreshSignal: number;
}) {
  return (
    <ReactFlowProvider>
      <GraphPanelInner refreshSignal={refreshSignal} />
    </ReactFlowProvider>
  );
}

function GraphPanelInner({ refreshSignal }: { refreshSignal: number }) {
  const { currentSessionId, sessions } = useSessions();
  const [snapshot, setSnapshot] = useState<GraphSnapshot | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [showClosed, setShowClosed] = useState(true);
  const [showEpisodes, setShowEpisodes] = useState(true);
  const [selectedNodeId, setSelectedNodeId] = useState<string | null>(null);
  const [selectedNodeKind, setSelectedNodeKind] = useState<"entity" | "episode" | null>(null);

  const [nodes, setNodes, onNodesChange] = useNodesState<Node>([]);
  const [edges, setEdges, onEdgesChange] = useEdgesState<Edge>([]);

  const userId = useMemo(() => {
    if (sessions.length === 0) return null;
    return sessions[0].userId;
  }, [sessions]);

  const refresh = useCallback(async () => {
    if (!currentSessionId) {
      setSnapshot(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const data = await api<GraphSnapshot>(
        `/graph?sessionId=${encodeURIComponent(currentSessionId)}`,
      );
      setSnapshot(data);
    } catch (err) {
      if (err instanceof ApiError) setError(err.message);
      else setError("Failed to load graph");
    } finally {
      setLoading(false);
    }
  }, [currentSessionId]);

  useEffect(() => {
    void refresh();
  }, [currentSessionId, refreshSignal, refresh]);

  useEffect(() => {
    if (!snapshot) {
      setNodes([]);
      setEdges([]);
      return;
    }

    const visibleFacts = showClosed
      ? snapshot.facts
      : snapshot.facts.filter((f) => f.validUntil === null);

    const entityIds = new Set<string>();
    for (const f of visibleFacts) {
      entityIds.add(f.sourceId);
      entityIds.add(f.targetId);
    }
    if (showEpisodes) {
      for (const m of snapshot.mentions) entityIds.add(m.entityId);
    }
    if (entityIds.size === 0) {
      for (const e of snapshot.entities) entityIds.add(e.entityId);
    }

    const visibleEntities = snapshot.entities.filter((e) =>
      entityIds.has(e.entityId),
    );

    const entityNodes: Node[] = visibleEntities.map((e) => ({
      id: e.entityId,
      type: "entity",
      data: {
        label: e.name,
        entityType: e.type,
        isSelf: userId !== null && e.entityId === userId,
      },
      position: { x: 0, y: 0 },
    }));

    const episodeNodes: Node[] = showEpisodes
      ? snapshot.episodes.map((ep) => ({
          id: ep.episodeId,
          type: "episode",
          data: {
            content: ep.content,
            occurredAt: ep.occurredAt,
          },
          position: { x: 0, y: 0 },
        }))
      : [];

    const factEdges: Edge[] = visibleFacts.map((f) => {
      const closed = f.validUntil !== null;
      return {
        id: f.factId,
        source: f.sourceId,
        target: f.targetId,
        label: f.relationType,
        type: "default",
        animated: false,
        style: {
          stroke: closed ? "var(--muted-foreground)" : "var(--foreground)",
          strokeWidth: closed ? 1 : 1.5,
          strokeDasharray: closed ? "4 4" : undefined,
          opacity: closed ? 0.55 : 1,
        },
        labelStyle: {
          fontSize: 10,
          fontWeight: 500,
          fill: closed ? "var(--muted-foreground)" : "var(--foreground)",
        },
        labelBgStyle: {
          fill: "var(--background)",
        },
        labelBgPadding: [4, 2],
        labelBgBorderRadius: 4,
        markerEnd: {
          type: MarkerType.ArrowClosed,
          color: closed ? "var(--muted-foreground)" : "var(--foreground)",
          width: 14,
          height: 14,
        },
      };
    });

    const mentionEdges: Edge[] = showEpisodes
      ? snapshot.mentions.map((m) => ({
          id: `mention-${m.episodeId}-${m.entityId}`,
          source: m.episodeId,
          target: m.entityId,
          type: "default",
          style: {
            stroke: "var(--muted-foreground)",
            strokeWidth: 0.75,
            strokeDasharray: "2 3",
            opacity: 0.5,
          },
          markerEnd: {
            type: MarkerType.Arrow,
            color: "var(--muted-foreground)",
            width: 10,
            height: 10,
          },
        }))
      : [];

    const allNodes = [...entityNodes, ...episodeNodes];
    const allEdges = [...factEdges, ...mentionEdges];
    const laid = layoutGraph(allNodes, allEdges);

    setNodes(laid);
    setEdges(allEdges);
  }, [snapshot, showClosed, showEpisodes, userId, setNodes, setEdges]);

  const openCount =
    snapshot?.facts.filter((f) => f.validUntil === null).length ?? 0;
  const closedCount =
    snapshot?.facts.filter((f) => f.validUntil !== null).length ?? 0;

  return (
    <>
      <Card className="h-full flex flex-col gap-0 overflow-hidden">
        <CardHeader className="border-b">
          <div className="flex items-center justify-between gap-3 flex-wrap">
            <div className="flex items-center gap-2">
              <CardTitle className="text-sm font-medium tracking-wide uppercase text-muted-foreground">
                Graph
              </CardTitle>
              {snapshot ? (
                <div className="flex items-center gap-1.5">
                  <Badge variant="outline" className="text-[10px] font-normal">
                    {snapshot.entities.length} entities
                  </Badge>
                  <Badge variant="outline" className="text-[10px] font-normal">
                    {openCount} open · {closedCount} closed
                  </Badge>
                </div>
              ) : null}
            </div>
            <div className="flex items-center gap-4">
              <div className="flex items-center gap-2">
                <Switch
                  id="show-closed"
                  checked={showClosed}
                  onCheckedChange={setShowClosed}
                />
                <Label
                  htmlFor="show-closed"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  Closed facts
                </Label>
              </div>
              <div className="flex items-center gap-2">
                <Switch
                  id="show-episodes"
                  checked={showEpisodes}
                  onCheckedChange={setShowEpisodes}
                />
                <Label
                  htmlFor="show-episodes"
                  className="text-xs text-muted-foreground cursor-pointer"
                >
                  Episodes
                </Label>
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="size-7"
                onClick={() => void refresh()}
                disabled={loading || !currentSessionId}
                title="Refresh"
              >
                <RefreshCw
                  className={cn("h-3.5 w-3.5", loading && "animate-spin")}
                />
              </Button>
            </div>
          </div>
        </CardHeader>
        <CardContent className="flex-1 min-h-0 p-0 relative">
          {!currentSessionId ? (
            <EmptyState message="Select or create a session to view the graph." />
          ) : error ? (
            <EmptyState message={error} icon="error" />
          ) : loading && !snapshot ? (
            <div className="absolute inset-0 flex items-center justify-center text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 animate-spin mr-2" />
              Loading graph…
            </div>
          ) : snapshot && snapshot.entities.length === 0 ? (
            <EmptyState message="The graph is empty. Send a message to start building memory." icon="sparkle" />
          ) : (
            <div className="absolute inset-0">
              <ReactFlow
                nodes={nodes}
                edges={edges}
                onNodesChange={onNodesChange}
                onEdgesChange={onEdgesChange}
                nodeTypes={nodeTypes}
                fitView
                fitViewOptions={{ padding: 0.2 }}
                proOptions={{ hideAttribution: true }}
                connectionLineType={ConnectionLineType.Bezier}
                onNodeClick={(_, node) => {
                  setSelectedNodeId(node.id);
                  setSelectedNodeKind(node.type === "episode" ? "episode" : "entity");
                }}
                minZoom={0.3}
                maxZoom={1.5}
              >
                <Background variant={BackgroundVariant.Dots} gap={20} size={1} />
                <Controls
                  position="bottom-right"
                  showInteractive={false}
                  className="!shadow-none !border !rounded-md !bg-background"
                />
              </ReactFlow>
            </div>
          )}
        </CardContent>
      </Card>

      <NodeDetailSheet
        open={selectedNodeId !== null}
        onOpenChange={(open) => {
          if (!open) {
            setSelectedNodeId(null);
            setSelectedNodeKind(null);
          }
        }}
        nodeId={selectedNodeId}
        nodeKind={selectedNodeKind}
      />
    </>
  );
}

function EmptyState({
  message,
  icon = "default",
}: {
  message: string;
  icon?: "default" | "error" | "sparkle";
}) {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 text-center px-6">
      {icon === "sparkle" ? (
        <Sparkles className="h-6 w-6 text-muted-foreground" strokeWidth={1.5} />
      ) : null}
      <p className="text-sm text-muted-foreground max-w-xs">{message}</p>
    </div>
  );
}
