import type {
  SyntacticSnapshot,
  SemanticGraph,
  ExportInfo,
  ModuleInfo,
  InfraResource,
  DomainTier,
} from '../types.js';
import { createEmptyGraph, addNode, addEdge } from '../graph/index.js';
import { collectAllDomainTags, STRUCTURAL_DIRS } from './domains.js';

const STRUCTURAL_DIRS_REF = STRUCTURAL_DIRS;

export function buildSemanticGraph(
  snapshot: SyntacticSnapshot,
  modulesById?: Map<string, ModuleInfo>,
): SemanticGraph {
  const graph = createEmptyGraph();
  const modsMap = modulesById ?? new Map(snapshot.modules.map(m => [m.id, m]));

  pass1Packages(graph, snapshot);
  pass2Modules(graph, snapshot);
  pass2Infra(graph, snapshot, modsMap);
  pass3Capabilities(graph, snapshot);
  pass4Domains(graph, snapshot, modsMap);
  pass5ContentDomains(graph, snapshot);
  pass5PropagateInfraDomains(graph);
  pass6ClassifyDomains(graph);
  pass7Subdomains(graph, modsMap);
  logDomains(graph);
  // Node view fields are computed on-demand by buildNodeView

  return graph;
}

function logDomains(graph: SemanticGraph): void {
  const domainIds = graph.byType.get('domain');
  if (!domainIds?.size) return;
  const list = Array.from(domainIds)
    .map(id => {
      const node = graph.nodes.get(id);
      if (!node) return null;
      const tagged = graph.inEdges.get(id)?.filter(e => e.kind === 'tagged').length ?? 0;
      return { label: node.label, tagged };
    })
    .filter((x): x is { label: string; tagged: number } => x !== null)
    .sort((a, b) => b.tagged - a.tagged);
  if (process.env.REPO_CONTEXT_VERBOSE) {
    console.log(`  Domains (${list.length}): ${list.map(d => `${d.label}(${d.tagged})`).join(', ')}`);
  } else {
    console.log(`  Domains: ${list.length}`);
  }
}

// ── Pass 1: Root + packages ──

function pass1Packages(graph: SemanticGraph, snapshot: SyntacticSnapshot): void {
  addNode(graph, {
    id: 'root',
    type: 'root',
    label: 'Repository',
    description: `Root of ${snapshot.packages.length} packages`,
  });

  for (const pkg of snapshot.packages) {
    const pkgId = `pkg:${pkg.name}`;
    addNode(graph, {
      id: pkgId,
      type: 'package',
      label: pkg.name,
      description: `Package ${pkg.name} (${pkg.path})`,
      data: { path: pkg.path, version: pkg.version },
    });
    addEdge(graph, 'root', pkgId, 'contains');
  }
}

// ── Pass 2: Modules + imports ──

function pass2Modules(graph: SemanticGraph, snapshot: SyntacticSnapshot): void {
  for (const mod of snapshot.modules) {
    addNode(graph, {
      id: mod.id,
      type: 'module',
      label: shortModuleLabel(mod.relativeFilePath),
      description: `Module ${mod.relativeFilePath} in ${mod.packageName}`,
      data: {
        filePath: mod.filePath,
        relativeFilePath: mod.relativeFilePath,
        hasRoutes: mod.contentHints?.hasRoutes ?? undefined,
        envVars: mod.contentHints?.envVars,
      },
    });

    const pkgId = `pkg:${mod.packageName}`;
    if (graph.nodes.has(pkgId)) {
      addEdge(graph, pkgId, mod.id, 'contains');
    }
  }

  // Import edges (only for module-level resolved imports)
  for (const mod of snapshot.modules) {
    const seen = new Set<string>();
    for (const imp of mod.imports) {
      if (imp.isExternal || !imp.resolvedModuleId) continue;
      if (imp.resolvedModuleId.startsWith('pkg:')) continue;
      if (seen.has(imp.resolvedModuleId)) continue;
      if (imp.resolvedModuleId === mod.id) continue;

      seen.add(imp.resolvedModuleId);
      if (graph.nodes.has(imp.resolvedModuleId)) {
        addEdge(graph, mod.id, imp.resolvedModuleId, 'imports');
      }
    }
  }
}

