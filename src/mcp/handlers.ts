/**
 * MCP tool handlers. Each handler receives context (graph, snapshot, annotations, rebuild callback)
 * and args, returns the tool result or { error: string }.
 */

import * as fsPromises from 'node:fs/promises';
import type {
  SemanticGraph, SyntacticSnapshot, NodeView, NodeViewDetail, NodeViewChild,
  SemanticAnnotation, ModuleInfo, StoredAnnotation,
} from '../types.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../types.js';
import { type AnnotationStore, SemanticAnnotationSchema } from '../annotations/store.js';
import { buildNodeView, pathFromRoot, getImpact } from '../graph/index.js';
import { graphStats } from '../graph/index.js';
import type { DomainsConfig } from '../stage2/domains.js';
import { resolveDomainToCanonical } from '../stage2/domains.js';

/** Token -> set of node ids; used for O(1) search instead of scanning all nodes. */
export type SearchIndex = Map<string, Set<string>>;

export interface AppState {
  graph: SemanticGraph;
  snapshot: SyntacticSnapshot;
  /** O(1) lookup by module id; built at same time as graph. */
  modulesById: Map<string, ModuleInfo>;
  /** Inverted index: token (lowercase) -> Set<nodeId> for search_repo_context. */
  searchIndex: SearchIndex;
  annotations: AnnotationStore;
  /** Domains config (aliases, patterns); loaded once at state build, not on every request. */
  domainsConfig: DomainsConfig | null;
  builtAt: string;
}

export interface ToolContext {
  getState: () => AppState;
  /** Call to rebuild graph/snapshot/annotations; then getState() returns new state. */
  refreshContext: () => void;
}

export function resolveNodeId(graph: SemanticGraph, rawId: string): string | undefined {
  if (graph.nodes.has(rawId)) return rawId;
  const normalized = rawId
    .replace(/\.(tsx?|jsx?)$/, '')
    .replace(/\/index$/, '');
  return graph.nodes.has(normalized) ? normalized : undefined;
}

export type ToolHandler = (ctx: ToolContext, args: Record<string, unknown>) => unknown | Promise<unknown>;

// ── Shared helper: read file body for a node (capability or module) ──

interface NodeBodyResult {
  lines: string[];
  lineStart: number;
  filePath: string;
}

