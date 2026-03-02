import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import { z } from 'zod';
import type { StoredAnnotation, SemanticGraph, SyntacticSnapshot } from '../types.js';
import { CURRENT_ANNOTATION_SCHEMA_VERSION } from '../types.js';

// ── Zod schemas for runtime validation ──

const SemanticAnnotationSchema = z.object({
  summary: z.string(),
  keyExports: z.record(z.string(), z.string()).optional(),
  assumptions: z.array(z.string()).optional(),
  sideEffects: z.array(z.string()).optional(),
  risks: z.array(z.string()).optional(),
  patterns: z.array(z.string()).optional(),
  flowDescription: z.string().optional(),
  invariants: z.array(z.string()).optional(),
  extensionPoints: z.array(z.string()).optional(),
  integrationPoints: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  stateShape: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  dataFlow: z.union([z.string(), z.record(z.string(), z.string())]).optional(),
  envDependencies: z.record(z.string(), z.string()).optional(),
});

const StoredAnnotationSchema = z.object({
  nodeId: z.string(),
  nodeType: z.enum(['module', 'capability', 'domain', 'service']),
  contentHash: z.string(),
  pass: z.number(),
  updatedAt: z.string(),
  semantic: SemanticAnnotationSchema,
  schemaVersion: z.number().optional(),
});

const AnnotationFileSchema = z.object({
  version: z.number(),
  annotations: z.record(z.string(), StoredAnnotationSchema),
});

export { SemanticAnnotationSchema };

interface AnnotationFile {
  version: number;
  annotations: Record<string, StoredAnnotation>;
}

const SAVE_DEBOUNCE_MS = 800;
const MAX_SAVE_RETRIES = 3;

export class AnnotationStore {
  private filePath: string;
  private data: Record<string, StoredAnnotation> = {};
  private saveTimer: ReturnType<typeof setTimeout> | null = null;
  private _lastSaveError: string | null = null;

  private constructor(filePath: string) {
    this.filePath = filePath;
  }

  /** Factory: create and load store asynchronously. */
  static async create(storageDir: string): Promise<AnnotationStore> {
    const filePath = path.join(storageDir, 'annotations.json');
    await fsPromises.mkdir(path.dirname(filePath), { recursive: true });
    const store = new AnnotationStore(filePath);
    await store.loadAsync();
    return store;
  }

  /** Synchronous factory for backward compatibility (tests, CLI). */
  static createSync(storageDir: string): AnnotationStore {
    const filePath = path.join(storageDir, 'annotations.json');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    const store = new AnnotationStore(filePath);
    store.loadSync();
    return store;
  }

  private parseAndValidate(rawJson: string): void {
    const raw = JSON.parse(rawJson);
    const parsed = AnnotationFileSchema.safeParse(raw);
    if (parsed.success) {
      // Keep raw annotation objects so key order (including inside semantic) is preserved on save
      const order = Object.keys(raw.annotations);
      this.data = {};
      for (const key of order) {
        const rawAnn = raw.annotations[key];
        const validated = StoredAnnotationSchema.safeParse(rawAnn);
        if (validated.success) {
          this.data[key] = rawAnn as StoredAnnotation;
        }
      }
      console.log(`  Annotations loaded: ${Object.keys(this.data).length} nodes`);
      return;
    }

    console.warn(`  Annotations: validation errors, attempting partial load`);
    this.data = {};
    if (raw?.annotations && typeof raw.annotations === 'object') {
      let loaded = 0;
      const skippedIds: string[] = [];
      let firstError: { id: string; message: string } | null = null;
      for (const [key, value] of Object.entries(raw.annotations)) {
        const result = StoredAnnotationSchema.safeParse(value);
        if (result.success) {
          this.data[key] = result.data as StoredAnnotation;
          loaded++;
        } else {
          skippedIds.push(key);
          if (!firstError) {
            const msg = result.error.issues.map(e => `${e.path.join('.')}: ${e.message}`).join('; ');
            firstError = { id: key, message: msg };
          }
        }
      }
      if (skippedIds.length > 0) {
        console.warn(`    Skipped ${skippedIds.length} invalid annotation(s): ${skippedIds.join(', ')}`);
        if (firstError) {
          console.warn(`    Example error (${firstError.id}): ${firstError.message}`);
        }
      }
      console.log(`  Annotations partially loaded: ${loaded} nodes`);
    }
  }

  private loadSync(): void {
    try {
      if (fs.existsSync(this.filePath)) {
        this.parseAndValidate(fs.readFileSync(this.filePath, 'utf-8'));
      } else {
        console.log(`  Annotations: file not found (${this.filePath}), starting with none`);
      }
    } catch (e) {
      this.data = {};
      console.log(`  Annotations: failed to load (${(e as Error).message}), starting with none`);
    }
  }