/**
 * Resolve SAM Lambda Handler (e.g. "formula-manager.handler") to a TS module id.
 * Assumes handlers live in a package whose path contains "lambda-functions".
 */
function resolveHandlerToModuleId(
  handler: string,
  snapshot: SyntacticSnapshot,
  modulesById: Map<string, ModuleInfo>,
): string | undefined {
  const parts = handler.split('.');
  if (parts.length < 2) return undefined;
  const pathPart = parts[0];
  const lambdaPkg = snapshot.packages.find(p => p.path.includes('lambda-functions'));
  if (!lambdaPkg) return undefined;
  const candidates = [
    `mod:${lambdaPkg.name}/src/${pathPart}`,
    `mod:${lambdaPkg.name}/src/${pathPart}/index`,
  ];
  for (const id of candidates) {
    if (modulesById.has(id)) return id;
  }
  for (const mod of snapshot.modules) {
    if (mod.packageName !== lambdaPkg.name) continue;
    const base = mod.relativeFilePath.replace(/\.(tsx?|jsx?)$/, '').replace(/\/index$/, '');
    if (base === `src/${pathPart}` || base.endsWith(`/src/${pathPart}`)) return mod.id;
  }
  return undefined;
}

function pass2Infra(
  graph: SemanticGraph,
  snapshot: SyntacticSnapshot,
  modulesById: Map<string, ModuleInfo>,
): void {
  const infraModules = snapshot.infraModules ?? [];
  if (infraModules.length === 0) return;

  const domainMeta: Record<string, { label: string; description: string }> = {
    'domain:infra-sam': { label: 'infra-sam', description: 'Domain: infra-sam (IaC SAM/CloudFormation)' },
    'domain:infra-dockerfile': { label: 'infra-dockerfile', description: 'Domain: infra-dockerfile (Dockerfiles)' },
    'domain:infra-helm': { label: 'infra-helm', description: 'Domain: infra-helm (Helm charts)' },
    'domain:infra-k8s': { label: 'infra-k8s', description: 'Domain: infra-k8s (Kubernetes / k3d manifests)' },
  };
  for (const [id, meta] of Object.entries(domainMeta)) {
    if (!graph.nodes.has(id)) {
      addNode(graph, { id, type: 'domain', label: meta.label, description: meta.description });
    }
  }

  function domainForKind(kind: string): string {
    switch (kind) {
      case 'dockerfile': return 'domain:infra-dockerfile';
      case 'helm': return 'domain:infra-helm';
      case 'kubernetes': return 'domain:infra-k8s';
      default: return 'domain:infra-sam';
    }
  }

  for (const infraMod of infraModules) {
    const infraModuleId = infraMod.id;
    const domainId = domainForKind(infraMod.kind);
    addNode(graph, {
      id: infraModuleId,
      type: 'module',
      label: shortModuleLabel(infraMod.relativeFilePath),
      description: `IaC ${infraMod.kind} module ${infraMod.relativeFilePath}`,
      data: {
        filePath: infraMod.filePath,
        relativeFilePath: infraMod.relativeFilePath,
      },
    });

    addEdge(graph, 'root', infraModuleId, 'contains');
    addEdge(graph, infraModuleId, domainId, 'tagged');

    for (const res of infraMod.resources) {
      const serviceId = makeServiceId(res);
      addNode(graph, {
        id: serviceId,
        type: 'service',
        label: res.id,
        description: `${res.kind} declared in ${infraMod.relativeFilePath}`,
        data: {
          handler: res.attributes.handler,
          envVars: res.envVars,
          triggers: res.triggers,
          envRefs: res.envRefs,
        },
      });
      addEdge(graph, infraModuleId, serviceId, 'contains');
      addEdge(graph, serviceId, domainId, 'tagged');

      if (res.kind === 'lambda' && res.attributes.handler) {
        const modId = resolveHandlerToModuleId(res.attributes.handler, snapshot, modulesById);
        if (modId && graph.nodes.has(modId)) {
          addEdge(graph, serviceId, modId, 'infra');
        }
      }

      if (res.triggers) {
        for (const trigger of res.triggers) {
          if (trigger.type === 'sqs' && trigger.queueRef) {
            const queueServiceId = findServiceIdByLogicalId(graph, trigger.queueRef);
            if (queueServiceId) {
              addEdge(graph, queueServiceId, serviceId, 'consumes');
            }
          }
        }
      }

      if (res.envRefs) {
        for (const envRef of res.envRefs) {
          if (envRef.targetLogicalId) {
            const targetServiceId = findServiceIdByLogicalId(graph, envRef.targetLogicalId);
            if (targetServiceId) {
              addEdge(graph, serviceId, targetServiceId, 'uses_env');
            }
          }
        }
      }
    }
  }
}

