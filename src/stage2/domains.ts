import * as fs from 'node:fs';
import * as path from 'node:path';
import type { SyntacticSnapshot, SemanticGraph, ModuleInfo } from '../types.js';
import { SELF_TSCONFIG_REL } from '../paths.js';

/** First path segments that are structural — skip when inferring domain from path. */
export const STRUCTURAL_DIRS = new Set([
  // Standard project structure
  'src', 'lib', 'libs', 'internal', 'shared', 'common', 'utils', 'core',
  'components', 'hooks', 'pages', 'app', 'features', 'modules', 'services',
  // Horizontal layers (types, config, state)
  'types', 'config', 'configs', 'constants', 'store', 'stores',
  'contexts', 'providers', 'middleware', 'models',
  // Testing
  'tests', '__tests__', 'testing', 'mocks', 'fixtures', 'setup',
  // Clean Architecture / DDD layers
  'adapters', 'interfaces', 'entities', 'repositories', 'use-cases',
  'slices', 'queries', 'columns',
]);

/**
 * Domains inferred from file path: first non-structural segment(s).
 * e.g. "src/auth/session-manager.ts" → ["auth"], "shared/oauth/client.ts" → ["oauth"]
 */
export function getPathBasedDomains(relativeFilePath: string): string[] {
  const withoutExt = relativeFilePath.replace(/\.(tsx?|jsx?|mts|cts)$/i, '');
  const segments = withoutExt.split(/[/\\]/).filter(Boolean);
  const domains: string[] = [];
  for (const seg of segments) {
    const lower = seg.toLowerCase();
    if (STRUCTURAL_DIRS.has(lower)) continue;
    const slug = lower.replace(/[^a-z0-9-]/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '') || seg;
    if (slug && !domains.includes(slug)) domains.push(slug);
  }
  return domains;
}

/**
 * Build undirected adjacency for modules: modId -> Set of neighbor modIds (imports in either direction).
 */
function getImportNeighbors(graph: SemanticGraph): Map<string, Set<string>> {
  const neighbors = new Map<string, Set<string>>();
  for (const edge of graph.edges) {
    if (edge.kind !== 'imports') continue;
    const a = edge.from;
    const b = edge.to;
    let setA = neighbors.get(a);
    if (!setA) { setA = new Set(); neighbors.set(a, setA); }
    setA.add(b);
    let setB = neighbors.get(b);
    if (!setB) { setB = new Set(); neighbors.set(b, setB); }
    setB.add(a);
  }
  return neighbors;
}

/**
 * Label propagation: each node gets the most frequent label among neighbors.
 * Returns stable label per node (cluster id).
 * When counts tie, the lexicographically smallest label is chosen so the result is deterministic.
 */
function labelPropagation(
  modIds: string[],
  neighbors: Map<string, Set<string>>,
  maxIterations: number = 10,
): Map<string, string> {
  const sortedIds = [...modIds].sort((a, b) => a.localeCompare(b));
  const label = new Map<string, string>();
  for (const id of sortedIds) label.set(id, id);
  for (let iter = 0; iter < maxIterations; iter++) {
    let changed = false;
    for (const id of sortedIds) {
      const nb = neighbors.get(id);
      if (!nb || nb.size === 0) continue;
      const counts = new Map<string, number>();
      const currentLabel = label.get(id) ?? id;
      counts.set(currentLabel, (counts.get(currentLabel) ?? 0) + 1);
      for (const n of nb) {
        const l = label.get(n) ?? n;
        counts.set(l, (counts.get(l) ?? 0) + 1);
      }
      let best = label.get(id) ?? id;
      let bestCount = 0;
      for (const [l, c] of counts) {
        if (c > bestCount || (c === bestCount && l < best)) {
          bestCount = c;
          best = l;
        }
      }
      if (best !== label.get(id)) {
        label.set(id, best);
        changed = true;
      }
    }
    if (!changed) break;
  }
  return label;
}

/**
 * Name a cluster by the most common non-structural path segment among its modules.
 */
function nameCluster(
  modIds: string[],
  modulesById: Map<string, ModuleInfo>,
): string {
  const segmentCounts = new Map<string, number>();
  for (const modId of modIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;
    const pathDomains = getPathBasedDomains(mod.relativeFilePath);
    for (const d of pathDomains) {
      segmentCounts.set(d, (segmentCounts.get(d) ?? 0) + 1);
    }
  }
  let best = 'cluster';
  let bestCount = 0;
  for (const [seg, c] of segmentCounts) {
    if (c > bestCount) { bestCount = c; best = seg; }
  }
  return best;
}

/**
 * Cluster modules by import graph (label propagation), then assign each cluster a domain name from path segments.
 */
