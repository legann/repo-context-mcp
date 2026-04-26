import { colorsFor, EDGE_COLORS, NODE_PALETTE, TIER_ORDER } from './colors.js';
import type { UiDomainMeta, UiEdge, UiGraphData, UiNode } from './types/graph.js';

export function buildNodeIndex(graphData: UiGraphData | null): Map<string, UiNode> {
  const m = new Map<string, UiNode>();
  if (!graphData) return m;
  for (const n of graphData.nodes) m.set(n.id, n);
  return m;
}

export function shortLabel(label: string): string {
  const parts = label.split('/');
  if (parts.length <= 2) return label;
  return `…/${parts.slice(-2).join('/')}`;
}

export function nodeCyWidth(label: string): number {
  return Math.max(90, Math.min(200, label.length * 7 + 24));
}

export function nodeMatchesSearch(n: UiNode, q: string): boolean {
  if (!q) return true;
  const parts: string[] = [n.label, n.id, n.description || '', n.annotation || ''];
  if (n.semanticRich) {
    try {
      parts.push(JSON.stringify(n.semanticRich));
    } catch {
      /* ignore */
    }
  }
  const hay = parts.join('\n').toLowerCase();
  return hay.includes(q);
}

function expandInfraLinkedToLambdas(
  graphData: UiGraphData,
  nodeIndex: Map<string, UiNode>,
  lambdaIds: Set<string>,
): Set<string> {
  const infraIds = new Set<string>();
  for (const lId of lambdaIds) {
    const n = nodeIndex.get(lId);
    const resources = n?.meta?.resources;
    if (Array.isArray(resources)) {
      for (const r of resources) {
        const logicalId = String(r).split(' (')[0];
        for (const sn of graphData.nodes) {
          if (sn.type === 'service' && sn.label === logicalId) {
            infraIds.add(sn.id);
            break;
          }
        }
      }
    }
  }
  for (const e of graphData.edges) {
    if (e.kind === 'consumes' && lambdaIds.has(e.target)) {
      const src = nodeIndex.get(e.source);
      if (src?.type === 'service') infraIds.add(e.source);
    }
  }
  for (const e of graphData.edges) {
    if (e.kind === 'uses_env' && lambdaIds.has(e.source)) {
      const tgt = nodeIndex.get(e.target);
      if (tgt?.type === 'service') infraIds.add(e.target);
    }
  }
  return infraIds;
}

function expandModuleEnvBindings(graphData: UiGraphData, nodeIndex: Map<string, UiNode>, domainModIds: Set<string>): Set<string> {
  const ids = new Set<string>();
  for (const e of graphData.edges) {
    if (e.kind !== 'binds_to') continue;
    if (!domainModIds.has(e.source)) continue;
    const tgt = nodeIndex.get(e.target);
    if (tgt?.type === 'service') ids.add(e.target);
  }
  return ids;
}

export function getDomainScopeIds(graphData: UiGraphData, domainId: string): Set<string> {
  const d = graphData.meta.domains.find(x => x.id === domainId);
  const subs = d?.subdomains ?? [];
  return new Set([domainId, ...subs.map(s => s.id)]);
}

export function collectDomainSliceIds(
  graphData: UiGraphData,
  nodeIndex: Map<string, UiNode>,
  domainId: string,
): {
  domainModIds: Set<string>;
  lambdaIds: Set<string>;
  infraIds: Set<string>;
  externalIds: Set<string>;
  allIds: Set<string>;
} {
  const scope = getDomainScopeIds(graphData, domainId);
  const domainModIds = new Set<string>();
  for (const n of graphData.nodes) {
    if (n.type !== 'module' || !n.domains) continue;
    if (!n.domains.some(d => scope.has(d))) continue;
    domainModIds.add(n.id);
  }
  const lambdaIds = new Set<string>();

  function addInfraAndHandlesLambdas(): void {
    for (const e of graphData.edges) {
      if (e.kind !== 'infra' && e.kind !== 'handles') continue;
      const s = nodeIndex.get(e.source);
      const t = nodeIndex.get(e.target);
      if (domainModIds.has(e.target) && s?.type === 'service') lambdaIds.add(e.source);
      if (domainModIds.has(e.source) && t?.type === 'service') lambdaIds.add(e.target);
    }
  }

  function addLambdasTaggedToScope(): void {
    for (const n of graphData.nodes) {
      if (n.type !== 'service' || n.serviceKind !== 'lambda') continue;
      if (n.domains?.some(d => scope.has(d))) lambdaIds.add(n.id);
    }
  }

  function addHandlersOfScopedLambdas(): void {
    for (const lid of lambdaIds) {
      const svc = nodeIndex.get(lid);
      if (!svc || svc.serviceKind !== 'lambda') continue;
      if (!svc.domains?.some(d => scope.has(d))) continue;
      for (const e of graphData.edges) {
        if (e.kind !== 'infra' || e.source !== lid) continue;
        const mod = nodeIndex.get(e.target);
        if (mod?.type === 'module') domainModIds.add(mod.id);
      }
    }
  }

  for (let pass = 0; pass < 6; pass++) {
    addInfraAndHandlesLambdas();
    addLambdasTaggedToScope();
    addHandlersOfScopedLambdas();
  }

  const infraIds = new Set<string>([
    ...expandInfraLinkedToLambdas(graphData, nodeIndex, lambdaIds),
    ...expandModuleEnvBindings(graphData, nodeIndex, domainModIds),
  ]);
  const externalIds = new Set<string>();
  for (const e of graphData.edges) {
    if (e.kind !== 'imports') continue;
    if (domainModIds.has(e.source) && !domainModIds.has(e.target)) externalIds.add(e.target);
    if (domainModIds.has(e.target) && !domainModIds.has(e.source)) externalIds.add(e.source);
  }
  const allIds = new Set<string>([domainId, ...domainModIds, ...lambdaIds, ...infraIds, ...externalIds]);
  return { domainModIds, lambdaIds, infraIds, externalIds, allIds };
}