/**
 * Propagate domain tags from code modules to infra services linked by edge 'infra'.
 * So domain "formula-manager" includes both the TS module and the Lambda → one unified graph.
 */
function pass5PropagateInfraDomains(graph: SemanticGraph): void {
  const serviceSet = graph.byType.get('service');
  const serviceIds = serviceSet ? Array.from(serviceSet) : [];
  for (const serviceId of serviceIds) {
    const outEdges = graph.outEdges.get(serviceId) ?? [];
    const infraTargets = outEdges.filter(e => e.kind === 'infra').map(e => e.to);
    const seenDomain = new Set<string>();
    for (const modId of infraTargets) {
      const modOut = graph.outEdges.get(modId) ?? [];
      for (const e of modOut) {
        if (e.kind === 'tagged' && !seenDomain.has(e.to)) {
          seenDomain.add(e.to);
          addEdge(graph, serviceId, e.to, 'tagged');
        }
      }
    }
  }
}

// ── Pass 3: Capabilities (exports with symbol detail) ──

function pass3Capabilities(graph: SemanticGraph, snapshot: SyntacticSnapshot): void {
  for (const mod of snapshot.modules) {
    for (const exp of mod.exports) {
      if (shouldSkipExport(exp)) continue;

      const capId = `cap:${mod.id.slice(4)}/${exp.name}`;
      addNode(graph, {
        id: capId,
        type: 'capability',
        label: exp.name,
        description: capDescription(exp),
        data: {
          symbolKind: exp.kind,
          signature: exp.signature,
          params: exp.params,
          returnType: exp.returnType,
          typeValue: exp.typeValue,
          fields: exp.fields,
          implementsInterfaces: exp.implementsInterfaces,
          calls: exp.calls,
          privateMembers: exp.privateMembers,
          internals: exp.internals,
          lineRange: exp.lineRange,
          isDefault: exp.isDefault,
        },
      });
      addEdge(graph, mod.id, capId, 'contains');
    }
  }
}

function shouldSkipExport(exp: ExportInfo): boolean {
  if (exp.name === 'default' && !exp.signature) return true;
  return false;
}

function capDescription(exp: ExportInfo): string {
  if (exp.signature) return `${exp.kind} ${exp.name}: ${exp.signature}`;
  return `${exp.kind} ${exp.name}`;
}

// ── Pass 4: Domains (path-based + import clustering + optional config) ──

function pass4Domains(graph: SemanticGraph, snapshot: SyntacticSnapshot, modulesById: Map<string, ModuleInfo>): void {
  const modToDomains = collectAllDomainTags(snapshot, graph, snapshot.repoRoot, modulesById);
  const seenEdge = new Set<string>();

  for (const [modId, domains] of modToDomains) {
    for (const domainLabel of domains) {
      const domainId = `domain:${domainLabel}`;
      const edgeKey = `${modId}\t${domainId}`;
      if (seenEdge.has(edgeKey)) continue;
      seenEdge.add(edgeKey);

      if (!graph.nodes.has(domainId)) {
        addNode(graph, {
          id: domainId,
          type: 'domain',
          label: domainLabel,
          description: `Domain: ${domainLabel}`,
        });
      }
      addEdge(graph, modId, domainId, 'tagged');
    }
  }
}

