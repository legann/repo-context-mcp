// ── Symbol & Node taxonomy ──

export type SymbolKind =
  | 'function' | 'class' | 'interface' | 'type'
  | 'const' | 'enum' | 'component' | 'unknown';

export type NodeType =
  | 'root' | 'package' | 'module' | 'capability'
  | 'service' | 'domain';

export type EdgeKind =
  | 'contains' | 'imports' | 'tagged' | 'handles'
  | 'exposes' | 'implements' | 'publishes' | 'consumes'
  | 'binds_to' | 'uses_env' | 'uses_secret' | 'infra';

// ── Stage 1: Syntactic Snapshot ──

export interface PackageInfo {
  name: string;
  path: string;
  version?: string;
  hasTsConfig: boolean;
}

export interface ParamInfo {
  name: string;
  type: string;
}

export interface FieldInfo {
  name: string;
  type: string;
  optional: boolean;
}

export interface MemberInfo {
  name: string;
  kind: 'method' | 'property';
  access: 'private' | 'protected' | 'public';
  signature?: string;
  lineRange: { start: number; end: number };
}

export interface InternalInfo {
  name: string;
  kind: 'function' | 'variable' | 'destructuring';
  signature?: string;
  lineRange: { start: number; end: number };
}

export interface ConditionalRender {
  component: string;
  condition: string;
  renderedIn: string;
  lineRange: { start: number; end: number };
}

export interface ExportInfo {
  name: string;
  kind: SymbolKind;
  signature?: string;
  params?: ParamInfo[];
  returnType?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  privateMembers?: MemberInfo[];
  internals?: InternalInfo[];
  lineRange: { start: number; end: number };
  isDefault: boolean;
}

export interface ImportInfo {
  moduleSpecifier: string;
  resolvedModuleId?: string;
  importedNames: string[];
  isTypeOnly: boolean;
  isExternal: boolean;
}

export interface ModuleInfo {
  id: string;
  packageName: string;
  filePath: string;
  relativeFilePath: string;
  contentHash: string;
  imports: ImportInfo[];
  exports: ExportInfo[];
  contentHints?: ContentHints;
}

export interface RouteInfo {
  path: string;
  component: string;
}

export interface ContentHints {
  hasRoutes?: boolean;
  routes?: RouteInfo[];
  conditionalRenders?: ConditionalRender[];
  envVars?: string[];
}

export type InfraKind =
  | 'aws-sam'
  | 'cloudformation'
  | 'kubernetes'
  | 'helm'
  | 'dockerfile';

export type InfraResourceKind =
  | 'lambda'
  | 'queue'
  | 'topic'
  | 'table'
  | 'api'
  | 'bucket'
  | 'role'
  | 'k8s-deployment'
  | 'k8s-service'
  | 'k8s-crd'
  | 'helm-release'
  | 'other';

export interface InfraTrigger {
  name: string;
  type: 'api' | 'sqs' | 'schedule' | 'websocket' | 'other';
  method?: string;
  path?: string;
  schedule?: string;
  queueRef?: string;
}

export interface InfraEnvRef {
  varName: string;
  refType: 'ref' | 'getatt' | 'sub' | 'literal';
  targetLogicalId?: string;
}

export interface InfraResource {
  id: string;
  kind: InfraResourceKind;
  provider: 'aws' | 'k8s' | 'generic';
  /** Fingerprint of this resource’s IaC fragment only (not the whole template file). Used for service annotation freshness. */
  contentHash: string;
  attributes: Record<string, string>;
  envVars?: string[];
  links?: string[];
  triggers?: InfraTrigger[];
  envRefs?: InfraEnvRef[];
}

export interface InfraModuleInfo {
  id: string;
  kind: InfraKind;
  filePath: string;
  relativeFilePath: string;
  contentHash: string;
  resources: InfraResource[];
}

export interface SyntacticSnapshot {
  repoRoot: string;
  timestamp: string;
  packages: PackageInfo[];
  modules: ModuleInfo[];
  infraModules?: InfraModuleInfo[];
  /**
   * SAM Handler path (before `.handler`) → `src/`-relative TS path without extension,
   * when esbuild output path differs from source (from configured bundle scripts).
   */
  lambdaBundleHandlerMap?: Record<string, string>;
}

// ── Stage 2: Semantic Graph ──

/** Node data per type (discriminated by GraphNode.type). */
// eslint-disable-next-line @typescript-eslint/no-empty-object-type -- discriminant for NodeDataByType
export interface RootNodeData {}

export interface PackageNodeData {
  path?: string;
  version?: string;
}

export interface ModuleNodeData {
  filePath?: string;
  relativeFilePath?: string;
  hasRoutes?: boolean;
  envVars?: string[];
}

