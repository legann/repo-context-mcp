/**
 * Serialize the semantic graph to YAML and/or JSON.
 *
 * Usage:
 *   yarn repo-context:dump              # writes .cache/graph.yaml + .cache/graph.json
 *   yarn repo-context:dump --yaml       # only YAML
 *   yarn repo-context:dump --json       # only JSON
 */

import * as path from 'node:path';
import * as fs from 'node:fs';
import yaml from 'js-yaml';
import { collectSyntacticSnapshot } from '../stage1/index.js';
import { buildSemanticGraph } from '../stage2/index.js';
import { graphStats, getChildren } from '../graph/index.js';
import type { SemanticGraph, SyntacticSnapshot, FieldInfo, MemberInfo, RouteInfo, ConditionalRender } from '../types.js';
import { repoRoot, cacheDir } from '../paths.js';

interface DumpModule {
  id: string;
  label: string;
  file: string;
  domains: string[];
  imports: string[];
  exports: DumpExport[];
  envVars?: string[];
  routes?: RouteInfo[];
  conditionalRenders?: ConditionalRender[];
}

interface DumpExport {
  name: string;
  kind: string;
  signature?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  privateMembers?: MemberInfo[];
  lineRange?: { start: number; end: number };
}

interface DumpPackage {
  id: string;
  name: string;
  modules: DumpModule[];
}

interface DumpGraph {
  meta: {
    generatedAt: string;
    repoRoot: string;
    nodes: number;
    edges: number;
  };
  domains: Record<string, string[]>;
  services: Array<{ id: string; label: string; handler?: string }>;
  packages: DumpPackage[];
}

function buildDump(graph: SemanticGraph, snapshot: SyntacticSnapshot): DumpGraph {
  const stats = graphStats(graph);

  // Domains → tagged module ids
  const domains: Record<string, string[]> = {};
  const domainNodes = graph.byType.get('domain');
  if (domainNodes) {
    for (const domainId of domainNodes) {
      const node = graph.nodes.get(domainId);
      if (!node) continue;
      const incoming = graph.inEdges.get(domainId) ?? [];
      domains[node.label] = [...new Set(
        incoming.filter(e => e.kind === 'tagged').map(e => e.from)
      )];
    }
  }

  // Services
  const services: DumpGraph['services'] = [];
  const serviceNodes = graph.byType.get('service');
  if (serviceNodes) {
    for (const svcId of serviceNodes) {
      const svc = graph.nodes.get(svcId);
      if (!svc) continue;
      const outEdges = graph.outEdges.get(svcId) ?? [];
      const handlerEdge = outEdges.find(e => e.kind === 'handles');
      services.push({
        id: svcId,
        label: svc.label,
        handler: handlerEdge?.to,
      });
    }
  }

  // Packages → modules → exports
  const packages: DumpPackage[] = [];
  const pkgNodes = graph.byType.get('package');
  if (pkgNodes) {
    for (const pkgId of pkgNodes) {
      const pkgNode = graph.nodes.get(pkgId);
      if (!pkgNode) continue;
      const moduleNodes = getChildren(graph, pkgId);

      const modules: DumpModule[] = [];
      for (const modNode of moduleNodes) {
        if (modNode.type !== 'module') continue;

        // file path from node data
        const filePath = (modNode.data?.filePath as string) ?? '';
        const relFile = filePath ? path.relative(repoRoot, filePath) : modNode.id;

        // domains this module is tagged with
        const modDomains: string[] = [];
        const outEdges = graph.outEdges.get(modNode.id) ?? [];
        for (const e of outEdges) {
          if (e.kind === 'tagged') {
            const domNode = graph.nodes.get(e.to);
            if (domNode) modDomains.push(domNode.label);
          }
        }

        // imports (other modules)
        const imports: string[] = [];
        for (const e of outEdges) {
          if (e.kind === 'imports') imports.push(e.to);
        }

        // exports (capabilities)
        const capChildren = getChildren(graph, modNode.id);
        const exports: DumpExport[] = capChildren.map(cap => {
          const entry: DumpExport = {
            name: cap.label,
            kind: cap.type === 'capability' && cap.data ? (cap.data.symbolKind ?? 'unknown') : 'unknown',
          };
          if (cap.type === 'capability' && cap.data) {
            const d = cap.data;
            if (d.signature) entry.signature = d.signature;
            if (d.typeValue) entry.typeValue = d.typeValue;
            if (d.fields) entry.fields = d.fields;
            if (d.implementsInterfaces) entry.implementsInterfaces = d.implementsInterfaces;
            if (d.calls) entry.calls = d.calls;
            if (d.privateMembers) entry.privateMembers = d.privateMembers;
            if (d.lineRange) entry.lineRange = d.lineRange;
          }
          return entry;
        });

        // content hints from snapshot
        const snapshotMod = snapshot.modules.find(m => m.id === modNode.id);
        const hints = snapshotMod?.contentHints;

        const mod: DumpModule = {
          id: modNode.id,
          label: modNode.label,
          file: relFile,
          domains: modDomains,
          imports,
          exports,
        };
        if (hints?.envVars?.length) mod.envVars = hints.envVars;
        if (hints?.routes?.length) mod.routes = hints.routes;
        if (hints?.conditionalRenders?.length) mod.conditionalRenders = hints.conditionalRenders;

        modules.push(mod);
      }

      // Sort modules by file path
      modules.sort((a, b) => a.file.localeCompare(b.file));

      packages.push({
        id: pkgId,
        name: pkgNode.label,
        modules,
      });
    }
  }

  // Sort packages by name
  packages.sort((a, b) => a.name.localeCompare(b.name));

  return {
    meta: {
      generatedAt: new Date().toISOString(),
      repoRoot,
      nodes: stats.totalNodes,
      edges: stats.totalEdges,
    },
    domains,
    services,
    packages,
  };
}

// ── Main ──

const args = process.argv.slice(2);
const wantYaml = args.length === 0 || args.includes('--yaml');
const wantJson = args.length === 0 || args.includes('--json');

console.log(`Building repo context for: ${repoRoot}`);

console.log('Stage 1: Syntactic snapshot...');
const snapshot = collectSyntacticSnapshot(repoRoot);

console.log('Stage 2: Repo context (semantic graph)...');
const graph = buildSemanticGraph(snapshot);

console.log('Serializing...\n');
const dump = buildDump(graph, snapshot);

fs.mkdirSync(cacheDir, { recursive: true });

if (wantYaml) {
  const yamlPath = path.join(cacheDir, 'graph.yaml');
  const yamlStr = yaml.dump(dump, {
    indent: 2,
    lineWidth: 120,
    noRefs: true,
    sortKeys: false,
  });
  fs.writeFileSync(yamlPath, yamlStr);
  const sizeKb = (Buffer.byteLength(yamlStr) / 1024).toFixed(1);
  console.log(`  YAML: ${path.relative(repoRoot, yamlPath)} (${sizeKb} KB)`);
}

if (wantJson) {
  const jsonPath = path.join(cacheDir, 'graph.json');
  const jsonStr = JSON.stringify(dump, null, 2);
  fs.writeFileSync(jsonPath, jsonStr);
  const sizeKb = (Buffer.byteLength(jsonStr) / 1024).toFixed(1);
  console.log(`  JSON: ${path.relative(repoRoot, jsonPath)} (${sizeKb} KB)`);
}

console.log(`\n  ${dump.packages.length} packages, ${dump.packages.reduce((s, p) => s + p.modules.length, 0)} modules, ${dump.meta.nodes} nodes`);
console.log('');
