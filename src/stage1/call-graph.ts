import { Node } from 'ts-morph';
import { getFunctionNode } from './utils.js';

const IGNORED_CALLS = new Set([
  'console.log', 'console.warn', 'console.error', 'console.info', 'console.debug',
  'JSON.stringify', 'JSON.parse', 'Object.keys', 'Object.values', 'Object.entries',
  'Object.assign', 'Object.fromEntries', 'Array.isArray', 'Array.from',
  'String', 'Number', 'Boolean', 'parseInt', 'parseFloat', 'toString',
  'Promise.all', 'Promise.resolve', 'Promise.reject', 'Promise.allSettled',
  'Math.max', 'Math.min', 'Math.floor', 'Math.ceil', 'Math.round',
  'Date.now', 'setTimeout', 'setInterval', 'clearTimeout', 'clearInterval',
  'encodeURIComponent', 'decodeURIComponent', 'encodeURI', 'decodeURI',
  'require', 'Map', 'Set', 'Error', 'TypeError', 'RegExp',
]);

export function collectCalls(node: Node): string[] {
  const calls = new Set<string>();

  const visitor = (desc: Node) => {
    if (!Node.isCallExpression(desc)) return;
    const expr = desc.getExpression();
    if (Node.isIdentifier(expr)) {
      calls.add(expr.getText());
    } else if (Node.isPropertyAccessExpression(expr)) {
      const obj = expr.getExpression();
      const prop = expr.getName();
      if (Node.isThisExpression(obj)) {
        calls.add(`this.${prop}`);
      } else if (Node.isIdentifier(obj)) {
        calls.add(`${obj.getText()}.${prop}`);
      } else {
        calls.add(prop);
      }
    }
  };

  if (Node.isClassDeclaration(node)) {
    for (const method of node.getMethods()) {
      method.forEachDescendant(visitor);
    }
    const ctor = node.getConstructors()[0];
    if (ctor) ctor.forEachDescendant(visitor);
  } else {
    const fn = getFunctionNode(node);
    if (fn) fn.forEachDescendant(visitor);
  }

  const filtered = [...calls]
    .filter(c => !IGNORED_CALLS.has(c))
    .slice(0, 50);
  return filtered;
}
