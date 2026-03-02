import * as path from 'node:path';
import * as fs from 'node:fs';
import type { PackageInfo } from '../types.js';
import { SELF_TSCONFIG_REL } from '../paths.js';

const SELF_PACKAGE = 'repo-context';
const DISCOVER_SKIP = /\/(node_modules|\.git|dist|dist-bundled|\.next|__tests__|__mocks__|\.cache)(\/|$)/;

export function discoverPackages(repoRoot: string): PackageInfo[] {
  const tsconfigDirs = findAllTsconfigDirs(repoRoot);
  const packages: PackageInfo[] = [];
  const seen = new Set<string>();

  for (const dir of tsconfigDirs) {
    const relPath = path.relative(repoRoot, dir);
    if (relPath.startsWith(SELF_TSCONFIG_REL)) continue;
    const normalized = path.normalize(relPath) || '.';
    if (seen.has(normalized)) continue;
    seen.add(normalized);

    const info = readPackageInfoFromDir(dir, normalized);
    if (info && info.name !== SELF_PACKAGE) packages.push(info);
  }

  return packages.sort((a, b) => a.path.localeCompare(b.path));
}

function findAllTsconfigDirs(repoRoot: string): string[] {
  const result: string[] = [];
  function walk(dir: string) {
    if (DISCOVER_SKIP.test(dir)) return;
    const tsconfigPath = path.join(dir, 'tsconfig.json');
    if (fs.existsSync(tsconfigPath)) {
      const rel = path.relative(repoRoot, dir);
      if (path.normalize(rel) === path.normalize(SELF_TSCONFIG_REL)) return;
      result.push(dir);
    }

    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue;
      if (e.name === 'node_modules' || e.name === '.git' || e.name === 'dist' || e.name === '.cache') continue;
      walk(path.join(dir, e.name));
    }
  }
  walk(repoRoot);
  return result;
}

function readPackageInfoFromDir(pkgDir: string, relativePath: string): PackageInfo | null {
  const tsconfigPath = path.join(pkgDir, 'tsconfig.json');
  if (!fs.existsSync(tsconfigPath)) return null;

  let name: string;
  let version: string | undefined;
  const pkgJsonPath = path.join(pkgDir, 'package.json');
  if (fs.existsSync(pkgJsonPath)) {
    try {
      const pkgJson = JSON.parse(fs.readFileSync(pkgJsonPath, 'utf-8'));
      name = pkgJson.name || pathToSlug(relativePath);
      version = pkgJson.version;
    } catch {
      name = pathToSlug(relativePath);
    }
  } else {
    name = pathToSlug(relativePath);
  }

  return {
    name,
    path: relativePath,
    version,
    hasTsConfig: true,
  };
}

function pathToSlug(relativePath: string): string {
  const normalized = path.normalize(relativePath) || '.';
  if (normalized === '.') return 'root';
  return normalized.replace(/\/+/g, '-').replace(/^\.-/, '') || 'root';
}