export function packageGroupKey(mod: UiNode, nodeIndex: Map<string, UiNode>): string {
  const pkgId = mod.package;
  if (!pkgId) return '—';
  const p = nodeIndex.get(pkgId);
  return p?.label || String(pkgId).replace(/^pkg:/, '') || '—';
}

export function groupModulesByPackage(
  mods: UiNode[],
  nodeIndex: Map<string, UiNode>,
): Map<string, UiNode[]> {
  const m = new Map<string, UiNode[]>();
  for (const mod of mods) {
    const k = packageGroupKey(mod, nodeIndex);
    if (!m.has(k)) m.set(k, []);
    m.get(k)!.push(mod);
  }
  for (const arr of m.values()) arr.sort((a, b) => a.label.localeCompare(b.label));
  return new Map([...m.entries()].sort((a, b) => a[0].localeCompare(b[0])));
}

export function ensureOverviewTierDefaults(
  graphData: UiGraphData,
  overviewTierOn: Map<string, boolean>,
): void {
  for (const d of graphData.meta.domains) {
    const t = d.tier || 'technical';
    if (!overviewTierOn.has(t)) overviewTierOn.set(t, true);
  }
}

export function overviewMatchingDomains(
  graphData: UiGraphData,
  overviewTierOn: Map<string, boolean>,
  searchQuery: string,
): UiDomainMeta[] {
  if (!graphData?.meta?.domains) return [];
  ensureOverviewTierDefaults(graphData, overviewTierOn);
  const query = searchQuery.trim().toLowerCase();
  return graphData.meta.domains.filter(d => {
    const tier = d.tier || 'technical';
    if (overviewTierOn.get(tier) === false) return false;
    if (!query) return true;
    if (d.label.toLowerCase().includes(query)) return true;
    return d.subdomains?.some(s => s.label.toLowerCase().includes(query)) ?? false;
  });
}

export type CyElement = Record<string, unknown>;

export function computeDomainOverview(
  graphData: UiGraphData,
  nodeIndex: Map<string, UiNode>,
  visibleDomains: UiDomainMeta[],
  minImportCount: number,
): CyElement[] {
  const visibleIds = new Set(visibleDomains.map(d => d.id));
  const domainNodes = graphData.nodes.filter(n => n.type === 'domain' && visibleIds.has(n.id));
  const modulesByDomain = new Map<string, Set<string>>();
  for (const n of graphData.nodes) {
    if (n.type !== 'module' || !n.domains) continue;
    for (const d of n.domains) {
      if (!modulesByDomain.has(d)) modulesByDomain.set(d, new Set());
      modulesByDomain.get(d)!.add(n.id);
    }
  }

  const edgeCounts = new Map<string, number>();
  for (const e of graphData.edges) {
    if (e.kind !== 'imports') continue;
    const s = nodeIndex.get(e.source);
    const t = nodeIndex.get(e.target);
    if (!s?.domains?.length || !t?.domains?.length) continue;
    for (const sd of s.domains) {
      for (const td of t.domains) {
        if (sd === td) continue;
        const key = `${sd}\0${td}`;
        edgeCounts.set(key, (edgeCounts.get(key) || 0) + 1);
      }
    }
  }

  const c = NODE_PALETTE.domain;
  const elements: CyElement[] = [];
  for (const n of domainNodes) {
    const mc = modulesByDomain.get(n.id)?.size || 0;
    const tier = n.meta?.tier;
    elements.push({
      data: {
        id: n.id,
        label: n.label,
        shortLabel: n.label,
        type: 'domain',
        bg: c.bg,
        border: c.border,
        textColor: c.text,
        w: nodeCyWidth(n.label),
        description: n.description,
        tier,
        moduleCount: mc,
      },
    });
  }

  for (const [key, count] of edgeCounts) {
    if (count < minImportCount) continue;
    const [src, tgt] = key.split('\0');
    if (!visibleIds.has(src) || !visibleIds.has(tgt)) continue;
    elements.push({
      data: {
        id: `e-${src}-${tgt}`,
        source: src,
        target: tgt,
        kind: 'imports',
        color: EDGE_COLORS.imports,
        w: Math.min(5, Math.max(1, Math.log2(count))),
        count,
      },
    });
  }
  return elements;
}

