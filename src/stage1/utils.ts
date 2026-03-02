import { Node, type ArrowFunction, type FunctionExpression, type FunctionDeclaration } from 'ts-morph';
import * as path from 'node:path';

export type FunctionLike = FunctionDeclaration | ArrowFunction | FunctionExpression;

export function getFunctionNode(node: Node): FunctionLike | undefined {
  if (Node.isFunctionDeclaration(node)) return node;
  if (Node.isVariableDeclaration(node)) {
    const init = node.getInitializer();
    if (init) {
      if (Node.isArrowFunction(init)) return init;
      if (Node.isFunctionExpression(init)) return init;
    }
  }
  return undefined;
}

export function normalizeType(text: string, maxLength = 150): string {
  const result = text.replace(/import\("[^"]+"\)\./g, '');
  if (result.length > maxLength) {
    return result.slice(0, maxLength) + '…';
  }
  return result;
}

export function makeModuleId(packageName: string, relPath: string): string {
  const normalized = relPath
    .replace(/\.(tsx?|jsx?|mjs|cjs)$/, '')
    .replace(/\/index$/, '');
  return `mod:${packageName}/${normalized}`;
}

/** Length of pkgPath as prefix of relFromRoot (for dedup: prefer package that owns the file). */
export function pathPrefixLength(pkgPath: string, relFromRoot: string): number {
  const norm = path.normalize(relFromRoot);
  const prefix = path.normalize(pkgPath);
  if (prefix === '.' || prefix === '') return 0;
  if (norm === prefix || norm.startsWith(prefix + path.sep)) return prefix.length;
  return 0;
}
