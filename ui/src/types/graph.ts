/**
 * Payload shape from repo-context `extractUiGraph` (see src/mcp/ui-graph.ts).
 * Duplicated here so the viewer stays a self-contained Vite bundle.
 */
export interface UiSemanticRich {
  flowDescription?: string;
  dataFlow?: string | Record<string, string>;
  integrationPoints?: string | Record<string, string>;
  stateShape?: string | Record<string, string>;
  assumptions?: string[];
  sideEffects?: string[];
  risks?: string[];
  patterns?: string[];
  invariants?: string[];
  extensionPoints?: string[];
  keyExports?: Record<string, string>;
  envDependencies?: string | Record<string, string>;
}

export interface UiNode {
  id: string;
  label: string;
  type: string;
  description: string;
  package?: string;
  domains?: string[];
  serviceKind?: string;
  annotation?: string;
  semanticRich?: UiSemanticRich;
  meta?: Record<string, unknown>;
}

export interface UiEdge {
  source: string;
  target: string;
  kind: string;
}

export interface UiDomainMeta {
  id: string;
  label: string;
  tier?: string;
  moduleCount: number;
  subdomains?: Array<{ id: string; label: string; moduleCount: number }>;
}

export interface UiGraphData {
  nodes: UiNode[];
  edges: UiEdge[];
  builtAt: string;
  stats: { nodes: number; edges: number };
  meta: {
    domains: UiDomainMeta[];
    packages: Array<{ id: string; label: string; moduleCount: number }>;
    nodeTypes: string[];
    edgeKinds: string[];
    serviceKinds: string[];
  };
}
