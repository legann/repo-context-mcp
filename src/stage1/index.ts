import { Project, type SourceFile } from 'ts-morph';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import type { SyntacticSnapshot, PackageInfo, ModuleInfo } from '../types.js';
import { SELF_TSCONFIG_REL } from '../paths.js';
import { discoverPackages } from './packages.js';
import { collectImports, extractPackageName } from './imports.js';
import { collectExports } from './exports.js';
import { collectContentHints } from './content-hints.js';
import { makeModuleId, pathPrefixLength } from './utils.js';
import { collectInfraModules } from './infra.js';

const SKIP_PATTERN = /\/(dist|dist-bundled|node_modules|\.next|__tests__|__mocks__|\.cache)\//;
const SELF_PACKAGE = 'repo-context';
const SUPPORTED_EXTENSIONS = new Set(['.ts', '.tsx', '.js', '.jsx']);

export interface SnapshotOptions {
  previousSnapshot?: SyntacticSnapshot;
  /** Additional path-segment patterns to skip (e.g. ["packages/old-legacy"]). */
  ignorePatterns?: string[];
}

// ── Public API ──

export function collectSyntacticSnapshot(
  repoRoot: string,
  options?: SnapshotOptions,
): SyntacticSnapshot {
  const packages = discoverPackages(repoRoot);
  const allModules: ModuleInfo[] = [];
  const absPathToId = new Map<string, string>();
  const previousSnapshot = options?.previousSnapshot;
  const extraIgnore = options?.ignorePatterns ?? [];

  // Build a map of previous modules by filePath for cache lookup
  const prevByPath = new Map<string, ModuleInfo>();
  if (previousSnapshot) {
    for (const m of previousSnapshot.modules) {
      prevByPath.set(m.filePath, m);
    }
  }

  // Pass 1: discover all files, build absPath→moduleId map
  const pendingByPath = new Map<string, { sf: SourceFile; pkg: PackageInfo; relPath: string; moduleId: string }>();

  for (const pkg of packages) {
    if (!pkg.hasTsConfig || pkg.name === SELF_PACKAGE) continue;

    const pkgAbsPath = path.resolve(repoRoot, pkg.path);
    const tsconfigPath = path.join(pkgAbsPath, 'tsconfig.json');

    let project: Project;
    try {
      project = new Project({ tsConfigFilePath: tsconfigPath, compilerOptions: { allowJs: true, checkJs: false } });
    } catch (e) {
      console.warn(`  ⚠ Skipping ${pkg.name}: ${(e as Error).message}`);
      continue;
    }

    let count = 0;
    for (const sf of project.getSourceFiles()) {
      const filePath = sf.getFilePath();
      if (!filePath.startsWith(pkgAbsPath + '/')) continue;
      if (SKIP_PATTERN.test(filePath)) continue;
      if (extraIgnore.length > 0) {
        const relFromRoot = path.relative(repoRoot, filePath);
        if (extraIgnore.some(p => relFromRoot.includes(p))) continue;
      }
      const ext = path.extname(filePath).toLowerCase();
      if (!SUPPORTED_EXTENSIONS.has(ext)) continue;

      const relPath = path.relative(pkgAbsPath, filePath);
      const relFromRoot = path.relative(repoRoot, filePath);
      if (path.normalize(relFromRoot).startsWith(path.normalize(SELF_TSCONFIG_REL + '/'))) continue;
      const moduleId = makeModuleId(pkg.name, relPath);
      const existing = pendingByPath.get(filePath);
      if (!existing || pathPrefixLength(pkg.path, relFromRoot) > pathPrefixLength(existing.pkg.path, relFromRoot)) {
        pendingByPath.set(filePath, { sf, pkg, relPath, moduleId });
      }
      count++;
    }

    console.log(`  ${pkg.name}: ${count} modules`);
  }

  const pendingFiles = Array.from(pendingByPath.values());
  for (const p of pendingFiles) {
    absPathToId.set(p.sf.getFilePath(), p.moduleId);
  }
  console.log(`  Deduplicated: ${pendingFiles.length} unique modules`);

  // Pass 2: collect imports/exports, reuse cached modules when contentHash matches
  let reused = 0;
  let rescanned = 0;

  for (const { sf, pkg, relPath, moduleId } of pendingFiles) {
    const filePath = sf.getFilePath();
    const fullText = sf.getFullText();
    const contentHash = createHash('sha256').update(fullText).digest('hex').slice(0, 16);

    // Try to reuse previous module if content hasn't changed
    const prevMod = prevByPath.get(filePath);
    if (prevMod && prevMod.contentHash === contentHash && prevMod.id === moduleId) {
      // Reuse previous module data but update filePath (could differ if repo moved)
      allModules.push({ ...prevMod, filePath });
      reused++;
      continue;
    }

    rescanned++;
    allModules.push({
      id: moduleId,
      packageName: pkg.name,
      filePath,
      relativeFilePath: relPath,
      contentHash,
      imports: collectImports(sf, absPathToId, packages),
      exports: collectExports(sf),
      contentHints: collectContentHints(sf),
    });
  }

  if (previousSnapshot) {
    console.log(`  Incremental: ${reused} reused, ${rescanned} rescanned`);
  }

  // Pass 3: resolve any remaining unresolved non-relative imports
  // For reused modules, re-resolve since the absPathToId map may have changed
  for (const mod of allModules) {
    for (const imp of mod.imports) {
      if (imp.isExternal) continue;
      if (imp.resolvedModuleId && !imp.moduleSpecifier.startsWith('.')) continue;
      if (!imp.moduleSpecifier.startsWith('.')) {
        const pkgName = extractPackageName(imp.moduleSpecifier);
        if (packages.some(p => p.name === pkgName)) {
          imp.resolvedModuleId = `pkg:${pkgName}`;
        } else {
          imp.isExternal = true;
        }
      }
    }
  }

  const infraModules = collectInfraModules({ repoRoot, packages });
  const totalInfraResources = infraModules?.reduce((n, m) => n + m.resources.length, 0) ?? 0;
  if (infraModules.length > 0) {
    console.log(`  Infra: ${infraModules.length} module(s), ${totalInfraResources} resource(s)`);
  }

  return {
    repoRoot,
    timestamp: new Date().toISOString(),
    packages,
    modules: allModules,
    infraModules,
  };
}
