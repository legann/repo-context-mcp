/**
 * Unit tests for MCP handlers. Uses a small in-memory fixture graph + snapshot,
 * mocks fs for includeBody/grepBody, so no file I/O occurs.
 */
import { jest } from '@jest/globals';

// Mock fs/promises BEFORE importing handlers (so the module picks up the mock)
jest.unstable_mockModule('node:fs/promises', () => ({
  readFile: jest.fn(),
}));

import type { ToolContext, AppState } from './handlers.js';
import { createEmptyGraph, addNode, addEdge } from '../graph/index.js';
import type { SyntacticSnapshot, SemanticGraph, ModuleInfo } from '../types.js';

// Dynamically import after mocking
const fsPromises = await import('node:fs/promises');
const { toolHandlers, resolveNodeId } = await import('./handlers.js');

// ── Fixture builders ──

function makeSnapshot(modules: ModuleInfo[] = []): SyntacticSnapshot {
  return { repoRoot: '/repo', timestamp: '2024-01-01', packages: [], modules };
}

function makeModuleInfo(id: string, filePath = `/repo/${id}.ts`): ModuleInfo {
  return {
    id,
    packageName: 'test',
    filePath,
    relativeFilePath: `${id}.ts`,
    contentHash: 'abc123',
    imports: [],
    exports: [],
  };
}

function buildFixtureGraph(): { graph: SemanticGraph; modulesById: Map<string, ModuleInfo> } {
  const g = createEmptyGraph();
  addNode(g, { id: 'root', type: 'root', label: 'root', description: '' });
  addNode(g, { id: 'pkg:test', type: 'package', label: 'test', description: '' });
  addNode(g, { id: 'mod:test/alpha', type: 'module', label: 'alpha', description: '',
    data: { filePath: '/repo/alpha.ts', relativeFilePath: 'alpha.ts' } });
  addNode(g, { id: 'mod:test/beta', type: 'module', label: 'beta', description: '',
    data: { filePath: '/repo/beta.ts', relativeFilePath: 'beta.ts' } });
  addNode(g, { id: 'cap:test/alpha/Foo', type: 'capability', label: 'Foo', description: '',
    data: { signature: 'function Foo(): void', symbolKind: 'function', lineRange: { start: 1, end: 5 } } });

  addEdge(g, 'root', 'pkg:test', 'contains');
  addEdge(g, 'pkg:test', 'mod:test/alpha', 'contains');
  addEdge(g, 'pkg:test', 'mod:test/beta', 'contains');
  addEdge(g, 'mod:test/alpha', 'cap:test/alpha/Foo', 'contains');
  addEdge(g, 'mod:test/beta', 'mod:test/alpha', 'imports');

  const alphaInfo = makeModuleInfo('mod:test/alpha', '/repo/alpha.ts');
  alphaInfo.imports = [{ moduleSpecifier: './alpha', resolvedModuleId: 'mod:test/alpha', importedNames: ['Foo'], isTypeOnly: false, isExternal: false }];
  const betaInfo = makeModuleInfo('mod:test/beta', '/repo/beta.ts');
  betaInfo.imports = [{ moduleSpecifier: './alpha', resolvedModuleId: 'mod:test/alpha', importedNames: ['Foo'], isTypeOnly: false, isExternal: false }];

  const modulesById = new Map<string, ModuleInfo>([
    ['mod:test/alpha', alphaInfo],
    ['mod:test/beta', betaInfo],
  ]);

  return { graph: g, modulesById };
}

function makeCtx(overrides?: Partial<AppState>): ToolContext {
  const { graph, modulesById } = buildFixtureGraph();
  const annotations = {
    get: () => undefined,
    set: jest.fn(),
    isFresh: () => true,
    getQueue: () => [],
    getStats: () => ({}),
  } as unknown as AppState['annotations'];

  const state: AppState = {
    graph,
    snapshot: makeSnapshot([...modulesById.values()]),
    modulesById,
    searchIndex: new Map(),
    annotations,
    domainsConfig: null,
    builtAt: '2024-01-01',
    ...overrides,
  };

  return {
    getState: () => state,
    refreshContext: jest.fn(),
  };
}

// ── resolveNodeId ──

describe('resolveNodeId', () => {
  const { graph } = buildFixtureGraph();

  it('returns id as-is when it exists exactly', () => {
    expect(resolveNodeId(graph, 'mod:test/alpha')).toBe('mod:test/alpha');
  });

  it('strips .ts extension', () => {
    expect(resolveNodeId(graph, 'mod:test/alpha.ts')).toBe('mod:test/alpha');
  });

  it('strips /index suffix', () => {
    const g = createEmptyGraph();
    addNode(g, { id: 'mod:pkg/utils', type: 'module', label: 'utils', description: '' });
    expect(resolveNodeId(g, 'mod:pkg/utils/index')).toBe('mod:pkg/utils');
  });

  it('returns undefined for unknown node', () => {
    expect(resolveNodeId(graph, 'mod:test/nonexistent')).toBeUndefined();
  });
});

// ── get_context_detail ──