// ── Pass 5: Content-based domains (routing, config) ──

function hasTaggedEdge(graph: SemanticGraph, fromId: string, domainId: string): boolean {
  const out = graph.outEdges.get(fromId) ?? [];
  return out.some(e => e.kind === 'tagged' && e.to === domainId);
}

function pass5ContentDomains(graph: SemanticGraph, snapshot: SyntacticSnapshot): void {
  let routingCreated = false;
  let configCreated = false;

  for (const mod of snapshot.modules) {
    if (!mod.contentHints) continue;

    if (mod.contentHints.hasRoutes) {
      if (!routingCreated) {
        addNode(graph, {
          id: 'domain:routing',
          type: 'domain',
          label: 'routing',
          description: 'Domain: routing (modules containing <Route> definitions)',
        });
        routingCreated = true;
      }
      if (!hasTaggedEdge(graph, mod.id, 'domain:routing')) {
        addEdge(graph, mod.id, 'domain:routing', 'tagged');
      }
    }

    if (mod.contentHints.envVars && mod.contentHints.envVars.length > 0) {
      if (!configCreated) {
        addNode(graph, {
          id: 'domain:config',
          type: 'domain',
          label: 'config',
          description: 'Domain: config (modules referencing environment variables)',
        });
        configCreated = true;
      }
      if (!hasTaggedEdge(graph, mod.id, 'domain:config')) {
        addEdge(graph, mod.id, 'domain:config', 'tagged');
      }
    }
  }
}

// ── Pass 7: Subdomains for large domains ──

const SUBDOMAIN_MIN_MODULES = 10;
const SUBDOMAIN_MIN_CLUSTER = 3;

function pass7Subdomains(graph: SemanticGraph, modulesById: Map<string, ModuleInfo>): void {
  const domainIds = graph.byType.get('domain');
  if (!domainIds?.size) return;

  const domainSnapshot = Array.from(domainIds);
  for (const domainId of domainSnapshot) {
    const node = graph.nodes.get(domainId);
    if (!node || node.type !== 'domain') continue;
    const tier = node.data?.tier;
    if (tier !== 'business' && tier !== 'feature') continue;
    if (node.data?.parent) continue;

    const incoming = graph.inEdges.get(domainId) ?? [];
    const taggedModIds = incoming
      .filter(e => e.kind === 'tagged')
      .map(e => e.from)
      .filter(id => {
        const n = graph.nodes.get(id);
        return n?.type === 'module';
      });

    if (taggedModIds.length < SUBDOMAIN_MIN_MODULES) continue;

    const clusters = clusterByPathPrefix(taggedModIds, modulesById, node.label);

    const subdomains: string[] = [];
    for (const [subLabel, modIds] of clusters) {
      if (modIds.length < SUBDOMAIN_MIN_CLUSTER) continue;
      if (subLabel === node.label) continue;

      const subdomainId = `domain:${node.label}/${subLabel}`;
      if (graph.nodes.has(subdomainId)) continue;

      addNode(graph, {
        id: subdomainId,
        type: 'domain',
        label: `${node.label}/${subLabel}`,
        description: `Subdomain: ${node.label}/${subLabel} (${modIds.length} modules)`,
        data: { tier: 'feature', parent: domainId },
      });
      addEdge(graph, subdomainId, domainId, 'tagged');
      subdomains.push(subdomainId);

      for (const modId of modIds) {
        addEdge(graph, modId, subdomainId, 'tagged');
      }
    }

    if (subdomains.length > 0) {
      node.data = { ...node.data, subdomains };
    }
  }
}

