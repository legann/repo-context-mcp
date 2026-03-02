import type { GraphNode, GraphEdge, NodeType, EdgeKind, SemanticGraph, NodeView, CapabilityNodeData } from '../types.js';

export function createEmptyGraph(): SemanticGraph {
  return {
    nodes: new Map(),
    edges: [],
    outEdges: new Map(),
    inEdges: new Map(),
    byType: new Map(),
  };
}

export function addNode(graph: SemanticGraph, node: GraphNode): void {
  graph.nodes.set(node.id, node);

  let typeSet = graph.byType.get(node.type);
  if (!typeSet) {
    typeSet = new Set();
    graph.byType.set(node.type, typeSet);
  }
  typeSet.add(node.id);
}

export function addEdge(graph: SemanticGraph, from: string, to: string, kind: EdgeKind): void {
  const edge: GraphEdge = { from, to, kind };
  graph.edges.push(edge);

  let out = graph.outEdges.get(from);
  if (!out) { out = []; graph.outEdges.set(from, out); }
  out.push(edge);

  let inc = graph.inEdges.get(to);
  if (!inc) { inc = []; graph.inEdges.set(to, inc); }
  inc.push(edge);
}

// ── Queries ──

export function getChildren(graph: SemanticGraph, nodeId: string): GraphNode[] {
  const edges = graph.outEdges.get(nodeId) ?? [];
  return edges
    .filter(e => e.kind === 'contains')
    .map(e => graph.nodes.get(e.to))
    .filter((n): n is GraphNode => n !== undefined);
}

export function getParent(graph: SemanticGraph, nodeId: string): GraphNode | undefined {
  const edges = graph.inEdges.get(nodeId) ?? [];
  const containsEdge = edges.find(e => e.kind === 'contains');
  return containsEdge ? graph.nodes.get(containsEdge.from) : undefined;
}

export function getLinks(graph: SemanticGraph, nodeId: string): Array<{ targetId: string; relation: EdgeKind; label: string }> {
  const edges = graph.outEdges.get(nodeId) ?? [];
  return edges
    .filter(e => e.kind !== 'contains')
    .map(e => ({
      targetId: e.to,
      relation: e.kind,
      label: graph.nodes.get(e.to)?.label ?? e.to,
    }));
}

function fillCapabilityEntry(
  entry: NodeView['drill_down'][number],
  d: CapabilityNodeData,
): void {
  if (d.signature) entry.signature = d.signature;
  if (d.symbolKind) entry.symbolKind = d.symbolKind;
  if (d.typeValue) entry.typeValue = d.typeValue;
  if (d.fields) entry.fields = d.fields;
  if (d.implementsInterfaces) entry.implementsInterfaces = d.implementsInterfaces;
  if (d.calls) entry.calls = d.calls;
  if (d.lineRange) entry.lineRange = d.lineRange;
}

export function buildNodeView(graph: SemanticGraph, nodeId: string): NodeView | null {
  const node = graph.nodes.get(nodeId);
  if (!node) return null;

  const levelMap: Record<NodeType, number> = {
    root: 0, package: 1, service: 1, domain: 1,
    module: 2, capability: 3,
  };

  const children = getChildren(graph, nodeId);
  const links = getLinks(graph, nodeId);

  const drill_down: NodeView['drill_down'] = children.map(c => {
    const entry: NodeView['drill_down'][number] = { id: c.id, label: c.label, type: c.type };
    if (c.type === 'capability' && c.data) fillCapabilityEntry(entry, c.data);
    return entry;
  });

  const view: NodeView = {
    id: node.id,
    level: levelMap[node.type] ?? 2,
    label: node.label,
    description: node.description,
    drill_down,
    links: links.length > 0 ? links : undefined,
  };

  if (node.type === 'capability' && node.data) {
    view.signature = node.data.signature;
    view.params = node.data.params;
    view.returnType = node.data.returnType;
    view.typeValue = node.data.typeValue;
    view.lineRange = node.data.lineRange;
    view.symbolKind = node.data.symbolKind;
    view.fields = node.data.fields;
    view.implementsInterfaces = node.data.implementsInterfaces;
    view.calls = node.data.calls;
  }
  if (node.type === 'module' && node.data) {
    if (node.data.envVars) view.envVars = node.data.envVars;
    if (node.data.hasRoutes) view.hasRoutes = true;
  }

  return view;
}

export function pathFromRoot(graph: SemanticGraph, focusId: string): { path: NodeView[]; focus: NodeView } | null {
  const focus = buildNodeView(graph, focusId);
  if (!focus) return null;

  const chain: NodeView[] = [];
  let current = focusId;

  while (true) {
    const parent = getParent(graph, current);
    if (!parent) break;
    const parentView = buildNodeView(graph, parent.id);
    if (parentView) chain.unshift(parentView);
    current = parent.id;
  }

  return { path: chain, focus };
}

export function getImpact(
  graph: SemanticGraph,
  nodeId: string,
  direction: 'downstream' | 'upstream' | 'both' = 'both',
  maxDepth?: number,
): { downstream: string[]; upstream: string[] } {
  const downstream = new Set<string>();
  const upstream = new Set<string>();

  if (direction === 'downstream' || direction === 'both') {
    bfs(graph, nodeId, 'in', downstream, maxDepth);
  }
  if (direction === 'upstream' || direction === 'both') {
    bfs(graph, nodeId, 'out', upstream, maxDepth);
  }

  downstream.delete(nodeId);
  upstream.delete(nodeId);

  return {
    downstream: [...downstream],
    upstream: [...upstream],
  };
}

function bfs(
  graph: SemanticGraph,
  start: string,
  follow: 'in' | 'out',
  visited: Set<string>,
  maxDepth?: number,
): void {
  const queue: Array<{ id: string; depth: number }> = [{ id: start, depth: 0 }];
  visited.add(start);

  while (queue.length > 0) {
    const item = queue.shift();
    if (item === undefined) break;
    const { id: current, depth } = item;
    if (maxDepth !== undefined && depth >= maxDepth) continue;
    const edges = follow === 'out'
      ? (graph.outEdges.get(current) ?? [])
      : (graph.inEdges.get(current) ?? []);

    for (const edge of edges) {
      if (edge.kind === 'contains') continue;
      const next = follow === 'out' ? edge.to : edge.from;
      if (!visited.has(next)) {
        visited.add(next);
        queue.push({ id: next, depth: depth + 1 });
      }
    }
  }
}

// ── Stats ──

export function graphStats(graph: SemanticGraph) {
  const nodesByType: Record<string, number> = {};
  for (const [type, ids] of graph.byType) {
    nodesByType[type] = ids.size;
  }
  const edgesByKind: Record<string, number> = {};
  for (const edge of graph.edges) {
    edgesByKind[edge.kind] = (edgesByKind[edge.kind] ?? 0) + 1;
  }
  return {
    totalNodes: graph.nodes.size,
    totalEdges: graph.edges.length,
    nodesByType,
    edgesByKind,
  };
}