  private async loadAsync(): Promise<void> {
    try {
      const content = await fsPromises.readFile(this.filePath, 'utf-8');
      this.parseAndValidate(content);
    } catch (e) {
      const code = (e as NodeJS.ErrnoException).code;
      if (code === 'ENOENT') {
        console.log(`  Annotations: file not found (${this.filePath}), starting with none`);
      } else {
        console.log(`  Annotations: failed to load (${(e as Error).message}), starting with none`);
      }
      this.data = {};
    }
  }

  private async saveAsync(): Promise<void> {
    await fsPromises.mkdir(path.dirname(this.filePath), { recursive: true });
    const file: AnnotationFile = { version: 1, annotations: this.data };
    await fsPromises.writeFile(this.filePath, JSON.stringify(file, null, 2));
  }

  private saveSync(): void {
    fs.mkdirSync(path.dirname(this.filePath), { recursive: true });
    const file: AnnotationFile = { version: 1, annotations: this.data };
    fs.writeFileSync(this.filePath, JSON.stringify(file, null, 2));
  }

  private scheduleSave(): void {
    if (this.saveTimer !== null) clearTimeout(this.saveTimer);
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      this.saveWithRetry();
    }, SAVE_DEBOUNCE_MS);
  }

  private async saveWithRetry(attempt = 1): Promise<void> {
    try {
      await this.saveAsync();
      this._lastSaveError = null;
    } catch (e) {
      const msg = (e as Error).message;
      if (attempt < MAX_SAVE_RETRIES) {
        const delay = SAVE_DEBOUNCE_MS * attempt;
        console.error(`  [ALERT] Annotations save failed (attempt ${attempt}/${MAX_SAVE_RETRIES}): ${msg}. Retrying in ${delay}ms...`);
        setTimeout(() => this.saveWithRetry(attempt + 1), delay);
      } else {
        this._lastSaveError = msg;
        console.error(`  [ALERT] Annotations save FAILED after ${MAX_SAVE_RETRIES} attempts: ${msg}. Data may be lost on restart!`);
      }
    }
  }

  get lastSaveError(): string | null {
    return this._lastSaveError;
  }

  /** Write pending annotations to disk immediately (e.g. before process exit). */
  flush(): void {
    if (this.saveTimer !== null) {
      clearTimeout(this.saveTimer);
      this.saveTimer = null;
    }
    this.saveSync();
  }

  get(nodeId: string): StoredAnnotation | undefined {
    return this.data[nodeId];
  }

  set(nodeId: string, annotation: StoredAnnotation): void {
    this.data[nodeId] = annotation;
    this.scheduleSave();
  }

  isFresh(nodeId: string, currentHash: string): boolean {
    const ann = this.data[nodeId];
    if (!ann) return false;
    if (ann.contentHash !== currentHash) return false;
    const v = ann.schemaVersion ?? 1;
    return v >= CURRENT_ANNOTATION_SCHEMA_VERSION;
  }

  getAll(): Record<string, StoredAnnotation> {
    return this.data;
  }

  /**
   * Build a prioritized queue of nodes that need annotation.
   * Returns modules ordered by: stale first, then unannotated, sorted by downstream impact.
   */
  getQueue(
    graph: SemanticGraph,
    snapshot: SyntacticSnapshot,
    options: { domain?: string; limit?: number } = {},
  ): Array<{
    nodeId: string;
    label: string;
    status: 'unannotated' | 'stale';
    domains: string[];
    priority: number;
    reason: string;
    context: {
      exportCount: number;
      topExports: Array<{ name: string; kind: string; signature?: string }>;
      downstreamCount: number;
      totalLines: number;
    };
  }> {
    const { domain, limit = 10 } = options;
    const items: Array<ReturnType<AnnotationStore['getQueue']>[number]> = [];

    for (const mod of snapshot.modules) {
      // Filter by domain if specified
      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const outEdges = graph.outEdges.get(mod.id) ?? [];
        const isTagged = outEdges.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!isTagged) continue;
      }

      const ann = this.data[mod.id];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== mod.contentHash;
      let status: 'unannotated' | 'stale';
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue; // fresh, skip
      }

      // Calculate priority: downstream dependency count
      const inEdges = graph.inEdges.get(mod.id) ?? [];
      const downstreamCount = inEdges.filter(e => e.kind === 'imports').length;

      // Get domains
      const outEdges = graph.outEdges.get(mod.id) ?? [];
      const domains = outEdges
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);

      // Compute total lines from exports
      const maxLine = mod.exports.reduce((m, e) => Math.max(m, e.lineRange.end), 0);

      // Top exports for context
      const topExports = mod.exports
        .slice(0, 10)
        .map(e => ({
          name: e.name,
          kind: e.kind,
          ...(e.signature ? { signature: e.signature } : {}),
        }));

      const priority = (status === 'stale' ? 1000 : 0) + downstreamCount;
      const staleReason = schemaOutdated && !contentStale
        ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION}), needs backfill (${downstreamCount} downstream deps)`
        : contentStale
          ? `Content changed since last annotation (${downstreamCount} downstream deps)`
          : `Stale (${downstreamCount} downstream deps)`;
      const reason = status === 'stale' ? staleReason : `Not yet annotated (${downstreamCount} downstream deps, ${mod.exports.length} exports)`;

      items.push({
        nodeId: mod.id,
        label: graph.nodes.get(mod.id)?.label ?? mod.relativeFilePath,
        status,
        domains,
        priority,
        reason,
        context: {
          exportCount: mod.exports.length,
          topExports,
          downstreamCount,
          totalLines: maxLine,
        },
      });
    }

    // Infra modules (IaC: SAM/CloudFormation, etc.)
    const infraModules = snapshot.infraModules ?? [];
    const infraModuleIdToHash = new Map<string, string>();
    for (const im of infraModules) infraModuleIdToHash.set(im.id, im.contentHash);

    for (const infraMod of infraModules) {
      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const outEdges = graph.outEdges.get(infraMod.id) ?? [];
        const isTagged = outEdges.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!isTagged) continue;
      }

      const ann = this.data[infraMod.id];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== infraMod.contentHash;
      let status: 'unannotated' | 'stale';
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue;
      }

      const outEdges = graph.outEdges.get(infraMod.id) ?? [];
      const domains = outEdges
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);
      const resourceCount = infraMod.resources.length;
      const priority = (status === 'stale' ? 1000 : 0) + resourceCount;
      const reason = status === 'stale'
        ? (schemaOutdated && !contentStale
          ? `Schema outdated (v${ann?.schemaVersion ?? 1} < v${CURRENT_ANNOTATION_SCHEMA_VERSION})`
          : 'IaC template content changed')
        : `IaC module not yet annotated (${resourceCount} resources)`;

      items.push({
        nodeId: infraMod.id,
        label: graph.nodes.get(infraMod.id)?.label ?? infraMod.relativeFilePath,
        status,
        domains,
        priority,
        reason,
        context: {
          exportCount: resourceCount,
          topExports: infraMod.resources.slice(0, 10).map(r => ({ name: r.id, kind: r.kind })),
          downstreamCount: resourceCount,
          totalLines: 0,
        },
      });
    }

    // Service nodes (Lambda, SQS, etc.) — freshness from parent infra module contentHash
    const serviceSet = graph.byType.get('service');
    const serviceIds = serviceSet ? Array.from(serviceSet) : [];
    for (const serviceId of serviceIds) {
      const inEdges = graph.inEdges.get(serviceId) ?? [];
      const containsFrom = inEdges.find(e => e.kind === 'contains');
      const parentInfraId = containsFrom?.from;
      const parentHash = parentInfraId ? infraModuleIdToHash.get(parentInfraId) : undefined;
      if (parentHash === undefined || !parentInfraId) continue;

      if (domain) {
        const domainId = domain.startsWith('domain:') ? domain : `domain:${domain}`;
        const parentOut = graph.outEdges.get(parentInfraId) ?? [];
        const parentTagged = parentOut.some(e => e.kind === 'tagged' && e.to === domainId);
        if (!parentTagged) continue;
      }

      const ann = this.data[serviceId];
      const schemaOutdated = ann && ((ann.schemaVersion ?? 1) < CURRENT_ANNOTATION_SCHEMA_VERSION);
      const contentStale = ann && ann.contentHash !== parentHash;
      let status: 'unannotated' | 'stale';
      if (!ann) {
        status = 'unannotated';
      } else if (contentStale || schemaOutdated) {
        status = 'stale';
      } else {
        continue;
      }

      const node = graph.nodes.get(serviceId);
      const domains = parentInfraId
        ? (graph.outEdges.get(parentInfraId) ?? []).filter(e => e.kind === 'tagged').map(e => graph.nodes.get(e.to)?.label ?? e.to).filter((d): d is string => d != null)
        : [];
      const priority = (status === 'stale' ? 1000 : 0) + 1;
      const reason = status === 'stale'
        ? (schemaOutdated && !contentStale ? 'Schema outdated' : 'Parent IaC template changed')
        : 'Service resource not yet annotated';

      items.push({
        nodeId: serviceId,
        label: node?.label ?? serviceId,
        status,
        domains,
        priority,
        reason,
        context: {
          exportCount: 0,
          topExports: [],
          downstreamCount: 0,
          totalLines: 0,
        },
      });
    }

    items.sort((a, b) => b.priority - a.priority);
    return items.slice(0, limit);
  }

  /**
   * Get annotation coverage statistics.
   */
  getStats(
    graph: SemanticGraph,
    snapshot: SyntacticSnapshot,
  ): {
    totalModules: number;
    annotated: number;
    fresh: number;
    stale: number;
    unannotated: number;
    infraModules: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
    services: { total: number; annotated: number; fresh: number; stale: number; unannotated: number };
    byDomain: Record<string, { total: number; annotated: number; fresh: number }>;
    domainAnnotations: { totalDomains: number; annotated: number; list: string[] };
  } {
    let annotated = 0;
    let fresh = 0;
    let stale = 0;

    const byDomain: Record<string, { total: number; annotated: number; fresh: number }> = {};

    for (const mod of snapshot.modules) {
      // Get domains
      const outEdges = graph.outEdges.get(mod.id) ?? [];
      const domains = outEdges
        .filter(e => e.kind === 'tagged')
        .map(e => graph.nodes.get(e.to)?.label ?? e.to)
        .filter((d): d is string => d != null);

      const ann = this.data[mod.id];
      const isAnnotated = ann !== undefined;
      const isFresh = isAnnotated && ann.contentHash === mod.contentHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;

      if (isAnnotated) {
        annotated++;
        if (isFresh) fresh++;
        else stale++;
      }

      for (const d of domains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Infra modules (IaC)
    const infraModules = snapshot.infraModules ?? [];
    const infraModuleIdToHash = new Map<string, string>();
    for (const im of infraModules) infraModuleIdToHash.set(im.id, im.contentHash);
    let infraAnnotated = 0;
    let infraFresh = 0;
    let infraStale = 0;
    for (const im of infraModules) {
      const ann = this.data[im.id];
      const isAnnotated = ann !== undefined;
      const isFresh = isAnnotated && ann.contentHash === im.contentHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      if (isAnnotated) {
        infraAnnotated++;
        if (isFresh) infraFresh++;
        else infraStale++;
      }
      const domains = (graph.outEdges.get(im.id) ?? []).filter(e => e.kind === 'tagged').map(e => graph.nodes.get(e.to)?.label ?? e.to).filter((d): d is string => d != null);
      for (const d of domains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Service nodes (Lambda, SQS, etc.)
    const serviceSet = graph.byType.get('service');
    const serviceIds = serviceSet ? Array.from(serviceSet) : [];
    let svcAnnotated = 0;
    let svcFresh = 0;
    let svcStale = 0;
    for (const serviceId of serviceIds) {
      const inEdges = graph.inEdges.get(serviceId) ?? [];
      const parentInfraId = inEdges.find(e => e.kind === 'contains')?.from;
      const parentHash = parentInfraId ? infraModuleIdToHash.get(parentInfraId) : undefined;
      if (parentHash === undefined) continue;
      const ann = this.data[serviceId];
      const isAnnotated = ann !== undefined;
      const isFresh = isAnnotated && ann.contentHash === parentHash && (ann.schemaVersion ?? 1) >= CURRENT_ANNOTATION_SCHEMA_VERSION;
      if (isAnnotated) {
        svcAnnotated++;
        if (isFresh) svcFresh++;
        else svcStale++;
      }
      const parentDomains = parentInfraId
        ? (graph.outEdges.get(parentInfraId) ?? []).filter(e => e.kind === 'tagged').map(e => graph.nodes.get(e.to)?.label ?? e.to).filter((d): d is string => d != null)
        : [];
      for (const d of parentDomains) {
        if (!byDomain[d]) byDomain[d] = { total: 0, annotated: 0, fresh: 0 };
        byDomain[d].total++;
        if (isAnnotated) byDomain[d].annotated++;
        if (isFresh) byDomain[d].fresh++;
      }
    }

    // Count domain-level annotations
    const domainNodes = graph.byType.get('domain') ?? new Set<string>();
    let annotatedDomains = 0;
    const domainList: string[] = [];
    for (const dId of domainNodes) {
      if (this.data[dId]) {
        annotatedDomains++;
        domainList.push(graph.nodes.get(dId)?.label ?? dId);
      }
    }

    return {
      totalModules: snapshot.modules.length,
      annotated,
      fresh,
      stale,
      unannotated: snapshot.modules.length - annotated,
      infraModules: {
        total: infraModules.length,
        annotated: infraAnnotated,
        fresh: infraFresh,
        stale: infraStale,
        unannotated: infraModules.length - infraAnnotated,
      },
      services: {
        total: serviceIds.length,
        annotated: svcAnnotated,
        fresh: svcFresh,
        stale: svcStale,
        unannotated: serviceIds.length - svcAnnotated,
      },
      byDomain,
      domainAnnotations: {
        totalDomains: domainNodes.size,
        annotated: annotatedDomains,
        list: domainList,
      },
    };
  }
}
