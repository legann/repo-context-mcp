import type { SemanticGraph, NodeType, EdgeKind } from '../types.js';
import { graphStats } from '../graph/index.js';
import type { AppState } from './handlers.js';
import { extractSemanticForUi, type UiSemanticRich } from './ui-semantic-extract.js';

export type { UiSemanticRich };
export { extractSemanticForUi } from './ui-semantic-extract.js';

export interface UiNode {
  id: string;
  label: string;
  type: NodeType;
  description: string;
  package?: string;
  domains?: string[];
  serviceKind?: string;
  /** Short summary (same as semantic.summary). */
  annotation?: string;
  /** Extra structured fields from annotations when present. */
  semanticRich?: UiSemanticRich;
  meta?: Record<string, unknown>;
}

export interface UiEdge {
  source: string;
  target: string;
  kind: EdgeKind;
}

export interface UiDomainMeta {
  id: string;
  label: string;
  tier?: string;
  moduleCount: number;
  /** Child subdomain nodes from the graph (path clusters), when present. */
  subdomains?: Array<{ id: string; label: string; moduleCount: number }>;
}

export interface UiGraphData {
  nodes: UiNode[];
  edges: UiEdge[];
  builtAt: string;
  stats: { nodes: number; edges: number };
  meta: {
    domains: UiDomainMeta[];
    packages: Array<{ id: string; label: string; moduleCount: number }>;
    nodeTypes: string[];
    edgeKinds: string[];
    serviceKinds: string[];
  };
}

function parseServiceKind(id: string): string {
  const m = id.match(/^service:([\w-]+):/);
  if (!m) return 'other';
  const prefix = m[1];
  if (prefix === 'aws-dynamodb') return 'dynamodb';
  if (prefix === 'aws-sqs') return 'sqs';
  if (prefix === 'aws-lambda') return 'lambda';
  if (prefix === 'aws-s3') return 's3';
  if (prefix.startsWith('k8s')) return 'k8s';
  if (prefix === 'aws') return 'aws';
  return prefix;
}