function clusterByPathPrefix(
  modIds: string[],
  modulesById: Map<string, ModuleInfo>,
  domainLabel: string,
): Map<string, string[]> {
  const segmentCounts = new Map<string, string[]>();

  for (const modId of modIds) {
    const mod = modulesById.get(modId);
    if (!mod) continue;

    const rel = mod.relativeFilePath.replace(/\.(tsx?|jsx?)$/, '');
    const parts = rel.split('/');

    const domainIdx = parts.findIndex(p => p.toLowerCase() === domainLabel);
    const afterDomain = domainIdx >= 0 ? parts.slice(domainIdx + 1) : parts;

    const meaningful = afterDomain.filter(
      p => !STRUCTURAL_DIRS_REF.has(p.toLowerCase()) && p !== 'index',
    );

    const subKey = meaningful.length > 0 ? meaningful[0].toLowerCase() : domainLabel;
    let list = segmentCounts.get(subKey);
    if (!list) { list = []; segmentCounts.set(subKey, list); }
    list.push(modId);
  }

  return segmentCounts;
}

// ── Pass 6: Classify domain tiers ──

const LAYER_NAMES = new Set([
  'types', 'utils', 'config', 'configs', 'constants',
  'index', 'hooks', 'testing', 'tests', 'store', 'stores',
  'models', 'interfaces', 'entities', 'contexts', 'providers',
  'routing',
]);

function classifyDomainTier(domainId: string, graph: SemanticGraph): DomainTier {
  const node = graph.nodes.get(domainId);
  if (!node || node.type !== 'domain') return 'technical';

  if (LAYER_NAMES.has(node.label)) return 'layer';

  const incoming = graph.inEdges.get(domainId) ?? [];
  const taggedModuleIds = incoming.filter(e => e.kind === 'tagged').map(e => e.from);
  const modules = taggedModuleIds.filter(id => {
    const n = graph.nodes.get(id);
    return n?.type === 'module' || n?.type === 'service';
  });

  const packages = new Set<string>();
  for (const modId of modules) {
    const containsEdge = (graph.inEdges.get(modId) ?? []).find(
      e => e.kind === 'contains' && e.from.startsWith('pkg:'),
    );
    if (containsEdge) packages.add(containsEdge.from);
  }

  if (modules.length >= 5 && packages.size >= 2) return 'business';
  if (modules.length >= 3 || (modules.length >= 2 && packages.size >= 2)) return 'feature';
  return 'technical';
}

function pass6ClassifyDomains(graph: SemanticGraph): void {
  const domainIds = graph.byType.get('domain');
  if (!domainIds?.size) return;

  for (const domainId of domainIds) {
    const node = graph.nodes.get(domainId);
    if (!node || node.type !== 'domain') continue;
    const tier = classifyDomainTier(domainId, graph);
    node.data = { ...node.data, tier };
  }
}

// ── Helpers ──

function shortModuleLabel(relPath: string): string {
  const parts = relPath.replace(/\.(tsx?|jsx?)$/, '').split('/');
  if (parts.length <= 2) return parts.join('/');
  return `…/${parts.slice(-2).join('/')}`;
}

function findServiceIdByLogicalId(graph: SemanticGraph, logicalId: string): string | undefined {
  const serviceSet = graph.byType.get('service');
  if (!serviceSet) return undefined;
  for (const id of serviceSet) {
    const node = graph.nodes.get(id);
    if (node?.label === logicalId) return id;
  }
  return undefined;
}

function makeServiceId(res: InfraResource): string {
  const base = res.id;
  if (res.provider === 'aws') {
    if (res.kind === 'lambda') return `service:aws-lambda:${base}`;
    if (res.kind === 'queue') return `service:aws-sqs:${base}`;
    if (res.kind === 'topic') return `service:aws-sns:${base}`;
    if (res.kind === 'table') return `service:aws-dynamodb:${base}`;
    if (res.kind === 'api') return `service:aws-api:${base}`;
    if (res.kind === 'bucket') return `service:aws-s3:${base}`;
  }
  if (res.provider === 'k8s') {
    if (res.kind === 'k8s-deployment') return `service:k8s-deployment:${base}`;
    if (res.kind === 'k8s-service') return `service:k8s-service:${base}`;
  }
  return `service:${res.provider}:${base}`;
}