async function readNodeBody(
  graph: SemanticGraph,
  modulesById: Map<string, ModuleInfo>,
  nodeId: string,
  nodeType: string,
  lineRange?: { start: number; end: number },
): Promise<NodeBodyResult | { error: string }> {
  if (nodeType === 'capability' && lineRange) {
    const parentEdge = (graph.inEdges.get(nodeId) ?? []).find(e => e.kind === 'contains');
    const parentMod = parentEdge ? modulesById.get(parentEdge.from) : undefined;
    if (!parentMod) return { error: `Parent module not found for capability: ${nodeId}` };
    try {
      const raw = await fsPromises.readFile(parentMod.filePath, 'utf-8');
      const allLines = raw.split('\n');
      const lineStart = Math.max(0, lineRange.start - 1);
      const lineEnd = Math.min(allLines.length, lineRange.end);
      return { lines: allLines.slice(lineStart, lineEnd), lineStart, filePath: parentMod.filePath };
    } catch (e) {
      return { error: `Could not read file: ${parentMod.filePath} — ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
    }
  }

  if (nodeType === 'module') {
    const mod = modulesById.get(nodeId);
    const filePath = mod?.filePath ?? (graph.nodes.get(nodeId)?.data as { filePath?: string } | undefined)?.filePath;
    if (!filePath) return { error: `Module file info not found: ${nodeId}` };
    try {
      const raw = await fsPromises.readFile(filePath, 'utf-8');
      return { lines: raw.split('\n'), lineStart: 0, filePath };
    } catch (e) {
      return { error: `Could not read file: ${filePath} — ${(e as NodeJS.ErrnoException).code ?? (e as Error).message}` };
    }
  }

  return { error: `Unsupported node type for body: ${nodeType}` };
}

async function handleGetContextDetail(ctx: ToolContext, args: Record<string, unknown>): Promise<unknown> {
  const { graph, modulesById, annotations } = ctx.getState();
  const rawId = args.nodeId as string;
  const includeBody = args.includeBody === true;
  const bodyOffset = (args.bodyOffset as number) ?? 0;
  const bodyLimit = (args.bodyLimit as number) ?? 30000;
  const grepBody = args.grepBody as string | undefined;
  const includePrivate = args.includePrivate === true;
  const includeInternals = args.includeInternals === true;

  const nodeId = resolveNodeId(graph, rawId);
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const viewRaw = buildNodeView(graph, nodeId);
  if (!viewRaw) return { error: `Node not found: ${rawId}` };
  const view: NodeViewDetail = { ...viewRaw };
  const node = graph.nodes.get(nodeId);
  if (!node) return { error: `Node not found: ${rawId}` };

  if (includePrivate && node.type === 'capability') {
    const members = node.data?.privateMembers;
    if (members?.length) {
      for (const m of members) {
        view.drill_down.push({
          id: `${nodeId}/${m.name}`,
          label: m.name,
          type: 'capability',
          symbolKind: m.kind === 'method' ? 'function' : 'const',
          signature: m.signature,
          lineRange: m.lineRange,
          access: m.access,
        } as NodeViewChild);
      }
    }
  }

  if (includeInternals && node.type === 'capability') {
    const internals = node.data?.internals;
    if (internals?.length) {
      for (const i of internals) {
        view.drill_down.push({
          id: `${nodeId}/#${i.name.replace(/,\s*/g, '_')}`,
          label: i.name,
          type: 'capability',
          symbolKind: i.kind === 'function' ? 'function' : 'const',
          signature: i.signature,
          lineRange: i.lineRange,
          internal: true,
          internalKind: i.kind,
        } as NodeViewChild);
      }
    }
  }

  if (grepBody) {
    const MAX_GREP_PATTERN_LENGTH = 200;
    if (grepBody.length > MAX_GREP_PATTERN_LENGTH) {
      view.grepError = `Regex pattern too long (${grepBody.length} chars, max ${MAX_GREP_PATTERN_LENGTH})`;
    } else {
      const bodyResult = await readNodeBody(graph, modulesById, nodeId, node.type, view.lineRange);
      if ('error' in bodyResult) {
        view.grepError = bodyResult.error;
        console.error(`[get_context_detail] grepBody: ${view.grepError}`);
      } else {
        const CONTEXT_LINES = 3;
        try {
          const re = new RegExp(grepBody, 'i');
          const matchIndices: number[] = [];
          const execStart = Date.now();
          for (let i = 0; i < bodyResult.lines.length; i++) {
            if (re.test(bodyResult.lines[i])) matchIndices.push(i);
            if (i % 1000 === 0 && Date.now() - execStart > 5000) {
              view.grepError = `Regex execution timed out after 5s at line ${i}/${bodyResult.lines.length}`;
              break;
            }
          }
          if (!view.grepError) {
            const matches: Array<{ line: number; text: string; isMatch: boolean }> = [];
            const included = new Set<number>();
            for (const idx of matchIndices) {
              const from = Math.max(0, idx - CONTEXT_LINES);
              const to = Math.min(bodyResult.lines.length - 1, idx + CONTEXT_LINES);
              for (let j = from; j <= to; j++) {
                if (!included.has(j)) {
                  included.add(j);
                  matches.push({ line: bodyResult.lineStart + j + 1, text: bodyResult.lines[j], isMatch: j === idx });
                }
              }
            }
            matches.sort((a, b) => a.line - b.line);
            view.grepMatches = matches;
            view.grepTotalMatches = matchIndices.length;
          }
        } catch {
          view.grepError = `Invalid regex: ${grepBody}`;
        }
      }
    }
  }

  if (includeBody) {
    const bodyResult = await readNodeBody(graph, modulesById, nodeId, node.type, view.lineRange);
    if ('error' in bodyResult) {
      view.bodyError = bodyResult.error;
      console.error(`[get_context_detail] includeBody: ${view.bodyError}`);
    } else {
      const full = bodyResult.lines.join('\n');
      const slice = full.slice(bodyOffset, bodyOffset + bodyLimit);
      view.body = slice;
      view.bodyTotalChars = full.length;
      if (bodyOffset + bodyLimit < full.length) {
        view.bodyHasMore = true;
        view.bodyNextOffset = bodyOffset + bodyLimit;
      }
    }
  }

  const ann = annotations.get(nodeId);
  if (ann) {
    const { snapshot } = ctx.getState();
    let fresh: boolean;
    const mod = modulesById.get(nodeId);
    if (mod) {
      fresh = ann.contentHash === mod.contentHash;
    } else if (nodeId.startsWith('infra:')) {
      const infraMod = snapshot.infraModules?.find(m => m.id === nodeId);
      fresh = !!infraMod && ann.contentHash === infraMod.contentHash;
    } else if (node.type === 'service') {
      const inEdges = graph.inEdges.get(nodeId) ?? [];
      const parentInfraId = inEdges.find(e => e.kind === 'contains')?.from;
      const infraMod = parentInfraId ? snapshot.infraModules?.find(m => m.id === parentInfraId) : undefined;
      fresh = !!infraMod && ann.contentHash === infraMod.contentHash;
    } else {
      fresh = true;
    }
    view.semantic = ann.semantic;
    view.semanticMeta = { pass: ann.pass, updatedAt: ann.updatedAt, fresh };
  }
  return view;
}

