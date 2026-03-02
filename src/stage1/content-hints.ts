import { Node, type SourceFile } from 'ts-morph';
import type { ContentHints, RouteInfo, ConditionalRender } from '../types.js';

const ROUTE_PATTERN = /<Route[\s>]/;
// Only env var names are extracted from source text; .env files are never read; no values or secrets.
const ENV_VITE_PATTERN = /(?:import\.meta\.env\.|process\.env\.)(VITE_[A-Z_]+)/g;
const ENV_PROCESS_PATTERN = /process\.env\.([A-Z][A-Z0-9_]+)/g;

export function collectContentHints(sf: SourceFile): ContentHints | undefined {
  const text = sf.getFullText();
  const hints: ContentHints = {};
  let hasAny = false;

  if (ROUTE_PATTERN.test(text)) {
    hints.hasRoutes = true;
    hints.routes = collectRoutes(sf);
    hasAny = true;
  }

  const conditionalRenders = collectConditionalRenders(sf);
  if (conditionalRenders.length > 0) {
    hints.conditionalRenders = conditionalRenders;
    hasAny = true;
  }

  const envVars = new Set<string>();
  for (const m of text.matchAll(ENV_VITE_PATTERN)) envVars.add(m[1]);
  for (const m of text.matchAll(ENV_PROCESS_PATTERN)) envVars.add(m[1]);
  if (envVars.size > 0) {
    hints.envVars = [...envVars].sort();
    hasAny = true;
  }

  return hasAny ? hints : undefined;
}

/**
 * Detect JSX components rendered outside of <Route>, e.g.:
 *   if (!isAuth) return <LoginPage />;
 *   {condition ? <A /> : <B />}
 *   {condition && <Component />}
 */
function collectConditionalRenders(sf: SourceFile): ConditionalRender[] {
  const renders: ConditionalRender[] = [];
  const seen = new Set<string>();

  sf.forEachDescendant(node => {
    // Pattern 1: if (condition) return <Component ... />
    if (Node.isIfStatement(node)) {
      const thenStmt = node.getThenStatement();
      if (!thenStmt) return;
      const thenText = thenStmt.getText();
      const jsxMatch = thenText.match(/return\s+<(\w+)/);
      if (!jsxMatch) return;
      const component = jsxMatch[1];
      if (component[0] !== component[0].toUpperCase()) return;

      const condition = node.getExpression().getText();
      const key = `${component}:${condition}`;
      if (seen.has(key)) return;
      seen.add(key);

      const enclosingFn = node.getFirstAncestor(a =>
        Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
        Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
      );
      const enclosingExport = enclosingFn?.getFirstAncestor(a =>
        Node.isVariableStatement(a) || Node.isFunctionDeclaration(a),
      );
      let renderedIn = 'anonymous';
      if (enclosingExport && Node.isVariableStatement(enclosingExport)) {
        renderedIn = enclosingExport.getDeclarations()[0]?.getName() ?? 'anonymous';
      } else if (enclosingExport && Node.isFunctionDeclaration(enclosingExport)) {
        renderedIn = enclosingExport.getName() ?? 'anonymous';
      } else if (enclosingFn && Node.isFunctionDeclaration(enclosingFn)) {
        renderedIn = enclosingFn.getName() ?? 'anonymous';
      }

      renders.push({
        component,
        condition: condition.length > 100 ? condition.slice(0, 100) + '…' : condition,
        renderedIn,
        lineRange: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
      });
    }

    // Pattern 2: {condition && <Component />} or {condition ? <A /> : <B />}
    if (Node.isJsxExpression(node)) {
      const expr = node.getExpression();
      if (!expr) return;

      if (Node.isBinaryExpression(expr) && expr.getOperatorToken().getText() === '&&') {
        const right = expr.getRight();
        const jsxMatch = right.getText().match(/^<(\w+)/);
        if (!jsxMatch || jsxMatch[1][0] !== jsxMatch[1][0].toUpperCase()) return;
        const component = jsxMatch[1];
        const condition = expr.getLeft().getText();
        const key = `${component}:${condition}`;
        if (seen.has(key)) return;
        seen.add(key);

        const enclosingFn = node.getFirstAncestor(a =>
          Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
          Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
        );
        let renderedIn = 'anonymous';
        if (enclosingFn) {
          const parent = enclosingFn.getParent();
          if (parent && Node.isVariableDeclaration(parent)) {
            renderedIn = parent.getName();
          } else if (Node.isFunctionDeclaration(enclosingFn)) {
            renderedIn = enclosingFn.getName() ?? 'anonymous';
          }
        }

        renders.push({
          component,
          condition: condition.length > 100 ? condition.slice(0, 100) + '…' : condition,
          renderedIn,
          lineRange: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
        });
      }

      if (Node.isConditionalExpression(expr)) {
        const condition = expr.getCondition().getText();
        for (const branch of [expr.getWhenTrue(), expr.getWhenFalse()]) {
          const jsxMatch = branch.getText().match(/^<(\w+)/);
          if (!jsxMatch || jsxMatch[1][0] !== jsxMatch[1][0].toUpperCase()) continue;
          const component = jsxMatch[1];
          const key = `${component}:${condition}`;
          if (seen.has(key)) continue;
          seen.add(key);

          const enclosingFn = node.getFirstAncestor(a =>
            Node.isFunctionDeclaration(a) || Node.isArrowFunction(a) ||
            Node.isFunctionExpression(a) || Node.isMethodDeclaration(a),
          );
          let renderedIn = 'anonymous';
          if (enclosingFn) {
            const parent = enclosingFn.getParent();
            if (parent && Node.isVariableDeclaration(parent)) {
              renderedIn = parent.getName();
            } else if (Node.isFunctionDeclaration(enclosingFn)) {
              renderedIn = enclosingFn.getName() ?? 'anonymous';
            }
          }

          renders.push({
            component,
            condition: condition.length > 100 ? condition.slice(0, 100) + '…' : condition,
            renderedIn,
            lineRange: { start: node.getStartLineNumber(), end: node.getEndLineNumber() },
          });
        }
      }
    }
  });

  return renders;
}

function collectRoutes(sf: SourceFile): RouteInfo[] {
  const routes: RouteInfo[] = [];

  sf.forEachDescendant(node => {
    let pathValue: string | undefined;
    let component: string | undefined;

    if (Node.isJsxSelfClosingElement(node) || Node.isJsxOpeningElement(node)) {
      const tagName = node.getTagNameNode().getText();
      if (tagName !== 'Route') return;

      for (const attr of node.getAttributes()) {
        if (!Node.isJsxAttribute(attr)) continue;
        const name = attr.getNameNode().getText();
        if (name === 'path') {
          const init = attr.getInitializer();
          if (init && Node.isStringLiteral(init)) {
            pathValue = init.getLiteralValue();
          }
        }
        if (name === 'element') {
          const init = attr.getInitializer();
          if (init && Node.isJsxExpression(init)) {
            const innerExpr = init.getExpression();
            if (innerExpr) {
              const jsxText = innerExpr.getText();
              const match = jsxText.match(/^<(\w+)/);
              if (match) component = match[1];
            }
          }
        }
        if (name === 'index') {
          pathValue = pathValue ?? '/';
        }
      }
    }

    if (pathValue && component) {
      routes.push({ path: pathValue, component });
    } else if (pathValue) {
      routes.push({ path: pathValue, component: '(wrapper)' });
    }
  });

  return routes;
}
