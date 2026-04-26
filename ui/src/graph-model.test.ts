import { describe, expect, it } from 'vitest';
import { computeDomainOverview, overviewMatchingDomains } from './graph-model.js';
import type { UiGraphData, UiNode } from './types/graph.js';

function makeGraph(): UiGraphData {
  const nodes: UiNode[] = [
    { id: 'd:a', label: 'Alpha', type: 'domain', description: '' },
    { id: 'd:b', label: 'Beta', type: 'domain', description: '' },
    { id: 'm:1', label: 'pkg/a', type: 'module', description: '', domains: ['d:a'] },
    { id: 'm:2', label: 'pkg/b', type: 'module', description: '', domains: ['d:b'] },
  ];
  const data: UiGraphData = {
    nodes,
    edges: [{ source: 'm:1', target: 'm:2', kind: 'imports' }],
    builtAt: new Date().toISOString(),
    stats: { nodes: 4, edges: 1 },
    meta: {
      domains: [
        { id: 'd:a', label: 'Alpha', tier: 'business', moduleCount: 1 },
        { id: 'd:b', label: 'Beta', tier: 'technical', moduleCount: 1 },
      ],
      packages: [],
      nodeTypes: ['domain', 'module'],
      edgeKinds: ['imports'],
      serviceKinds: [],
    },
  };
  return data;
}

describe('overviewMatchingDomains', () => {
  it('filters by tier map', () => {
    const g = makeGraph();
    const tierOn = new Map<string, boolean>([
      ['business', true],
      ['technical', false],
    ]);
    const visible = overviewMatchingDomains(g, tierOn, '');
    expect(visible.map(d => d.id)).toEqual(['d:a']);
  });
});

function edgeCount(elements: ReturnType<typeof computeDomainOverview>): number {
  return elements.filter(e => {
    const d = (e as { data?: { source?: unknown } }).data;
    return typeof d?.source === 'string';
  }).length;
}

describe('computeDomainOverview', () => {
  it('respects minImportCount for cross-domain edges', () => {
    const g = makeGraph();
    const nodeIndex = new Map(g.nodes.map(n => [n.id, n]));
    const visible = g.meta.domains;
    const elsHigh = computeDomainOverview(g, nodeIndex, visible, 2);
    expect(edgeCount(elsHigh)).toBe(0);

    const elsLow = computeDomainOverview(g, nodeIndex, visible, 1);
    expect(edgeCount(elsLow)).toBe(1);
  });
});