function handleGetLocationInRepo(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph } = ctx.getState();
  const rawId = args.focusId as string;
  const focusId = resolveNodeId(graph, rawId);
  if (!focusId) return { error: `Node not found: ${rawId}` };
  const result = pathFromRoot(graph, focusId);
  if (!result) return { error: `Node not found: ${rawId}` };
  return result;
}

/** Prefixes that indicate a node id rather than a domain name. */
const NODE_ID_PREFIXES = /^(mod|cap|pkg|service|infra):/;

function handleGetContext(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, annotations, domainsConfig } = ctx.getState();
  const q = args.domainOrNodeId as string | undefined;
  if (!q) return { error: 'Missing required argument: domainOrNodeId' };
  // If input looks like a node id, try node lookup first to avoid domain resolve + has check.
  if (NODE_ID_PREFIXES.test(q)) {
    const resolvedId = resolveNodeId(graph, q);
    if (resolvedId) {
      const result = pathFromRoot(graph, resolvedId);
      if (result) return result;
    }
    return { error: `Not found: ${q}` };
  }
  const domainLabel = resolveDomainToCanonical(q, domainsConfig);
  const domainId = domainLabel.startsWith('domain:') ? domainLabel : `domain:${domainLabel}`;
  if (graph.nodes.has(domainId)) {
    const domainNode = graph.nodes.get(domainId);
    if (!domainNode) return { error: `Not found: ${q}` };
    const incoming = graph.inEdges.get(domainId) ?? [];
    const taggedModuleIds = incoming.filter(e => e.kind === 'tagged').map(e => e.from);
    const modules = taggedModuleIds
      .map(id => buildNodeView(graph, id))
      .filter((n): n is NodeView => n !== null);
    const result: Record<string, unknown> = {
      domain: domainId,
      label: domainNode.label,
      moduleCount: modules.length,
      modules: modules.map(m => ({ id: m.id, label: m.label, exports: m.drill_down.length, links: m.links?.length ?? 0 })),
    };
    const domainAnn = annotations.get(domainId);
    if (domainAnn) {
      result.semantic = domainAnn.semantic;
      result.semanticMeta = { pass: domainAnn.pass, updatedAt: domainAnn.updatedAt, fresh: true };
    }
    return result;
  }
  const resolvedId = resolveNodeId(graph, q);
  if (resolvedId) {
    const result = pathFromRoot(graph, resolvedId);
    if (result) return result;
  }
  return { error: `Not found: ${q}` };
}

const SEARCH_TOKENIZE = (s: string): string[] =>
  s.toLowerCase().replace(/[/\-_.:]/g, ' ').split(/\s+/).filter(Boolean);