export function getClusterDomains(
  graph: SemanticGraph,
  snapshot: SyntacticSnapshot,
  modulesById: Map<string, ModuleInfo>,
): Map<string, string> {
  const modIds = snapshot.modules.map(m => m.id);
  const neighbors = getImportNeighbors(graph);
  const label = labelPropagation(modIds, neighbors);

  const clusterToMods = new Map<string, string[]>();
  for (const [modId, clusterLabel] of label) {
    const list = clusterToMods.get(clusterLabel) ?? [];
    list.push(modId);
    clusterToMods.set(clusterLabel, list);
  }

  const modToDomain = new Map<string, string>();
  for (const [, modIdsInCluster] of clusterToMods) {
    const domainName = nameCluster(modIdsInCluster, modulesById);
    for (const id of modIdsInCluster) {
      modToDomain.set(id, domainName);
    }
  }
  return modToDomain;
}

export interface DomainsConfig {
  patterns?: Array<{ pattern: string; domain: string }>;
  /** Canonical domain -> list of aliases. Queries by alias resolve to the canonical (e.g. "kubernetes" -> "infra-k8s"). */
  domainAliases?: Record<string, string[]>;
  /**
   * Repo-root-relative path substrings; matching IaC files are skipped (e.g. root `template.yaml` when using nested stacks only).
   */
  infraExclude?: string[];
  /**
   * Repo-root-relative paths to bundle scripts (`bundle.js` style: `entryPoint` + `outputFile` array).
   * If omitted, `packages/lambda-functions/scripts/bundle.js` is tried when present. Use `[]` to disable.
   */
  lambdaBundleScripts?: string[];
  /** Precomputed alias (lowercase) -> canonical; set by loadDomainsConfig for O(1) resolve. */
  _aliasToCanonical?: Record<string, string>;
}

/**
 * Load optional domains config from repo. Tries:
 * - repo-context/domains.config.json
 * - .repo-context-domains.json (repo root)
 */
export function loadDomainsConfig(repoRoot: string): DomainsConfig | null {
  const candidates = [
    path.join(repoRoot, SELF_TSCONFIG_REL, 'domains.config.json'),
    path.join(repoRoot, '.repo-context-domains.json'),
  ];
  for (const file of candidates) {
    try {
      if (fs.existsSync(file)) {
        const raw = JSON.parse(fs.readFileSync(file, 'utf-8'));
        if (raw && (Array.isArray(raw.patterns) || raw.patterns === undefined)) {
          const config = raw as DomainsConfig;
          if (config.domainAliases && typeof config.domainAliases === 'object') {
            const map: Record<string, string> = {};
            for (const [canonical, aliases] of Object.entries(config.domainAliases)) {
              if (!Array.isArray(aliases)) continue;
              map[canonical.toLowerCase()] = canonical;
              for (const a of aliases) map[String(a).toLowerCase()] = canonical;
            }
            config._aliasToCanonical = map;
          }
          return config;
        }
      }
    } catch {
      // skip invalid or missing
    }
  }
  return null;
}

/**
 * Resolve a domain name or alias to the canonical domain label used in the graph.
 * E.g. "kubernetes" or "k8s" -> "infra-k8s" when domainAliases["infra-k8s"] includes them.
 */
export function resolveDomainToCanonical(input: string, config: DomainsConfig | null): string {
  if (!input || !config) return input;
  const normalized = input.startsWith('domain:') ? input.slice(7) : input;
  const canonical = config._aliasToCanonical?.[normalized.toLowerCase()];
  if (canonical !== undefined) return canonical;
  return input;
}

/**
 * Apply config patterns to relative path; returns matching domain labels.
 */
export function getConfigPatternDomains(
  relativeFilePath: string,
  config: DomainsConfig,
): string[] {
  const domains: string[] = [];
  const text = relativeFilePath.toLowerCase();
  for (const { pattern, domain } of config.patterns ?? []) {
    try {
      const re = new RegExp(pattern, 'i');
      if (re.test(text) && !domains.includes(domain)) {
        domains.push(domain);
      }
    } catch {
      // invalid regex, skip
    }
  }
  return domains;
}

/**
 * Collect all (modId, domainLabel) from path-based, cluster-based, and optional config.
 * Returns Map: modId -> Set of domain labels (deduplicated).
 */
export function collectAllDomainTags(
  snapshot: SyntacticSnapshot,
  graph: SemanticGraph,
  repoRoot: string,
  modulesById?: Map<string, ModuleInfo>,
): Map<string, Set<string>> {
  const modToDomains = new Map<string, Set<string>>();
  const modsMap = modulesById ?? new Map(snapshot.modules.map(m => [m.id, m]));

  function add(modId: string, domain: string): void {
    let set = modToDomains.get(modId);
    if (!set) { set = new Set(); modToDomains.set(modId, set); }
    set.add(domain);
  }

  for (const mod of snapshot.modules) {
    for (const d of getPathBasedDomains(mod.relativeFilePath)) {
      add(mod.id, d);
    }
  }

  const clusterDomains = getClusterDomains(graph, snapshot, modsMap);
  for (const [modId, domain] of clusterDomains) {
    add(modId, domain);
  }

  const config = loadDomainsConfig(repoRoot);
  if (config?.patterns?.length) {
    for (const mod of snapshot.modules) {
      for (const d of getConfigPatternDomains(mod.relativeFilePath, config)) {
        add(mod.id, d);
      }
    }
  }

  return modToDomains;
}