export interface CapabilityNodeData {
  symbolKind?: SymbolKind;
  signature?: string;
  params?: ParamInfo[];
  returnType?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  privateMembers?: MemberInfo[];
  internals?: InternalInfo[];
  lineRange?: { start: number; end: number };
  isDefault?: boolean;
}

export type DomainTier = 'business' | 'feature' | 'layer' | 'technical';

export interface DomainNodeData {
  tier?: DomainTier;
  parent?: string;
  subdomains?: string[];
}

export interface ServiceNodeData {
  handler?: string;
  envVars?: string[];
  triggers?: InfraTrigger[];
  envRefs?: InfraEnvRef[];
  /** Same as InfraResource.contentHash for this service’s backing resource. */
  contentHash?: string;
}

export type NodeDataByType = {
  root: RootNodeData;
  package: PackageNodeData;
  module: ModuleNodeData;
  capability: CapabilityNodeData;
  service: ServiceNodeData;
  domain: DomainNodeData;
};

/** Discriminated union: data is typed by node type. */
export type GraphNode =
  | { id: string; type: 'root'; label: string; description: string; data?: RootNodeData }
  | { id: string; type: 'package'; label: string; description: string; data?: PackageNodeData }
  | { id: string; type: 'module'; label: string; description: string; data?: ModuleNodeData }
  | { id: string; type: 'capability'; label: string; description: string; data?: CapabilityNodeData }
  | { id: string; type: 'service'; label: string; description: string; data?: ServiceNodeData }
  | { id: string; type: 'domain'; label: string; description: string; data?: DomainNodeData };

export interface GraphEdge {
  from: string;
  to: string;
  kind: EdgeKind;
}

export interface SemanticGraph {
  nodes: Map<string, GraphNode>;
  edges: GraphEdge[];
  outEdges: Map<string, GraphEdge[]>;
  inEdges: Map<string, GraphEdge[]>;
  byType: Map<NodeType, Set<string>>;
}

// ── Node view (API response) ──

export interface NodeView {
  id: string;
  level: number;
  label: string;
  description: string;
  content?: string;
  drill_down: Array<{
    id: string;
    label: string;
    type: NodeType;
    signature?: string;
    symbolKind?: SymbolKind;
    typeValue?: string;
    fields?: FieldInfo[];
    implementsInterfaces?: string[];
    calls?: string[];
    lineRange?: { start: number; end: number };
  }>;
  links?: Array<{ targetId: string; relation: EdgeKind; label: string }>;
  // symbol detail (level 4, only for capability nodes)
  signature?: string;
  params?: ParamInfo[];
  returnType?: string;
  typeValue?: string;
  fields?: FieldInfo[];
  implementsInterfaces?: string[];
  calls?: string[];
  lineRange?: { start: number; end: number };
  symbolKind?: SymbolKind;
  // content-based enrichments (module nodes)
  envVars?: string[];
  hasRoutes?: boolean;
  // semantic annotation (AI-generated, from annotation store)
  semantic?: SemanticAnnotation;
  semanticMeta?: { pass: number; updatedAt: string; fresh: boolean };
}

/** Node view with optional MCP enrichments (body, grep, etc.) */
export interface NodeViewDetail extends NodeView {
  grepMatches?: Array<{ line: number; text: string; isMatch: boolean }>;
  grepTotalMatches?: number;
  grepError?: string;
  body?: string;
  bodyTotalChars?: number;
  bodyHasMore?: boolean;
  bodyNextOffset?: number;
  /** Set when file could not be read for includeBody or when parent module is missing. */
  bodyError?: string;
}

/** One entry in drill_down[]; may include private/internal metadata from MCP options */
export type NodeViewChild = NodeView['drill_down'][number] & {
  access?: 'private' | 'protected' | 'public';
  internal?: boolean;
  internalKind?: InternalInfo['kind'];
};

// ── Stage 3: Semantic Annotations (AI-generated) ──

/** Bump when adding new optional fields so old annotations re-enter the queue for backfill. */
export const CURRENT_ANNOTATION_SCHEMA_VERSION = 1;

export interface SemanticAnnotation {
  summary: string;
  keyExports?: Record<string, string>;
  assumptions?: string[];
  sideEffects?: string[];
  risks?: string[];
  patterns?: string[];
  flowDescription?: string;
  // domain-level only
  invariants?: string[];
  extensionPoints?: string[];
  // optional extensions (backfill via re-annotation)
  integrationPoints?: string | Record<string, string>;
  stateShape?: string | Record<string, string>;
  dataFlow?: string | Record<string, string>;
  envDependencies?: Record<string, string>;
}

export interface StoredAnnotation {
  nodeId: string;
  nodeType: 'module' | 'capability' | 'domain' | 'service';
  contentHash: string;
  pass: number;
  updatedAt: string;
  semantic: SemanticAnnotation;
  /** Schema version; if missing, treated as 1. Annotations with version < CURRENT are considered stale for queue. */
  schemaVersion?: number;
}