function handleFindInRepo(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, searchIndex } = ctx.getState();
  const rawQuery = (args.query as string).trim();
  const normalized = rawQuery.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
  const tokens = SEARCH_TOKENIZE(normalized);
  const max = (args.maxResults as number) ?? 10;
  const matches: Array<{ id: string; label: string; type: string; score: number }> = [];

  let candidateIds: Set<string>;
  if (tokens.length === 0) {
    candidateIds = new Set();
  } else if (tokens.length === 1) {
    candidateIds = new Set(searchIndex.get(tokens[0]) ?? []);
  } else {
    const first = searchIndex.get(tokens[0]) ?? new Set();
    candidateIds = new Set(first);
    for (let i = 1; i < tokens.length; i++) {
      const next = searchIndex.get(tokens[i]) ?? new Set();
      candidateIds = new Set([...candidateIds].filter(id => next.has(id)));
    }
  }

  for (const nodeId of candidateIds) {
    const node = graph.nodes.get(nodeId);
    if (!node) continue;
    const idL = node.id.toLowerCase();
    const labelL = node.label.toLowerCase();
    const searchableData = node.type === 'capability' && node.data
      ? [node.data.signature ?? '', node.data.typeValue ?? '', ...(node.data.implementsInterfaces ?? [])].join(' ').toLowerCase()
      : '';
    let score = 0;
    for (const t of tokens) {
      if (labelL.includes(t)) score += 3;
      if (idL.includes(t)) score += 2;
      if (searchableData && searchableData.includes(t)) score += 2;
      if (node.type === t) score += 1;
    }
    if (score > 0) matches.push({ id: node.id, label: node.label, type: node.type, score });
  }
  matches.sort((a, b) => b.score - a.score);
  return {
    query: normalized || rawQuery,
    results: matches.slice(0, max).map(m => {
      const nodeView = buildNodeView(graph, m.id);
      return { ...m, children: nodeView?.drill_down.length ?? 0, links: nodeView?.links?.length ?? 0 };
    }),
  };
}

function handleGetImpact(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, modulesById } = ctx.getState();
  const rawId = args.nodeId as string;
  const exportName = args.exportName as string | undefined;
  const maxDepth = args.maxDepth as number | undefined;
  const nodeId = resolveNodeId(graph, rawId);
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const impact = getImpact(graph, nodeId, 'both', maxDepth);
  const nodeLabel = (id: string) => graph.nodes.get(id)?.label ?? id;
  const findUsedNames = (dependentId: string, targetId: string): string[] | undefined => {
    const mod = modulesById.get(dependentId);
    if (!mod) return undefined;
    const imp = mod.imports.find(i => i.resolvedModuleId === targetId);
    return imp?.importedNames.length ? imp.importedNames : undefined;
  };
  let downstreamEntries = impact.downstream.map(id => {
    const entry: Record<string, unknown> = { id, label: nodeLabel(id), type: graph.nodes.get(id)?.type };
    const uses = findUsedNames(id, nodeId);
    if (uses) entry.uses = uses;
    return entry;
  });
  if (exportName) {
    downstreamEntries = downstreamEntries.filter(e => (e.uses as string[] | undefined)?.includes(exportName));
  }
  return {
    nodeId,
    label: nodeLabel(nodeId),
    ...(exportName ? { filteredByExport: exportName } : {}),
    downstream: downstreamEntries,
    upstream: impact.upstream.map(id => {
      const entry: Record<string, unknown> = { id, label: nodeLabel(id), type: graph.nodes.get(id)?.type };
      const uses = findUsedNames(nodeId, id);
      if (uses) entry.uses = uses;
      return entry;
    }),
  };
}

