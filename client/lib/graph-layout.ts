import dagre from "@dagrejs/dagre";
import type { Edge, Node } from "@xyflow/react";

export function layoutGraph(nodes: Node[], edges: Edge[]): Node[] {
  if (nodes.length === 0) return nodes;

  const g = new dagre.graphlib.Graph();
  g.setDefaultEdgeLabel(() => ({}));
  g.setGraph({
    rankdir: "TB",
    nodesep: 60,
    ranksep: 90,
    edgesep: 40,
    marginx: 40,
    marginy: 40,
  });

  for (const n of nodes) {
    const width =
      n.type === "episode" ? 240 : n.type === "self" ? 140 : 160;
    const height = n.type === "episode" ? 80 : 56;
    g.setNode(n.id, { width, height });
  }

  for (const e of edges) {
    g.setEdge(e.source, e.target);
  }

  dagre.layout(g);

  return nodes.map((node) => {
    const positioned = g.node(node.id);
    if (!positioned) return node;
    return {
      ...node,
      position: {
        x: positioned.x - positioned.width / 2,
        y: positioned.y - positioned.height / 2,
      },
    };
  });
}
