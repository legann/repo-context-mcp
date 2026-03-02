import { z, toJSONSchema } from 'zod';

export interface ToolDef {
  name: string;
  description: string;
  schema: z.ZodObject<Record<string, z.ZodType>>;
}

export const toolDefs: ToolDef[] = [
  {
    name: 'get_context_detail',
    description:
      'Get context detail for a node. ' +
      'For modules: returns drill_down[] with every export — each entry has { id, label, type, symbolKind, signature, typeValue?, lineRange?: {start,end} }. ' +
      'lineRange gives exact file line numbers for targeted reading. ' +
      'For capabilities: returns full symbol detail (signature, params[], returnType, lineRange). ' +
      'Pass includeBody: true to get source code of capability (function/class body) or module (full file) inline — avoids separate file reads. ' +
      'Pass grepBody: "pattern" to search inside file body — returns matching lines with context, much cheaper than full body for large files. ' +
      'Pass includePrivate: true for class capabilities to include private/protected methods in drill_down. ' +
      'Pass includeInternals: true for large function capabilities (200+ lines) to include internal declarations (nested functions, variables, destructuring) with lineRange in drill_down. ' +
      'Node IDs are auto-normalized: /index suffix and .ts/.tsx extensions are stripped.',
    schema: z.object({
      nodeId: z.string().describe('Node id (e.g. mod:package-name/src/path/to/module). /index and .ts/.tsx are auto-stripped.'),
      includeBody: z.boolean().optional().describe('If true, includes source code body for capability nodes (by lineRange) or module file content. Default: false.'),
      bodyOffset: z.number().int().min(0).optional().describe('Character offset to start body from (default 0). Use with includeBody for paginating large files.'),
      bodyLimit: z.number().int().min(1).max(500_000).optional().describe('Max body chars to return (default 30000). Use smaller values for targeted reads.'),
      grepBody: z.string().optional().describe('Regex pattern to search inside file body. Returns matching lines with ±3 lines context. Much cheaper than includeBody for large files.'),
      includePrivate: z.boolean().optional().describe('If true and node is a class capability, includes private/protected methods in drill_down. Default: false.'),
      includeInternals: z.boolean().optional().describe('If true and node is a function capability (200+ lines), includes internal declarations (nested functions, variables, destructuring) with lineRange in drill_down. Default: false.'),
    }),
  },
  {
    name: 'get_path_from_root',
    description:
      'Get full hierarchy path from repo root to a focus node. ' +
      'Returns an array of node views, one per level (root → pkg → mod → cap), ending with the target node.',
    schema: z.object({
      focusId: z.string().describe('Target node id. /index and .ts/.tsx are auto-stripped.'),
    }),
  },
  {
    name: 'get_domain_or_focus_context',
    description:
      'Get architectural context for a domain or node. ' +
      'For domains: returns { domain, label, moduleCount, modules: [{ id, label, exports, links }] }. ' +
      'For node ids: falls back to path-from-root.',
    schema: z.object({
      domainOrNodeId: z.string().describe('Domain name (e.g. "auth") or node id'),
    }),
  },
  {
    name: 'search_repo_context',
    description:
      'Search for nodes by name, id substring, or type. Multi-word queries (e.g. "Platform OAuth") are tokenized: all tokens must match somewhere in node id, label, or (for capabilities) signature/typeValue/implementsInterfaces. ' +
      'Returns { query, results: [{ id, label, type, score, children, links }] } sorted by relevance. ' +
      'Query is auto-normalized: /index and .ts/.tsx are stripped.',
    schema: z.object({
      query: z.string().describe('Search query (name, id fragment, or type)'),
      maxResults: z.number().int().min(1).max(200).optional().describe('Max results (default 10)'),
    }),
  },
  {
    name: 'get_dependency_impact',
    description:
      'Analyze what a change to a node would affect. ' +
      'Returns { nodeId, label, downstream: [{ id, label, type, uses? }], upstream: [{ id, label, type, uses? }] }. ' +
      'downstream = who depends on this node, upstream = what this node depends on. ' +
      'uses[] shows exactly which named exports are imported. ' +
      'Pass exportName to filter downstream to only consumers that import a specific export. ' +
      'Pass maxDepth to limit traversal depth (default: unlimited; use 3-5 for focused analysis).',
    schema: z.object({
      nodeId: z.string().describe('Node to analyze impact for'),
      exportName: z.string().optional().describe('If provided, filters downstream to only modules that import this specific export name. Default: show all.'),
      maxDepth: z.number().int().min(1).max(50).optional().describe('Max traversal depth (default: unlimited). Use 3-5 for focused analysis.'),
    }),
  },
  {
    name: 'get_domain_modules_slice',
    description:
      'Get all modules tagged with a domain/feature, plus their direct import dependencies, grouped by package. ' +
      'Returns { domain, taggedModules, totalWithDeps, byPackage: { "pkg:name": [{ id, label }] } }. ' +
      'Pass includeConsumers: true to also include modules that import FROM domain modules (reverse dependencies).',
    schema: z.object({
      domainTag: z.string().describe('Domain tag (e.g. "auth", "formula", "dashboard")'),
      includeConsumers: z.boolean().optional().describe('If true, includes modules that import from domain-tagged modules (reverse deps). Default: false.'),
    }),
  },
  {
    name: 'get_env_vars_usage',
    description:
      'Get a map of environment variables used across the project or within a specific package. ' +
      'Returns { envVars: { "VAR_NAME": [{ moduleId, moduleLabel }] } } — each var mapped to all modules that reference it. ' +
      'Useful for understanding config patterns before adding new env vars.',
    schema: z.object({
      packageId: z.string().optional().describe('Optional package id (e.g. "pkg:package-name") to scope results. Omit for all packages.'),
    }),
  },
  {
    name: 'get_routes_map',
    description:
      'Extract frontend route definitions from modules tagged with domain:routing. ' +
      'Returns { routes: [{ path, component, moduleId }] } parsed from <Route path="..." element={<Component/>} /> JSX patterns. ' +
      'Also returns conditionalRenders — components rendered outside <Route> via if/ternary/&& patterns (e.g. guest views).',
    schema: z.object({
      layer: z.enum(['frontend', 'lambda']).optional().describe('"frontend" for SPA routes, "lambda" for API endpoints, omit for both'),
    }),
  },
  {
    name: 'get_interface_implementations',
    description:
      'Find all classes that implement a given interface. ' +
      'Returns { interface, implementations: [{ classId, className, moduleId, moduleLabel, methods?, lineRange }] }. ' +
      'Use to discover implementation patterns (e.g. all PlatformOAuthAdapter implementations).',
    schema: z.object({
      interfaceName: z.string().describe('Interface name (e.g. "PlatformOAuthAdapter")'),
    }),
  },
  {
    name: 'get_export_callees',
    description:
      'Get the shallow call graph for an exported function or class. ' +
      'Returns { calls: string[] } — function/method names called within the body (1 level deep). ' +
      'Format: "functionName", "object.method", "this.method". Filters out common stdlib calls. ' +
      'Only available for exports <= 500 lines.',
    schema: z.object({
      nodeId: z.string().describe('Capability node id (e.g. "cap:package-name/path/to/module/ExportName")'),
    }),
  },
  {
    name: 'get_modules_annotation_queue',
    description:
      'Get a prioritized queue of modules that need semantic annotation. ' +
      'Returns modules ordered by priority: stale (content changed) first, then unannotated, sorted by downstream impact. ' +
      'Each item includes context (top exports, signatures) so the annotator can often write annotations without reading full body. ' +
      'Use with write_module_annotation to build the semantic layer.',
    schema: z.object({
      domain: z.string().optional().describe('Filter by domain (e.g. auth, config, ui). Do not use "repo-context" — that package is excluded from the graph. Omit for global queue.'),
      limit: z.number().int().min(1).max(100).optional().describe('Max items to return (default 10)'),
    }),
  },
  {
    name: 'write_module_annotation',
    description:
      'Write a semantic annotation for a graph node (module, capability, or domain). ' +
      'Served via get_context_detail. ' +
      'Schema: { summary (required), keyExports?, assumptions?, sideEffects?, risks?, patterns?, flowDescription?, invariants?, extensionPoints? }.',
    schema: z.object({
      nodeId: z.string().describe('Node id (e.g. mod:package-name/src/path/to/module)'),
      semantic: z.record(z.string(), z.unknown()).describe('Semantic annotation object. Must include "summary" (string). Optional: keyExports (Record<string,string>), assumptions (string[]), sideEffects (string[]), risks (string[]), patterns (string[]), flowDescription (string), invariants (string[]), extensionPoints (string[]).'),
    }),
  },
  {
    name: 'get_annotation_coverage_stats',
    description:
      'Get annotation coverage statistics: total modules, annotated, fresh, stale, unannotated, breakdown by domain. ' +
      'Use to understand how much of the codebase has semantic annotations.',
    schema: z.object({}),
  },
  {
    name: 'refresh_repo_context',
    description:
      'Rebuild the repo context from scratch. Use after code changes to get fresh context. Takes ~16 seconds. ' +
      'Returns { status, builtAt, before: { nodes, edges }, after: { nodes, edges } }.',
    schema: z.object({}),
  },
];

const toolDefsByName = new Map(toolDefs.map(d => [d.name, d]));

export function getToolDef(name: string): ToolDef | undefined {
  return toolDefsByName.get(name);
}

/** Convert Zod schema → JSON Schema (for HTTP tools/list). */
export function toHttpToolSchema(def: ToolDef): object {
  return {
    name: def.name,
    description: def.description,
    inputSchema: toJSONSchema(def.schema),
  };
}

/** Extract required argument names from a Zod schema. */
export function getRequiredArgs(def: ToolDef): string[] {
  const shape = def.schema.shape;
  const required: string[] = [];
  for (const [key, fieldSchema] of Object.entries(shape)) {
    if (!fieldSchema.isOptional()) {
      required.push(key);
    }
  }
  return required;
}