function handleGetFeatureContext(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, annotations, domainsConfig } = ctx.getState();
  const tag = args.domainTag as string;
  const includeConsumers = args.includeConsumers === true;
  const domainLabel = resolveDomainToCanonical(tag, domainsConfig);
  const domainId = domainLabel.startsWith('domain:') ? domainLabel : `domain:${domainLabel}`;
  if (!graph.nodes.has(domainId)) return { error: `Domain not found: ${tag}` };

  const incoming = graph.inEdges.get(domainId) ?? [];
  const taggedModuleIds = new Set(incoming.filter(e => e.kind === 'tagged').map(e => e.from));
  const allIds = new Set(taggedModuleIds);
  for (const modId of taggedModuleIds) {
    const outEdges = graph.outEdges.get(modId) ?? [];
    for (const edge of outEdges) {
      if (edge.kind === 'imports') allIds.add(edge.to);
    }
  }
  const consumerIds = new Set<string>();
  if (includeConsumers) {
    for (const modId of taggedModuleIds) {
      const inEdges = graph.inEdges.get(modId) ?? [];
      for (const edge of inEdges) {
        if (edge.kind === 'imports' && !taggedModuleIds.has(edge.from)) consumerIds.add(edge.from);
      }
    }
  }
  const nodeLabel = (id: string) => graph.nodes.get(id)?.label ?? id;
  const groupByPackage = (ids: Iterable<string>) => {
    const byPkg = new Map<string, string[]>();
    for (const id of ids) {
      const node = graph.nodes.get(id);
      if (!node || node.type !== 'module') continue;
      const pkgEdge = (graph.inEdges.get(id) ?? []).find(e => e.kind === 'contains' && e.from.startsWith('pkg:'));
      const pkg = pkgEdge?.from ?? 'unknown';
      let arr = byPkg.get(pkg);
      if (!arr) { arr = []; byPkg.set(pkg, arr); }
      arr.push(id);
    }
    return Object.fromEntries(
      [...byPkg.entries()].map(([pkg, mods]) => [pkg, mods.map(id => ({ id, label: nodeLabel(id) }))])
    );
  };
  const result: Record<string, unknown> = {
    domain: tag,
    taggedModules: taggedModuleIds.size,
    totalWithDeps: allIds.size,
    byPackage: groupByPackage(allIds),
  };
  if (includeConsumers && consumerIds.size > 0) {
    result.consumers = { count: consumerIds.size, byPackage: groupByPackage(consumerIds) };
  }
  const domainAnn = annotations.get(domainId);
  if (domainAnn) {
    result.semantic = domainAnn.semantic;
    result.semanticMeta = { pass: domainAnn.pass, updatedAt: domainAnn.updatedAt, fresh: true };
  }
  return result;
}

function handleGetEnvContext(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, snapshot } = ctx.getState();
  const scopePkg = args.packageId as string | undefined;
  const envMap = new Map<string, Array<{ moduleId: string; moduleLabel: string }>>();
  for (const mod of snapshot.modules) {
    if (scopePkg) {
      const pkgId = `pkg:${mod.packageName}`;
      if (pkgId !== scopePkg && mod.packageName !== scopePkg) continue;
    }
    const vars = mod.contentHints?.envVars;
    if (!vars?.length) continue;
    const label = graph.nodes.get(mod.id)?.label ?? mod.relativeFilePath;
    for (const v of vars) {
      let arr = envMap.get(v);
      if (!arr) { arr = []; envMap.set(v, arr); }
      arr.push({ moduleId: mod.id, moduleLabel: label });
    }
  }
  const sorted = [...envMap.entries()].sort((a, b) => a[0].localeCompare(b[0]));
  return {
    totalVars: sorted.length,
    totalModules: new Set(snapshot.modules.filter(m => m.contentHints?.envVars?.length).map(m => m.id)).size,
    ...(scopePkg ? { scope: scopePkg } : {}),
    envVars: Object.fromEntries(sorted),
  };
}

function handleGetRouteMap(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, snapshot } = ctx.getState();
  const layer = args.layer as string | undefined;
  const result: Record<string, unknown> = {};

  if (!layer || layer === 'frontend') {
    const routeModules = snapshot.modules.filter(m => m.contentHints?.hasRoutes);
    const routes: Array<{ path: string; component: string; moduleId: string }> = [];
    for (const mod of routeModules) {
      for (const r of mod.contentHints?.routes ?? []) {
        routes.push({ ...r, moduleId: mod.id });
      }
    }
    const conditionalRenders: Array<{ component: string; condition: string; renderedIn: string; moduleId: string; lineRange: { start: number; end: number } }> = [];
    for (const mod of snapshot.modules) {
      const crs = mod.contentHints?.conditionalRenders;
      if (!crs?.length) continue;
      for (const cr of crs) conditionalRenders.push({ ...cr, moduleId: mod.id });
    }
    result.frontend = {
      moduleCount: routeModules.length,
      routes,
      ...(conditionalRenders.length > 0 ? { conditionalRenders } : {}),
    };
  }

  if (!layer || layer === 'lambda') {
    const services = [...(graph.byType.get('service') ?? [])]
      .map(id => {
        const node = graph.nodes.get(id);
        if (!node || node.type !== 'service') return null;
        const handlerEdge = (graph.outEdges.get(id) ?? []).find(e => e.kind === 'handles');
        return { id, label: node.label, handler: node.data?.handler, handlerModule: handlerEdge?.to };
      })
      .filter((s): s is NonNullable<typeof s> => s !== null);
    result.lambda = { serviceCount: services.length, services };
  }
  return result;
}

