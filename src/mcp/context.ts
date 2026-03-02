import { collectSyntacticSnapshot } from '../stage1/index.js';
import { createFileCache, type SnapshotCache } from '../stage1/cache.js';
import { buildSemanticGraph } from '../stage2/index.js';
import { loadDomainsConfig } from '../stage2/domains.js';
import { graphStats } from '../graph/index.js';
import { AnnotationStore } from '../annotations/store.js';
import type { ModuleInfo, SyntacticSnapshot } from '../types.js';
import type { AppState, SearchIndex } from './handlers.js';
import type { ResolvedConfig } from '../config.js';

function buildSearchIndex(graph: AppState['graph']): SearchIndex {
  const index = new Map<string, Set<string>>();
  const add = (token: string, nodeId: string) => {
    if (!token) return;
    let set = index.get(token);
    if (!set) { set = new Set(); index.set(token, set); }
    set.add(nodeId);
  };
  const tokenize = (s: string): string[] =>
    s.toLowerCase().replace(/[/\-_.:]/g, ' ').split(/\s+/).filter(Boolean);
  for (const node of graph.nodes.values()) {
    for (const t of tokenize(node.id)) add(t, node.id);
    for (const t of tokenize(node.label)) add(t, node.id);
    if (node.type === 'capability' && node.data) {
      if (node.data.signature) for (const t of tokenize(node.data.signature)) add(t, node.id);
      if (node.data.typeValue) for (const t of tokenize(node.data.typeValue)) add(t, node.id);
      for (const iface of node.data.implementsInterfaces ?? []) {
        for (const t of tokenize(iface)) add(t, node.id);
      }
    }
  }
  return index;
}

export class AppContext {
  private state!: AppState;
  private readonly repoRoot: string;
  private readonly artifactsDir: string;
  private readonly cache: SnapshotCache;
  private readonly scanIgnorePatterns: string[];
  private previousSnapshot: SyntacticSnapshot | null = null;

  private constructor(repoRoot: string, artifactsDir: string, config?: ResolvedConfig) {
    this.repoRoot = repoRoot;
    this.artifactsDir = artifactsDir;
    this.cache = createFileCache(artifactsDir);
    this.scanIgnorePatterns = config?.scan.ignorePatterns ?? [];
  }

  /** Async factory — preferred for MCP server startup. */
  static async create(repoRoot: string, artifactsDir: string, config?: ResolvedConfig): Promise<AppContext> {
    const ctx = new AppContext(repoRoot, artifactsDir, config);
    ctx.previousSnapshot = await ctx.cache.loadAsync();
    ctx.state = await ctx.buildStateAsync();
    return ctx;
  }

  /** Sync factory — for CLI demo and tests. */
  static createSync(repoRoot: string, artifactsDir: string, config?: ResolvedConfig): AppContext {
    const ctx = new AppContext(repoRoot, artifactsDir, config);
    ctx.previousSnapshot = ctx.cache.load();
    ctx.state = ctx.buildStateSync();
    return ctx;
  }

  getState(): AppState {
    return this.state;
  }

  refresh(): { before: { totalNodes: number; totalEdges: number }; after: { totalNodes: number; totalEdges: number } } {
    const before = graphStats(this.state.graph);
    this.previousSnapshot = this.state.snapshot;
    this.state = this.buildStateSync();
    return { before, after: graphStats(this.state.graph) };
  }

  private collectSnapshotAndGraph() {
    let snapshot: SyntacticSnapshot;
    try {
      console.log('Stage 1: Syntactic snapshot...');
      snapshot = collectSyntacticSnapshot(this.repoRoot, {
        previousSnapshot: this.previousSnapshot ?? undefined,
        ignorePatterns: this.scanIgnorePatterns.length > 0 ? this.scanIgnorePatterns : undefined,
      });
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[FATAL] Stage 1 (syntactic snapshot) failed: ${msg}`);
      throw new Error(`Syntactic snapshot failed: ${msg}`);
    }

    try {
      this.cache.save(snapshot);
    } catch (e) {
      console.error(`[WARN] Failed to save snapshot cache: ${(e as Error).message}`);
    }
    this.previousSnapshot = snapshot;

    const modulesById = new Map<string, ModuleInfo>();
    for (const m of snapshot.modules) modulesById.set(m.id, m);

    let graph: ReturnType<typeof buildSemanticGraph>;
    try {
      console.log('Stage 2: Repo context (semantic graph)...');
      graph = buildSemanticGraph(snapshot, modulesById);
    } catch (e) {
      const msg = (e as Error).message;
      console.error(`[FATAL] Stage 2 (semantic graph) failed: ${msg}`);
      throw new Error(`Semantic graph build failed: ${msg}`);
    }

    const searchIndex = buildSearchIndex(graph);
    const stats = graphStats(graph);
    console.log(`  Nodes:   ${stats.totalNodes}`);
    console.log(`  Edges:   ${stats.totalEdges}`);
    return { snapshot, modulesById, graph, searchIndex };
  }

  private async buildStateAsync(): Promise<AppState> {
    const { snapshot, modulesById, graph, searchIndex } = this.collectSnapshotAndGraph();
    console.log('Stage 3: Loading annotations...');
    const annotations = await AnnotationStore.create(this.artifactsDir);
    const domainsConfig = loadDomainsConfig(this.repoRoot);
    const builtAt = new Date().toISOString();
    return { graph, snapshot, modulesById, searchIndex, annotations, domainsConfig, builtAt };
  }

  private buildStateSync(): AppState {
    const { snapshot, modulesById, graph, searchIndex } = this.collectSnapshotAndGraph();
    console.log('Stage 3: Loading annotations...');
    const annotations = AnnotationStore.createSync(this.artifactsDir);
    const domainsConfig = loadDomainsConfig(this.repoRoot);
    const builtAt = new Date().toISOString();
    return { graph, snapshot, modulesById, searchIndex, annotations, domainsConfig, builtAt };
  }
}
