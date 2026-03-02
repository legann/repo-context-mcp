/**
 * Integration tests for the repo-context pipeline.
 * Runs the full snapshot + graph build once (beforeAll), then validates Stage 1/2/3, query layer,
 * content hints (routes, env, domains), exports (signatures, fields, calls, privateMembers),
 * and annotations. Not a fast "smoke" test — expect several seconds.
 */
import * as path from 'node:path';
import * as fs from 'node:fs';
import { collectSyntacticSnapshot } from '../stage1/index.js';
import { buildSemanticGraph } from '../stage2/index.js';
import { buildNodeView, pathFromRoot, getImpact, graphStats } from '../graph/index.js';
import { AnnotationStore } from '../annotations/store.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../types.js';
import { repoRoot, cacheDir } from '../paths.js';
import type { SyntacticSnapshot, SemanticGraph } from '../types.js';

describe('integration', () => {
  let snapshot: SyntacticSnapshot;
  let graph: SemanticGraph;
  let stats: ReturnType<typeof graphStats>;

  beforeAll(() => {
    snapshot = collectSyntacticSnapshot(repoRoot);
    graph = buildSemanticGraph(snapshot);
    stats = graphStats(graph);
  });

  // ── Stage 1 ──

  it('discovers packages (>= 1)', () => {
    expect(snapshot.packages.length).toBeGreaterThanOrEqual(1);
  });

  it('collects modules (> 300)', () => {
    expect(snapshot.modules.length).toBeGreaterThan(300);
  });

  it('module ids follow mod: convention', () => {
    for (const m of snapshot.modules) {
      expect(m.id).toMatch(/^mod:/);
    }
  });

  it('resolves > 90% internal imports', () => {
    let total = 0, resolved = 0;
    for (const m of snapshot.modules) {
      for (const i of m.imports) {
        if (i.isExternal) continue;
        total++;
        if (i.resolvedModuleId) resolved++;
      }
    }
    const ratio = resolved / total;
    expect(ratio).toBeGreaterThan(0.9);
  });

  it('exports have line ranges', () => {
    const allExports = snapshot.modules.flatMap(m => m.exports);
    for (const e of allExports) {
      expect(e.lineRange.start).toBeGreaterThan(0);
    }
  });

  // ── Stage 2 ──

  it('root node exists', () => {
    expect(graph.nodes.has('root')).toBe(true);
  });

  it('all packages have nodes', () => {
    for (const pkg of snapshot.packages) {
      expect(graph.nodes.has(`pkg:${pkg.name}`)).toBe(true);
    }
  });

  it('domain nodes exist (auth and at least one path-based domain)', () => {
    expect(graph.nodes.has('domain:auth')).toBe(true);
    const domainSet = graph.byType.get('domain') ?? new Set<string>();
    expect(domainSet.size).toBeGreaterThanOrEqual(2);
  });

  it('every module has one contains parent', () => {
    for (const m of snapshot.modules) {
      const parents = (graph.inEdges.get(m.id) ?? []).filter(e => e.kind === 'contains');
      expect(parents.length).toBe(1);
    }
  });

  it('capability nodes > 500', () => {
    const caps = graph.byType.get('capability');
    expect(caps).toBeDefined();
    expect(caps!.size).toBeGreaterThan(500);
  });

  // ── Query layer ──

  it('buildNodeView works for root', () => {
    const view = buildNodeView(graph, 'root');
    expect(view).not.toBeNull();
    expect(view!.drill_down.length).toBeGreaterThan(0);
  });

  it('buildNodeView for capability has symbol detail', () => {
    const capId = [...(graph.byType.get('capability') ?? [])].find(id => {
      const n = graph.nodes.get(id);
      return n?.type === 'capability' && n.data?.signature;
    });
    expect(capId).toBeDefined();
    const view = buildNodeView(graph, capId!);
    expect(view).not.toBeNull();
    expect(view!.signature).toBeDefined();
  });

  it('pathFromRoot returns chain', () => {
    const result = pathFromRoot(graph, snapshot.modules[0].id);
    expect(result).not.toBeNull();
    expect(result!.path[0].id).toBe('root');
  });

  it('getImpact returns results', () => {
    const mod = snapshot.modules.find(m => m.imports.some(i => !i.isExternal && i.resolvedModuleId));
    expect(mod).toBeDefined();
    const impact = getImpact(graph, mod!.id);
    expect(impact.upstream.length).toBeGreaterThan(0);
  });

  it('module node view drill_down[] has signatures for capability children', () => {
    const modWithCaps = snapshot.modules.find(m => m.exports.some(e => e.signature));
    expect(modWithCaps).toBeDefined();
    const view = buildNodeView(graph, modWithCaps!.id);
    expect(view).not.toBeNull();
    const withSig = view!.drill_down.filter(d => d.signature);
    expect(withSig.length).toBeGreaterThan(0);
  });

  it('module node view drill_down[] has symbolKind for capability children', () => {
    const modWithCaps = snapshot.modules.find(m =>
      m.exports.some(e => e.kind === 'interface' || e.kind === 'function' || e.kind === 'class'),
    );
    expect(modWithCaps).toBeDefined();
    const view = buildNodeView(graph, modWithCaps!.id);
    expect(view).not.toBeNull();
    const withKind = view!.drill_down.filter(d => d.symbolKind);
    expect(withKind.length).toBeGreaterThan(0);
  });

  it('typeValue collected for type alias exports', () => {
    const typeExport = snapshot.modules.flatMap(m => m.exports).find(e => e.kind === 'type' && e.typeValue);
    expect(typeExport).toBeDefined();
    expect(typeExport!.typeValue!.length).toBeGreaterThan(0);
  });

  it('typeValue available in capability node view', () => {
    const capId = [...(graph.byType.get('capability') ?? [])].find(id => {
      const n = graph.nodes.get(id);
      return n?.type === 'capability' && n.data?.typeValue;
    });
    expect(capId).toBeDefined();
    const view = buildNodeView(graph, capId!);
    expect(view).not.toBeNull();
    expect(view!.typeValue).toBeDefined();
  });

  it('typeValue available in module drill_down[]', () => {
    const modWithTypeExport = snapshot.modules.find(m => m.exports.some(e => e.typeValue));
    expect(modWithTypeExport).toBeDefined();
    const view = buildNodeView(graph, modWithTypeExport!.id);
    expect(view).not.toBeNull();
    const withTypeVal = view!.drill_down.filter(d => d.typeValue);
    expect(withTypeVal.length).toBeGreaterThan(0);
  });

  // ── Content hints ──

  it('domain:routing exists and has tagged modules', () => {
    expect(graph.nodes.has('domain:routing')).toBe(true);
    const incoming = (graph.inEdges.get('domain:routing') ?? []).filter(e => e.kind === 'tagged');
    expect(incoming.length).toBeGreaterThan(0);
  });

  it('domain:config exists and has tagged modules', () => {
    expect(graph.nodes.has('domain:config')).toBe(true);
    const incoming = (graph.inEdges.get('domain:config') ?? []).filter(e => e.kind === 'tagged');
    expect(incoming.length).toBeGreaterThan(0);
  });

  it('contentHints.hasRoutes detected in at least one module', () => {
    const withRoutes = snapshot.modules.filter(m => m.contentHints?.hasRoutes);
    expect(withRoutes.length).toBeGreaterThan(0);
  });

  it('contentHints.envVars detected in at least one module', () => {
    const withEnv = snapshot.modules.filter(m => m.contentHints?.envVars && m.contentHints.envVars.length > 0);
    expect(withEnv.length).toBeGreaterThan(0);
  });

  it('module node view includes envVars when present', () => {
    const modWithEnv = snapshot.modules.find(m => m.contentHints?.envVars && m.contentHints.envVars.length > 0);
    expect(modWithEnv).toBeDefined();
    const view = buildNodeView(graph, modWithEnv!.id);
    expect(view).not.toBeNull();
    expect(view!.envVars).toBeDefined();
    expect(view!.envVars!.length).toBeGreaterThan(0);
  });

  it('module node view includes hasRoutes when present', () => {
    const modWithRoutes = snapshot.modules.find(m => m.contentHints?.hasRoutes);
    expect(modWithRoutes).toBeDefined();
    const view = buildNodeView(graph, modWithRoutes!.id);
    expect(view).not.toBeNull();
    expect(view!.hasRoutes).toBe(true);
  });

  // ── Enriched getImpact ──

  it('getImpact downstream has importedNames info in snapshot', () => {
    let sourceModuleId: string | undefined;
    for (const mod of snapshot.modules) {
      const impact = getImpact(graph, mod.id);
      if (impact.downstream.length > 0) { sourceModuleId = mod.id; break; }
    }
    expect(sourceModuleId).toBeDefined();
    const impact = getImpact(graph, sourceModuleId!);
    expect(impact.downstream.length).toBeGreaterThan(0);
    const dependentMod = snapshot.modules.find(m =>
      m.id === impact.downstream[0] && m.imports.some(i => i.resolvedModuleId === sourceModuleId)
    );
    expect(dependentMod).toBeDefined();
    const imp = dependentMod!.imports.find(i => i.resolvedModuleId === sourceModuleId);
    expect(imp).toBeDefined();
    expect(imp!.importedNames.length).toBeGreaterThan(0);
  });

  // ── Env vars aggregation ──

  it('envVars aggregation across packages works', () => {
    const envMap = new Map<string, string[]>();
    for (const mod of snapshot.modules) {
      if (!mod.contentHints?.envVars) continue;
      for (const v of mod.contentHints.envVars) {
        let arr = envMap.get(v);
        if (!arr) { arr = []; envMap.set(v, arr); }
        arr.push(mod.id);
      }
    }
    expect(envMap.size).toBeGreaterThan(5);
    const multiModule = [...envMap.entries()].find(([, mods]) => mods.length > 1);
    expect(multiModule).toBeDefined();
  });

  // ── Route extraction ──

  it('modules with hasRoutes contain <Route in source', () => {
    const modWithRoutes = snapshot.modules.find(m => m.contentHints?.hasRoutes);
    expect(modWithRoutes).toBeDefined();
    const content = fs.readFileSync(modWithRoutes!.filePath, 'utf-8');
    expect(content).toContain('<Route');
  });

  it('contentHints.routes extracted from Route JSX elements', () => {
    const modWithRoutes = snapshot.modules.find(m => m.contentHints?.routes && m.contentHints.routes.length > 0);
    expect(modWithRoutes).toBeDefined();
    const routes = modWithRoutes!.contentHints!.routes!;
    expect(routes.length).toBeGreaterThanOrEqual(2);
    const withPath = routes.filter(r => r.path && r.path.startsWith('/'));
    expect(withPath.length).toBeGreaterThanOrEqual(2);
  });

  // ── Interface fields ──

  it('interface exports have fields[] with types and optional flags', () => {
    const ifaceExport = snapshot.modules.flatMap(m => m.exports).find(e => e.kind === 'interface' && e.fields && e.fields.length > 0);
    expect(ifaceExport).toBeDefined();
    expect(ifaceExport!.fields!.length).toBeGreaterThan(0);
    const field = ifaceExport!.fields![0];
    expect(field.name).toBeDefined();
    expect(field.type).toBeDefined();
  });

  it('interface typeValue includes field signatures', () => {
    const ifaceExport = snapshot.modules.flatMap(m => m.exports).find(
      e => e.kind === 'interface' && e.typeValue && e.typeValue.startsWith('{')
    );
    expect(ifaceExport).toBeDefined();
    expect(ifaceExport!.typeValue!).toContain(':');
  });

  it('interface fields available in capability node view drill_down', () => {
    const capId = [...(graph.byType.get('capability') ?? [])].find(id => {
      const n = graph.nodes.get(id);
      return n?.type === 'capability' && n.data?.symbolKind === 'interface' && n.data?.fields;
    });
    expect(capId).toBeDefined();
    const parentEdge = (graph.inEdges.get(capId!) ?? []).find(e => e.kind === 'contains');
    expect(parentEdge).toBeDefined();
    const view = buildNodeView(graph, parentEdge!.from);
    expect(view).not.toBeNull();
    const entry = view!.drill_down.find(d => d.id === capId);
    expect(entry).toBeDefined();
    expect(entry!.fields).toBeDefined();
  });

  // ── Implementations ──

  it('implementsInterfaces collected for classes', () => {
    const classWithImpl = snapshot.modules.flatMap(m => m.exports).find(
      e => e.kind === 'class' && e.implementsInterfaces && e.implementsInterfaces.length > 0
    );
    expect(classWithImpl).toBeDefined();
    expect(classWithImpl!.implementsInterfaces![0].length).toBeGreaterThan(0);
  });

  // ── Call graph ──

  it('calls[] collected for exported functions', () => {
    const fnWithCalls = snapshot.modules.flatMap(m => m.exports).find(
      e => (e.kind === 'function' || e.kind === 'class') && e.calls && e.calls.length > 0
    );
    expect(fnWithCalls).toBeDefined();
    expect(fnWithCalls!.calls!.length).toBeGreaterThan(0);
  });

  it('calls available in capability node view', () => {
    const capId = [...(graph.byType.get('capability') ?? [])].find(id => {
      const n = graph.nodes.get(id);
      return n?.type === 'capability' && n.data?.calls && n.data.calls.length > 0;
    });
    expect(capId).toBeDefined();
    const view = buildNodeView(graph, capId!);
    expect(view).not.toBeNull();
    expect(view!.calls).toBeDefined();
    expect(view!.calls!.length).toBeGreaterThan(0);
  });

  // ── privateMembers ──

  it('privateMembers collected for classes with non-public members', () => {
    const classWithPrivate = snapshot.modules.flatMap(m => m.exports).find(
      e => e.kind === 'class' && e.privateMembers && e.privateMembers.length > 0
    );
    expect(classWithPrivate).toBeDefined();
    const member = classWithPrivate!.privateMembers![0];
    expect(member.name.length).toBeGreaterThan(0);
    expect(['private', 'protected']).toContain(member.access);
    expect(member.lineRange.start).toBeGreaterThan(0);
  });

  it('privateMembers stored in graph node data', () => {
    const capId = [...(graph.byType.get('capability') ?? [])].find(id => {
      const n = graph.nodes.get(id);
      return n?.type === 'capability' && n.data?.symbolKind === 'class' && n.data?.privateMembers;
    });
    expect(capId).toBeDefined();
    const node = graph.nodes.get(capId!);
    expect(node).toBeDefined();
    expect(node!.type).toBe('capability');
    if (node!.type === 'capability') {
      expect(node!.data?.privateMembers?.length).toBeGreaterThan(0);
    }
  });

  // ── conditionalRenders ──

  it('conditionalRenders detected in at least one module (soft)', () => {
    const modWithCR = snapshot.modules.find(m => m.contentHints?.conditionalRenders && m.contentHints.conditionalRenders.length > 0);
    if (!modWithCR) return; // soft pass
    const cr = modWithCR.contentHints!.conditionalRenders![0];
    expect(cr.component.length).toBeGreaterThan(0);
    expect(cr.condition.length).toBeGreaterThan(0);
    expect(cr.renderedIn.length).toBeGreaterThan(0);
  });

  // ── Stage 3: Content hash + AnnotationStore ──

  it('contentHash computed for all modules', () => {
    for (const mod of snapshot.modules) {
      expect(typeof mod.contentHash).toBe('string');
      expect(mod.contentHash.length).toBe(16);
    }
  });

  it('contentHash is deterministic', () => {
    const snapshot2 = collectSyntacticSnapshot(repoRoot);
    const mod1 = snapshot.modules[0];
    const mod2 = snapshot2.modules.find(m => m.id === mod1.id);
    expect(mod2).toBeDefined();
    expect(mod1.contentHash).toBe(mod2!.contentHash);
  });

  it('AnnotationStore set/get/isFresh works', () => {
    const tmpDir = path.join(cacheDir, '_test_annotations');
    const store = AnnotationStore.createSync(tmpDir);

    const testId = 'mod:test/module';
    store.set(testId, {
      nodeId: testId,
      nodeType: 'module',
      contentHash: 'abc123',
      pass: 1,
      updatedAt: new Date().toISOString(),
      semantic: { summary: 'Test annotation' },
      schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
    });

    const retrieved = store.get(testId);
    expect(retrieved).toBeDefined();
    expect(retrieved!.semantic.summary).toBe('Test annotation');
    expect(store.isFresh(testId, 'abc123')).toBe(true);
    expect(store.isFresh(testId, 'different')).toBe(false);

    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  it('graph is deterministic', () => {
    const graph2 = buildSemanticGraph(snapshot);
    const stats2 = graphStats(graph2);
    expect(stats.totalNodes).toBe(stats2.totalNodes);
    expect(stats.totalEdges).toBe(stats2.totalEdges);
  });

  it('domain tagging is deterministic (label propagation)', () => {
    const graph2 = buildSemanticGraph(snapshot);
    for (const modId of snapshot.modules.map(m => m.id)) {
      const tag1 = (graph.outEdges.get(modId) ?? []).filter(e => e.kind === 'tagged').map(e => e.to).sort();
      const tag2 = (graph2.outEdges.get(modId) ?? []).filter(e => e.kind === 'tagged').map(e => e.to).sort();
      expect(tag1).toEqual(tag2);
    }
  });
});