function handleGetImplementations(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph } = ctx.getState();
  const ifaceName = args.interfaceName as string;
  const implementations: Array<Record<string, unknown>> = [];
  for (const capId of (graph.byType.get('capability') ?? [])) {
    const node = graph.nodes.get(capId);
    if (node?.type !== 'capability' || !node.data) continue;
    const impls = node.data.implementsInterfaces;
    if (!impls?.includes(ifaceName)) continue;
    const parentEdge = (graph.inEdges.get(capId) ?? []).find(e => e.kind === 'contains');
    const parentMod = parentEdge ? graph.nodes.get(parentEdge.from) : undefined;
    implementations.push({
      classId: capId,
      className: node.label,
      moduleId: parentMod?.id,
      moduleLabel: parentMod?.label,
      signature: node.data.signature,
      calls: node.data.calls,
      lineRange: node.data.lineRange,
    });
  }
  return { interface: ifaceName, count: implementations.length, implementations };
}

function handleGetCallContext(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph } = ctx.getState();
  const rawId = args.nodeId as string;
  const nodeId = resolveNodeId(graph, rawId);
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const node = graph.nodes.get(nodeId);
  if (!node) return { error: `Node not found: ${rawId}` };
  if (node.type !== 'capability') {
    return { nodeId, calls: [], note: 'Node is not a capability (export)' };
  }
  const calls = node.data?.calls ?? [];
  if (calls.length === 0) {
    const lineRange = node.data?.lineRange;
    const lineCount = lineRange ? lineRange.end - lineRange.start : 0;
    if (lineCount > 500) {
      return { nodeId, calls: [], note: `Function is ${lineCount} lines — call graph skipped (max 500 lines)` };
    }
    return { nodeId, calls: [], note: 'No calls detected or not a function/class' };
  }
  return { nodeId, label: node.label, calls };
}

const EXCLUDED_PACKAGE_DOMAIN = 'repo-context';

function handleGetAnnotationQueue(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, snapshot, annotations, domainsConfig } = ctx.getState();
  let domain = args.domain as string | undefined;
  if (domain) {
    domain = resolveDomainToCanonical(domain, domainsConfig);
  }
  const limit = (args.limit as number) ?? 10;
  const queue = annotations.getQueue(graph, snapshot, { domain, limit });
  let hint: string;
  if (queue.length > 0) {
    hint = `Process these ${queue.length} modules. For each: 1) read get_context_detail (with includeBody for complex modules), 2) write write_module_annotation with semantic annotation.`;
  } else if (domain && domain.toLowerCase() === EXCLUDED_PACKAGE_DOMAIN) {
    hint = `Domain "${domain}" has no modules: the repo-context package is excluded from the graph (not scanned). Use another domain (e.g. auth, config, ui) or omit domain for the global queue.`;
  } else {
    hint = 'All modules in scope are annotated and fresh!';
  }
  return {
    queueLength: queue.length,
    hint,
    items: queue,
  };
}

/** Canonical key order for semantic so saved annotations.json doesn't get reordered on each write. */
const SEMANTIC_KEY_ORDER: (keyof SemanticAnnotation)[] = [
  'summary', 'keyExports', 'assumptions', 'sideEffects', 'risks', 'patterns',
  'flowDescription', 'invariants', 'extensionPoints', 'integrationPoints',
  'stateShape', 'dataFlow', 'envDependencies',
];