export function computeDomainSlice(
  graphData: UiGraphData,
  nodeIndex: Map<string, UiNode>,
  domainId: string,
  allowedEdgeKinds: Set<string> | null,
): CyElement[] {
  const { externalIds, allIds } = collectDomainSliceIds(graphData, nodeIndex, domainId);
  const elements: CyElement[] = [];

  for (const id of allIds) {
    const n = nodeIndex.get(id);
    if (!n) continue;
    const ghost = externalIds.has(id);
    const sl = n.type === 'domain' ? n.label : shortLabel(n.label);
    const palette = ghost ? NODE_PALETTE.ghost : colorsFor(n);
    elements.push({
      data: {
        id,
        label: n.label,
        shortLabel: sl,
        type: n.type,
        serviceKind: n.serviceKind || '',
        bg: palette.bg,
        border: palette.border,
        textColor: palette.text,
        w: nodeCyWidth(sl),
        ghost,
        description: n.description,
        annotation: n.annotation,
      },
    });
  }

  for (const e of graphData.edges) {
    if (!allIds.has(e.source) || !allIds.has(e.target)) continue;
    if (e.kind === 'contains') continue;
    if (allowedEdgeKinds && allowedEdgeKinds.size > 0 && !allowedEdgeKinds.has(e.kind)) continue;
    const color = EDGE_COLORS[e.kind] || '#484f58';
    const w = e.kind === 'imports' ? 1 : 1.5;
    elements.push({
      data: {
        id: `e-${e.source}-${e.target}-${e.kind}`,
        source: e.source,
        target: e.target,
        kind: e.kind,
        color,
        w,
      },
    });
  }

  return elements;
}

export function sortedDomainsForOverview(
  graphData: UiGraphData,
  overviewTierOn: Map<string, boolean>,
  searchQuery: string,
): UiDomainMeta[] {
  return overviewMatchingDomains(graphData, overviewTierOn, searchQuery).sort(
    (a, b) =>
      (TIER_ORDER[a.tier ?? ''] ?? 9) - (TIER_ORDER[b.tier ?? ''] ?? 9) || b.moduleCount - a.moduleCount,
  );
}

export function defaultAllowedEdgeKinds(graphData: UiGraphData): Set<string> {
  return new Set(graphData.meta.edgeKinds ?? []);
}

export function collectVisibleEdgesForExport(
  graphData: UiGraphData,
  nodeIndex: Map<string, UiNode>,
  view: 'overview' | 'detail',
  domainId: string | null,
  visibleDomains: UiDomainMeta[],
  minImportCount: number,
  allowedEdgeKinds: Set<string> | null,
): UiEdge[] {
  if (view === 'overview') {
    const visibleIds = new Set(visibleDomains.map(d => d.id));
    const counts = new Map<string, number>();
    const pairs = new Map<string, UiEdge>();
    for (const e of graphData.edges) {
      if (e.kind !== 'imports') continue;
      const s = nodeIndex.get(e.source);
      const t = nodeIndex.get(e.target);
      if (!s?.domains?.length || !t?.domains?.length) continue;
      for (const sd of s.domains) {
        for (const td of t.domains) {
          if (sd === td) continue;
          if (!visibleIds.has(sd) || !visibleIds.has(td)) continue;
          const key = `${sd}\0${td}`;
          counts.set(key, (counts.get(key) || 0) + 1);
          if (!pairs.has(key)) pairs.set(key, { source: sd, target: td, kind: 'imports' });
        }
      }
    }
    const out: UiEdge[] = [];
    for (const [key, count] of counts) {
      if (count < minImportCount) continue;
      const e = pairs.get(key);
      if (e) out.push(e);
    }
    return out;
  }
  if (!domainId) return [];
  const { allIds } = collectDomainSliceIds(graphData, nodeIndex, domainId);
  return graphData.edges.filter(e => {
    if (!allIds.has(e.source) || !allIds.has(e.target)) return false;
    if (e.kind === 'contains') return false;
    if (allowedEdgeKinds && allowedEdgeKinds.size > 0 && !allowedEdgeKinds.has(e.kind)) return false;
    return true;
  });
}

export function collectVisibleNodesForExport(
  graphData: UiGraphData,
  nodeIndex: Map<string, UiNode>,
  view: 'overview' | 'detail',
  domainId: string | null,
  visibleDomains: UiDomainMeta[],
): UiNode[] {
  if (view === 'overview') {
    const visibleIds = new Set(visibleDomains.map(d => d.id));
    return graphData.nodes.filter(n => n.type === 'domain' && visibleIds.has(n.id));
  }
  if (!domainId) return [];
  const { allIds } = collectDomainSliceIds(graphData, nodeIndex, domainId);
  return graphData.nodes.filter(n => allIds.has(n.id));
}