describe('get_context_detail', () => {
  it('returns error for unknown node', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'mod:test/nonexistent' });
    expect(result).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns node view for known module', async () => {
    const ctx = makeCtx();
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'mod:test/alpha' }) as Record<string, unknown>;
    expect(result.id).toBe('mod:test/alpha');
    expect(result.label).toBe('alpha');
    expect(Array.isArray(result.drill_down)).toBe(true);
  });

  it('sets bodyError when includeBody and file read fails', async () => {
    jest.mocked(fsPromises.readFile).mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }) as never);
    const ctx = makeCtx();
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'mod:test/alpha', includeBody: true }) as Record<string, unknown>;
    expect(result.bodyError).toBeDefined();
    expect(typeof result.bodyError).toBe('string');
  });

  it('returns body when includeBody and file read succeeds', async () => {
    jest.mocked(fsPromises.readFile).mockResolvedValueOnce('export function Foo() {}' as never);
    const ctx = makeCtx();
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'mod:test/alpha', includeBody: true }) as Record<string, unknown>;
    expect(result.body).toBe('export function Foo() {}');
    expect(result.bodyError).toBeUndefined();
  });

  it('sets grepError when grepBody and file read fails', async () => {
    jest.mocked(fsPromises.readFile).mockRejectedValueOnce(Object.assign(new Error('EACCES'), { code: 'EACCES' }) as never);
    const ctx = makeCtx();
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'mod:test/alpha', grepBody: 'Foo' }) as Record<string, unknown>;
    expect(result.grepError).toBeDefined();
    expect(typeof result.grepError).toBe('string');
  });

  it('returns grepMatches when grepBody and file read succeeds', async () => {
    jest.mocked(fsPromises.readFile).mockResolvedValueOnce('export function Foo() {}\nexport function Bar() {}' as never);
    const ctx = makeCtx();
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'mod:test/alpha', grepBody: 'Foo' }) as Record<string, unknown>;
    expect(Array.isArray(result.grepMatches)).toBe(true);
    expect(result.grepTotalMatches).toBe(1);
  });

  it('sets bodyError for capability when parent module not found in modulesById', async () => {
    const ctx = makeCtx();
    // Remove alpha from modulesById so parent lookup fails
    ctx.getState().modulesById.delete('mod:test/alpha');
    const result = await toolHandlers['get_context_detail'](ctx, { nodeId: 'cap:test/alpha/Foo', includeBody: true }) as Record<string, unknown>;
    expect(result.bodyError).toBeDefined();
    expect(result.bodyError as string).toContain('Parent module not found');
  });
});

// ── get_dependency_impact ──

describe('get_dependency_impact', () => {
  it('returns error for unknown node', () => {
    const ctx = makeCtx();
    const result = toolHandlers['get_dependency_impact'](ctx, { nodeId: 'mod:test/nonexistent' });
    expect(result).toMatchObject({ error: expect.stringContaining('not found') });
  });

  it('returns downstream for mod:test/alpha (imported by beta)', () => {
    const ctx = makeCtx();
    const result = toolHandlers['get_dependency_impact'](ctx, { nodeId: 'mod:test/alpha' }) as Record<string, unknown>;
    const downstream = result.downstream as Array<{ id: string }>;
    expect(downstream.some(d => d.id === 'mod:test/beta')).toBe(true);
  });

  it('returns uses[] in downstream entry', () => {
    const ctx = makeCtx();
    const result = toolHandlers['get_dependency_impact'](ctx, { nodeId: 'mod:test/alpha' }) as Record<string, unknown>;
    const downstream = result.downstream as Array<{ id: string; uses?: string[] }>;
    const betaEntry = downstream.find(d => d.id === 'mod:test/beta');
    expect(betaEntry?.uses).toContain('Foo');
  });

  it('filters downstream by exportName', () => {
    const ctx = makeCtx();
    const result = toolHandlers['get_dependency_impact'](ctx, { nodeId: 'mod:test/alpha', exportName: 'NonExistent' }) as Record<string, unknown>;
    const downstream = result.downstream as unknown[];
    expect(downstream.length).toBe(0);
  });
});

// ── search_repo_context ──

describe('search_repo_context', () => {
  it('returns results matching query tokens', () => {
    const ctx = makeCtx();
    // Build a minimal search index for the test graph
    const state = ctx.getState();
    const tokenize = (s: string) => s.toLowerCase().replace(/[/\-_.:]/g, ' ').split(/\s+/).filter(Boolean);
    for (const node of state.graph.nodes.values()) {
      for (const t of tokenize(node.id + ' ' + node.label)) {
        let s = state.searchIndex.get(t);
        if (!s) { s = new Set(); state.searchIndex.set(t, s); }
        s.add(node.id);
      }
    }

    const result = toolHandlers['search_repo_context'](ctx, { query: 'alpha' }) as Record<string, unknown>;
    const grouped = result.results as Record<string, Array<{ id: string }>>;
    const allResults = Object.values(grouped).flat();
    expect(allResults.some(r => r.id === 'mod:test/alpha')).toBe(true);
  });

  it('returns empty results for unmatched query', () => {
    const ctx = makeCtx();
    const result = toolHandlers['search_repo_context'](ctx, { query: 'zzzznotfound' }) as Record<string, unknown>;
    expect(result.totalResults).toBe(0);
  });
});
