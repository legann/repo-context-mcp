import * as fs from 'node:fs';
import * as path from 'node:path';
import type { DomainsConfig } from './domains.js';

/** When `lambdaBundleScripts` is unset, try these paths if the file exists. */
const DEFAULT_LAMBDA_BUNDLE_SCRIPT_CANDIDATES = ['packages/lambda-functions/scripts/bundle.js'];

function stripExt(file: string, extRe: RegExp): string {
  return file.replace(extRe, '');
}

/**
 * Parse a `bundle.js`-style script: objects with `entryPoint` and `outputFile` (esbuild Lambda list).
 * Builds handler path (SAM `Handler` before `.handler`) → source path under `src/` without `.ts`.
 */
export function parseLambdaBundleScript(source: string): Record<string, string> {
  const map: Record<string, string> = {};
  const reForward =
    /entryPoint:\s*['"]([^'"]+)['"]\s*,\s*outputFile:\s*['"]([^'"]+)['"]/g;
  let m: RegExpExecArray | null;
  while ((m = reForward.exec(source)) !== null) {
    addBundleMapping(map, m[1], m[2]);
  }
  const reReverse =
    /outputFile:\s*['"]([^'"]+)['"]\s*,\s*entryPoint:\s*['"]([^'"]+)['"]/g;
  while ((m = reReverse.exec(source)) !== null) {
    addBundleMapping(map, m[2], m[1]);
  }
  return map;
}

function addBundleMapping(map: Record<string, string>, entryPoint: string, outputFile: string): void {
  const entryBase = stripExt(entryPoint.trim(), /\.(tsx?|jsx?|mts|cts)$/i)
    .replace(/^[/\\]+/, '')
    .replace(/\\/g, '/');
  const outBase = stripExt(outputFile.trim(), /\.(m?js|cjs)$/i)
    .replace(/^[/\\]+/, '')
    .replace(/\\/g, '/');
  if (!entryBase || !outBase) return;
  if (entryBase === outBase) return;
  map[outBase] = entryBase;
}

/**
 * Merge handler maps from configured bundle script paths (repo-root-relative).
 */
export function loadLambdaBundleHandlerMap(repoRoot: string, config: DomainsConfig | null): Record<string, string> {
  const merged: Record<string, string> = {};
  const user = config?.lambdaBundleScripts;
  const paths =
    user === undefined
      ? DEFAULT_LAMBDA_BUNDLE_SCRIPT_CANDIDATES
      : user;

  for (const rel of paths) {
    const abs = path.join(repoRoot, rel);
    if (!fs.existsSync(abs) || !fs.statSync(abs).isFile()) continue;
    try {
      const text = fs.readFileSync(abs, 'utf8');
      const part = parseLambdaBundleScript(text);
      Object.assign(merged, part);
    } catch (e) {
      if (process.env.REPO_CONTEXT_VERBOSE) {
        console.warn(`  ⚠ Lambda bundle script ${rel}: ${(e as Error).message}`);
      }
    }
  }

  return merged;
}
