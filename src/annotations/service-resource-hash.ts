import type { SemanticGraph, SyntacticSnapshot } from '../types.js';
import { makeServiceId } from '../graph/make-service-id.js';

/** Hash of the parsed CloudFormation/SAM resource object (or k8s/helm/dockerfile payload) for this logical resource. */
export function getResourceContentHashForServiceId(
  snapshot: SyntacticSnapshot,
  serviceId: string,
): string | undefined {
  const modules = snapshot.infraModules ?? [];
  for (const im of modules) {
    for (const res of im.resources) {
      if (makeServiceId(res) === serviceId) {
        return res.contentHash;
      }
    }
  }
  return undefined;
}

export function getParentInfraModuleId(graph: SemanticGraph, serviceId: string): string | undefined {
  const inEdges = graph.inEdges.get(serviceId) ?? [];
  const contains = inEdges.find(e => e.kind === 'contains');
  return contains?.from;
}

export function getParentInfraContentHash(
  snapshot: SyntacticSnapshot,
  parentInfraModuleId: string,
): string | undefined {
  return snapshot.infraModules?.find(m => m.id === parentInfraModuleId)?.contentHash;
}

/** Fingerprint used for service annotation freshness: per-resource hash from snapshot, else graph node data. */
export function resolveServiceResourceContentHash(
  graph: SemanticGraph,
  snapshot: SyntacticSnapshot,
  serviceId: string,
): string | undefined {
  const fromSnapshot = getResourceContentHashForServiceId(snapshot, serviceId);
  if (fromSnapshot !== undefined) return fromSnapshot;
  const n = graph.nodes.get(serviceId);
  return n?.type === 'service' ? n.data?.contentHash : undefined;
}