function semanticWithStableKeyOrder(semantic: SemanticAnnotation): SemanticAnnotation {
  const s = semantic as unknown as Record<string, unknown>;
  const out: Record<string, unknown> = {};
  for (const k of SEMANTIC_KEY_ORDER) {
    if (k in s && s[k] !== undefined) {
      out[k] = s[k];
    }
  }
  return out as unknown as SemanticAnnotation;
}

function handleAnnotateModule(ctx: ToolContext, args: Record<string, unknown>): unknown {
  const { graph, snapshot, modulesById, annotations } = ctx.getState();
  const rawId = args.nodeId as string;
  const semantic = args.semantic as SemanticAnnotation;
  const nodeId = resolveNodeId(graph, rawId);
  if (!nodeId) return { error: `Node not found: ${rawId}` };
  const existing = annotations.get(nodeId);
  const mergedSemantic: SemanticAnnotation = existing ? { ...existing.semantic, ...semantic } : semantic;
  const validationResult = SemanticAnnotationSchema.safeParse(mergedSemantic);
  if (!validationResult.success) {
    return { error: `Invalid semantic annotation: ${validationResult.error.message}` };
  }
  const node = graph.nodes.get(nodeId);
  if (!node) return { error: `Node not found: ${rawId}` };

  let contentHash: string;
  const mod = modulesById.get(nodeId);
  if (mod?.contentHash) {
    contentHash = mod.contentHash;
  } else if (nodeId.startsWith('infra:')) {
    const infraMod = snapshot.infraModules?.find(m => m.id === nodeId);
    contentHash = infraMod?.contentHash ?? 'unknown';
  } else if (node.type === 'service') {
    const inEdges = graph.inEdges.get(nodeId) ?? [];
    const parentInfraId = inEdges.find(e => e.kind === 'contains')?.from;
    const infraMod = parentInfraId ? snapshot.infraModules?.find(m => m.id === parentInfraId) : undefined;
    contentHash = infraMod?.contentHash ?? 'unknown';
  } else {
    contentHash = 'unknown';
  }

  const pass = existing ? existing.pass + 1 : 1;
  const semanticStable = semanticWithStableKeyOrder(mergedSemantic);
  const nodeType = node.type as StoredAnnotation['nodeType'];
  annotations.set(nodeId, {
    nodeId,
    nodeType,
    contentHash,
    pass,
    updatedAt: new Date().toISOString(),
    semantic: semanticStable,
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
  });
  return {
    status: 'saved',
    nodeId,
    pass,
    contentHash,
    schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
    merged: !!existing,
  };
}

function handleGetAnnotationsStats(ctx: ToolContext, _args: Record<string, unknown>): unknown {
  const { graph, snapshot, annotations } = ctx.getState();
  return annotations.getStats(graph, snapshot);
}

function handleRefreshContext(ctx: ToolContext, _args: Record<string, unknown>): unknown {
  const before = graphStats(ctx.getState().graph);
  ctx.refreshContext();
  const afterState = ctx.getState();
  const after = graphStats(afterState.graph);
  return {
    status: 'rebuilt',
    builtAt: afterState.builtAt,
    before: { nodes: before.totalNodes, edges: before.totalEdges },
    after: { nodes: after.totalNodes, edges: after.totalEdges },
  };
}

export const toolHandlers: Record<string, ToolHandler> = {
  get_context_detail: handleGetContextDetail,
  get_path_from_root: handleGetLocationInRepo,
  get_domain_or_focus_context: handleGetContext,
  search_repo_context: handleFindInRepo,
  get_dependency_impact: handleGetImpact,
  get_domain_modules_slice: handleGetFeatureContext,
  get_env_vars_usage: handleGetEnvContext,
  get_routes_map: handleGetRouteMap,
  get_interface_implementations: handleGetImplementations,
  get_export_callees: handleGetCallContext,
  get_modules_annotation_queue: handleGetAnnotationQueue,
  write_module_annotation: handleAnnotateModule,
  get_annotation_coverage_stats: handleGetAnnotationsStats,
  refresh_repo_context: handleRefreshContext,
};
