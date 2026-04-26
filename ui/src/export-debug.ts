import type { Core } from 'cytoscape';
import type { UiEdge, UiGraphData, UiNode } from './types/graph.js';

function downloadUrl(filename: string, url: string): void {
  const a = document.createElement('a');
  a.href = url;
  a.download = filename;
  a.rel = 'noopener';
  a.click();
}

export function exportGraphPng(cy: Core, filename = 'repo-context-graph.png'): void {
  const png = cy.png({ full: true, scale: 2 });
  downloadUrl(filename, png);
}

export function exportGraphJson(payload: unknown, filename = 'repo-context-export.json'): void {
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  downloadUrl(filename, url);
  URL.revokeObjectURL(url);
}

export function buildExportPayload(input: {
  graphData: UiGraphData;
  view: 'overview' | 'detail';
  domainId: string | null;
  nodes: UiNode[];
  edges: UiEdge[];
  ui: Record<string, unknown>;
}): Record<string, unknown> {
  return {
    exportedAt: new Date().toISOString(),
    builtAt: input.graphData.builtAt,
    view: input.view,
    domainId: input.domainId,
    stats: input.graphData.stats,
    sliceStats: { nodes: input.nodes.length, edges: input.edges.length },
    nodes: input.nodes,
    edges: input.edges,
    ui: input.ui,
  };
}

export async function copyTextToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
