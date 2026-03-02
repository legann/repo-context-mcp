import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';

const srcDir = path.dirname(fileURLToPath(import.meta.url));
export const packageRoot = path.resolve(srcDir, '..');

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (;;) {
    if (fs.existsSync(path.join(dir, '.git'))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return path.resolve(startDir, '..');
}

export const repoRoot = findRepoRoot(packageRoot);
export const cacheDir = path.join(packageRoot, '.cache');

/** Dir for persisted data in repo (e.g. annotations.json). Committed to git; not in .gitignore. */
export const artifactsDir = path.join(packageRoot, 'artifacts');

/** Relative path from repo root to this package (used to exclude self from scan and for domains config). */
export const SELF_TSCONFIG_REL = 'repo-context';
