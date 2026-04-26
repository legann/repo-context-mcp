import type { SemanticAnnotation } from '../types.js';

/** Subset of semantic annotations exposed to the ui viewer (optional enrichment). */
export interface UiSemanticRich {
  flowDescription?: string;
  dataFlow?: string | Record<string, string>;
  integrationPoints?: string | Record<string, string>;
  stateShape?: string | Record<string, string>;
  assumptions?: string[];
  sideEffects?: string[];
  risks?: string[];
  patterns?: string[];
  keyExports?: Record<string, string>;
  invariants?: string[];
  extensionPoints?: string[];
  envDependencies?: Record<string, string>;
}

const MAX_KEY_EXPORTS = 24;

function trimRecord(map: Record<string, string>, maxKeys: number): Record<string, string> {
  const entries = Object.entries(map);
  if (entries.length <= maxKeys) return map;
  return Object.fromEntries(entries.slice(0, maxKeys));
}

function nonEmptyRecord(r: Record<string, string> | undefined): boolean {
  return !!r && Object.keys(r).length > 0;
}

/** Pick structured semantic fields for the ui layer; omit if nothing to show. */
export function extractSemanticForUi(semantic: SemanticAnnotation | undefined): UiSemanticRich | undefined {
  if (!semantic) return undefined;
  const out: UiSemanticRich = {};

  const fd = semantic.flowDescription?.trim();
  if (fd) out.flowDescription = fd;

  if (semantic.dataFlow !== undefined && semantic.dataFlow !== '') {
    if (typeof semantic.dataFlow === 'string') {
      const t = semantic.dataFlow.trim();
      if (t) out.dataFlow = t;
    } else if (nonEmptyRecord(semantic.dataFlow)) {
      out.dataFlow = trimRecord(semantic.dataFlow, 32);
    }
  }

  if (semantic.integrationPoints !== undefined && semantic.integrationPoints !== '') {
    if (typeof semantic.integrationPoints === 'string') {
      const t = semantic.integrationPoints.trim();
      if (t) out.integrationPoints = t;
    } else if (nonEmptyRecord(semantic.integrationPoints)) {
      out.integrationPoints = trimRecord(semantic.integrationPoints, 32);
    }
  }

  if (semantic.stateShape !== undefined && semantic.stateShape !== '') {
    if (typeof semantic.stateShape === 'string') {
      const t = semantic.stateShape.trim();
      if (t) out.stateShape = t;
    } else if (nonEmptyRecord(semantic.stateShape)) {
      out.stateShape = trimRecord(semantic.stateShape, 32);
    }
  }

  if (semantic.assumptions?.length) out.assumptions = semantic.assumptions;
  if (semantic.sideEffects?.length) out.sideEffects = semantic.sideEffects;
  if (semantic.risks?.length) out.risks = semantic.risks;
  if (semantic.patterns?.length) out.patterns = semantic.patterns;
  if (semantic.invariants?.length) out.invariants = semantic.invariants;
  if (semantic.extensionPoints?.length) out.extensionPoints = semantic.extensionPoints;

  if (nonEmptyRecord(semantic.keyExports)) {
    out.keyExports = trimRecord(semantic.keyExports!, MAX_KEY_EXPORTS);
  }

  if (nonEmptyRecord(semantic.envDependencies)) {
    out.envDependencies = trimRecord(semantic.envDependencies!, 32);
  }

  return Object.keys(out).length > 0 ? out : undefined;
}