export function extractUiGraph(state: AppState): UiGraphData {
  const { graph, annotations, builtAt } = state;
  const stats = graphStats(graph);

  const modulePackage = new Map<string, string>();
  const moduleDomains = new Map<string, string[]>();

  for (const edge of graph.edges) {
    if (edge.kind === 'contains') {
      const fromNode = graph.nodes.get(edge.from);
      if (fromNode?.type === 'package') modulePackage.set(edge.to, edge.from);
    }
    if (edge.kind === 'tagged') {
      const toNode = graph.nodes.get(edge.to);
      if (toNode?.type === 'domain') {
        const existing = moduleDomains.get(edge.from) ?? [];
        existing.push(edge.to);
        moduleDomains.set(edge.from, existing);
      }
    }
  }

  const allAnnotations = annotations.getAll();

  const nodes: UiNode[] = [];
  const nodeTypes = new Set<string>();
  const serviceKinds = new Set<string>();

  for (const node of graph.nodes.values()) {
    if (node.type === 'root' || node.type === 'capability') continue;
    nodeTypes.add(node.type);

    const vNode: UiNode = {
      id: node.id,
      label: node.label,
      type: node.type,
      description: node.description,
    };

    const pkg = modulePackage.get(node.id);
    if (pkg) vNode.package = pkg;

    const doms = moduleDomains.get(node.id);
    if (doms?.length) vNode.domains = doms;

    const ann = allAnnotations[node.id];
    if (ann?.semantic?.summary) vNode.annotation = ann.semantic.summary;
    const semanticRich = extractSemanticForUi(ann?.semantic);
    if (semanticRich) vNode.semanticRich = semanticRich;

    if (node.type === 'domain' && node.data) {
      vNode.meta = {};
      if (node.data.tier) vNode.meta.tier = node.data.tier;
      if (node.data.subdomains?.length) vNode.meta.subdomainCount = node.data.subdomains.length;
    }

    if (node.type === 'service') {
      const kind = parseServiceKind(node.id);
      vNode.serviceKind = kind;
      serviceKinds.add(kind);
      vNode.meta = { serviceKind: kind };
      if (node.data) {
        if (node.data.handler) vNode.meta.handler = node.data.handler;
        if (node.data.triggers?.length) {
          vNode.meta.triggerCount = node.data.triggers.length;
          vNode.meta.triggers = node.data.triggers.map(t => {
            if (t.type === 'api') return `${t.method} ${t.path}`;
            if (t.type === 'sqs') return `SQS: ${t.queueRef || t.name}`;
            if (t.type === 'schedule') return `Schedule: ${t.schedule || t.name}`;
            return t.name;
          });
        }
        if (node.data.envRefs?.length) {
          vNode.meta.resourceCount = node.data.envRefs.length;
          vNode.meta.resources = node.data.envRefs
            .filter(r => r.targetLogicalId)
            .map(r => `${r.targetLogicalId} (${r.varName})`);
        }
      }
    }

    if (node.type === 'module' && node.data) {
      vNode.meta = {};
      if (node.data.envVars?.length) vNode.meta.envVarCount = node.data.envVars.length;
      const outEdges = graph.outEdges.get(node.id) ?? [];
      const exportCount = outEdges.filter(e => e.kind === 'contains').length;
      if (exportCount) vNode.meta.exports = exportCount;
    }

    if (node.type === 'package' && node.data) {
      vNode.meta = {};
      if (node.data.version) vNode.meta.version = node.data.version;
    }

    nodes.push(vNode);
  }

  const edges: UiEdge[] = [];
  const edgeKinds = new Set<string>();

  for (const edge of graph.edges) {
    const fromNode = graph.nodes.get(edge.from);
    const toNode = graph.nodes.get(edge.to);
    if (!fromNode || !toNode) continue;
    if (fromNode.type === 'root' || fromNode.type === 'capability' || toNode.type === 'capability') continue;

    edgeKinds.add(edge.kind);
    edges.push({ source: edge.from, target: edge.to, kind: edge.kind });
  }

  const domainIds = graph.byType.get('domain') ?? new Set();
  const packageIds = graph.byType.get('package') ?? new Set();

  const domainMeta: UiDomainMeta[] = [...domainIds]
    .map(id => {
      const node = graph.nodes.get(id);
      if (!node || node.type !== 'domain') return null;
      const incoming = graph.inEdges.get(id) ?? [];
      const moduleCount = incoming.filter(e => e.kind === 'tagged').length;

      const subIds = node.data?.subdomains;
      let subdomains: UiDomainMeta['subdomains'];
      if (subIds?.length) {
        subdomains = subIds.map(sid => {
          const sn = graph.nodes.get(sid);
          const subIn = graph.inEdges.get(sid) ?? [];
          const subModCount = subIn.filter(
            e => e.kind === 'tagged' && graph.nodes.get(e.from)?.type === 'module',
          ).length;
          return { id: sid, label: sn?.label ?? sid, moduleCount: subModCount };
        });
      }

      const row: UiDomainMeta = { id, label: node.label, tier: node.data?.tier, moduleCount };
      if (subdomains?.length) row.subdomains = subdomains;
      return row;
    })
    .filter((d): d is UiDomainMeta => d !== null)
    .sort((a, b) => b.moduleCount - a.moduleCount);

  const packageMeta = [...packageIds].map(id => {
    const node = graph.nodes.get(id);
    if (!node) return null;
    const outEdges = graph.outEdges.get(id) ?? [];
    const moduleCount = outEdges.filter(e => e.kind === 'contains').length;
    return { id, label: node.label, moduleCount };
  }).filter((p): p is NonNullable<typeof p> => p !== null)
    .sort((a, b) => b.moduleCount - a.moduleCount);

  return {
    nodes,
    edges,
    builtAt,
    stats: { nodes: stats.totalNodes, edges: stats.totalEdges },
    meta: {
      domains: domainMeta,
      packages: packageMeta,
      nodeTypes: [...nodeTypes].sort(),
      edgeKinds: [...edgeKinds].sort(),
      serviceKinds: [...serviceKinds].sort(),
    },
  };
}
