/**
 * One-shot: align stored contentHash (and schemaVersion) with the current snapshot/graph
 * for module, infra, and service annotations. Does not bump pass.
 * Run after repo-context or IaC changes: `npm run annotations:resync-hashes`
 */
import { repoRoot, artifactsDir } from '../src/paths.js';
import { collectSyntacticSnapshot } from '../src/stage1/index.js';
import { buildSemanticGraph } from '../src/stage2/index.js';
import { AnnotationStore } from '../src/annotations/store.js';
import { resolveServiceResourceContentHash } from '../src/annotations/service-resource-hash.js';
import {
  CURRENT_ANNOTATION_SCHEMA_VERSION,
  type ModuleInfo,
  type SemanticGraph,
  type StoredAnnotation,
  type SyntacticSnapshot,
} from '../src/types.js';

function currentHashForAnnotation(
  nodeId: string,
  graph: SemanticGraph,
  snapshot: SyntacticSnapshot,
  modulesById: Map<string, ModuleInfo>,
): string | undefined {
  const mod = modulesById.get(nodeId);
  if (mod) return mod.contentHash;
  if (nodeId.startsWith('infra:')) {
    return snapshot.infraModules?.find(m => m.id === nodeId)?.contentHash;
  }
  const gNode = graph.nodes.get(nodeId);
  if (gNode?.type === 'service') {
    return resolveServiceResourceContentHash(graph, snapshot, nodeId);
  }
  return undefined;
}

async function main(): Promise<void> {
  console.log('Collecting snapshot...');
  const snapshot = collectSyntacticSnapshot(repoRoot);
  const modulesById = new Map(snapshot.modules.map(m => [m.id, m]));
  console.log('Building graph...');
  const graph = buildSemanticGraph(snapshot, modulesById);
  console.log('Loading annotations...');
  const store = await AnnotationStore.create(artifactsDir);
  const migrated = store.migrateServiceAnnotationHashesFromParentTemplate(graph, snapshot);
  if (migrated > 0) {
    console.log(`migrateServiceAnnotationHashesFromParentTemplate: ${migrated} row(s)`);
  }

  let updated = 0;
  const now = new Date().toISOString();
  for (const [nodeId, ann] of Object.entries(store.getAll()) as [string, StoredAnnotation][]) {
    const cur = currentHashForAnnotation(nodeId, graph, snapshot, modulesById);
    if (cur === undefined) continue;
    const schemaOk = (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
    const hashOk = ann.contentHash === cur;
    if (hashOk && schemaOk) continue;
    store.set(nodeId, {
      ...ann,
      contentHash: cur,
      schemaVersion: CURRENT_ANNOTATION_SCHEMA_VERSION,
      updatedAt: now,
    });
    updated++;
  }
  store.flush();
  console.log(`Updated ${updated} annotation row(s) (contentHash and/or schemaVersion).`);

  const stats = store.getStats(graph, snapshot);
  console.log('Modules:', { fresh: stats.fresh, stale: stats.stale, total: stats.totalModules });
  console.log('Infra:', stats.infraModules);
  console.log('Services:', stats.services);
}

main().catch(e => {
  console.error(e);
  process.exit(1);
});
