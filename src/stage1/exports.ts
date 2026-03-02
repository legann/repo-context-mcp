import { Node, type SourceFile, type BindingElement } from 'ts-morph';
import type {
  ExportInfo, SymbolKind, ParamInfo, FieldInfo, MemberInfo, InternalInfo,
} from '../types.js';
import { getFunctionNode, normalizeType } from './utils.js';
import { collectCalls } from './call-graph.js';

export function collectExports(sf: SourceFile): ExportInfo[] {
  const result: ExportInfo[] = [];

  for (const [name, declarations] of sf.getExportedDeclarations()) {
    for (const decl of declarations) {
      if (decl.getSourceFile() !== sf) continue;

      const info: ExportInfo = {
        name,
        kind: getSymbolKind(decl),
        signature: getSignatureText(decl),
        params: getParams(decl),
        returnType: getReturnType(decl),
        typeValue: getTypeValue(decl),
        fields: getInterfaceFields(decl),
        lineRange: { start: decl.getStartLineNumber(), end: decl.getEndLineNumber() },
        isDefault: name === 'default',
      };

      const impls = getImplementsInterfaces(decl);
      if (impls) info.implementsInterfaces = impls;

      const members = collectClassMembers(decl);
      if (members) info.privateMembers = members;

      const fnInternals = collectFunctionInternals(decl);
      if (fnInternals) info.internals = fnInternals;

      const lineCount = info.lineRange.end - info.lineRange.start;
      if (lineCount <= 500) {
        const calls = collectCalls(decl);
        if (calls.length > 0) info.calls = calls;
      }

      result.push(info);
    }
  }

  return result;
}

function getSymbolKind(node: Node): SymbolKind {
  if (Node.isFunctionDeclaration(node)) return 'function';
  if (Node.isClassDeclaration(node)) return 'class';
  if (Node.isInterfaceDeclaration(node)) return 'interface';
  if (Node.isTypeAliasDeclaration(node)) return 'type';
  if (Node.isEnumDeclaration(node)) return 'enum';
  if (Node.isVariableDeclaration(node)) {
    if (getFunctionNode(node)) return 'function';
    return 'const';
  }
  return 'unknown';
}

function getSignatureText(node: Node): string | undefined {
  const fn = getFunctionNode(node);
  if (fn) {
    const params = fn.getParameters().map(p => {
      const t = p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText());
      return `${p.getName()}: ${t}`;
    }).join(', ');
    const ret = fn.getReturnTypeNode()?.getText() ?? normalizeType(fn.getReturnType().getText());
    return `(${params}): ${ret}`;
  }
  if (Node.isClassDeclaration(node)) return `class ${node.getName() ?? 'anonymous'}`;
  if (Node.isInterfaceDeclaration(node)) return `interface ${node.getName()}`;
  if (Node.isTypeAliasDeclaration(node)) return `type ${node.getName()}`;
  if (Node.isEnumDeclaration(node)) return `enum ${node.getName()}`;
  return undefined;
}

function getParams(node: Node): ParamInfo[] | undefined {
  const fn = getFunctionNode(node);
  if (!fn) return undefined;
  return fn.getParameters().map(p => ({
    name: p.getName(),
    type: p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText()),
  }));
}

function getReturnType(node: Node): string | undefined {
  const fn = getFunctionNode(node);
  if (!fn) return undefined;
  return fn.getReturnTypeNode()?.getText() ?? normalizeType(fn.getReturnType().getText());
}

function getTypeValue(node: Node): string | undefined {
  if (Node.isTypeAliasDeclaration(node)) {
    const typeNode = node.getTypeNode();
    if (typeNode) {
      const text = typeNode.getText();
      if (text.length <= 300) return text;
      return text.slice(0, 300) + '…';
    }
  }
  if (Node.isEnumDeclaration(node)) {
    const members = node.getMembers().map(m => {
      const val = m.getValue();
      return val !== undefined ? `${m.getName()} = ${JSON.stringify(val)}` : m.getName();
    });
    const text = members.join(' | ');
    if (text.length <= 300) return text;
    return text.slice(0, 300) + '…';
  }
  if (Node.isInterfaceDeclaration(node)) {
    const parts: string[] = [];
    for (const prop of node.getProperties()) {
      const opt = prop.hasQuestionToken() ? '?' : '';
      const t = prop.getTypeNode()?.getText() ?? normalizeType(prop.getType().getText());
      parts.push(`${prop.getName()}${opt}: ${t}`);
    }
    for (const method of node.getMethods()) {
      const params = method.getParameters().map(p => {
        const t = p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText());
        return `${p.getName()}: ${t}`;
      }).join(', ');
      const ret = method.getReturnTypeNode()?.getText() ?? normalizeType(method.getReturnType().getText());
      const opt = method.hasQuestionToken() ? '?' : '';
      parts.push(`${method.getName()}${opt}(${params}): ${ret}`);
    }
    if (parts.length === 0) return undefined;
    const text = `{ ${parts.join('; ')} }`;
    if (text.length <= 500) return text;
    return text.slice(0, 500) + '…';
  }
  return undefined;
}

function getInterfaceFields(node: Node): FieldInfo[] | undefined {
  if (!Node.isInterfaceDeclaration(node)) return undefined;
  const fields: FieldInfo[] = [];
  for (const prop of node.getProperties()) {
    fields.push({
      name: prop.getName(),
      type: prop.getTypeNode()?.getText() ?? normalizeType(prop.getType().getText()),
      optional: prop.hasQuestionToken(),
    });
  }
  for (const method of node.getMethods()) {
    const params = method.getParameters().map(p => {
      const t = p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText());
      return `${p.getName()}: ${t}`;
    }).join(', ');
    const ret = method.getReturnTypeNode()?.getText() ?? normalizeType(method.getReturnType().getText());
    fields.push({
      name: method.getName(),
      type: `(${params}) => ${ret}`,
      optional: method.hasQuestionToken(),
    });
  }
  return fields.length > 0 ? fields : undefined;
}

function getImplementsInterfaces(node: Node): string[] | undefined {
  if (!Node.isClassDeclaration(node)) return undefined;
  const impls = node.getImplements();
  if (impls.length === 0) return undefined;
  return impls.map(i => i.getText().replace(/<.*>$/, ''));
}

function collectClassMembers(node: Node): MemberInfo[] | undefined {
  if (!Node.isClassDeclaration(node)) return undefined;
  const members: MemberInfo[] = [];

  for (const method of node.getMethods()) {
    const scope = method.getScope();
    if (scope !== 'private' && scope !== 'protected') continue;
    const params = method.getParameters().map(p => {
      const t = p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText());
      return `${p.getName()}: ${t}`;
    }).join(', ');
    const ret = method.getReturnTypeNode()?.getText() ?? normalizeType(method.getReturnType().getText());
    members.push({
      name: method.getName(),
      kind: 'method',
      access: scope,
      signature: `(${params}): ${ret}`,
      lineRange: { start: method.getStartLineNumber(), end: method.getEndLineNumber() },
    });
  }

  for (const prop of node.getProperties()) {
    const scope = prop.getScope();
    if (scope !== 'private' && scope !== 'protected') continue;
    const t = prop.getTypeNode()?.getText() ?? normalizeType(prop.getType().getText());
    members.push({
      name: prop.getName(),
      kind: 'property',
      access: scope,
      signature: t,
      lineRange: { start: prop.getStartLineNumber(), end: prop.getEndLineNumber() },
    });
  }

  return members.length > 0 ? members : undefined;
}

function collectFunctionInternals(node: Node, minLines = 200): InternalInfo[] | undefined {
  const fn = getFunctionNode(node);
  if (!fn) return undefined;
  const body = fn.getBody();
  if (!body || !Node.isBlock(body)) return undefined;

  const totalLines = fn.getEndLineNumber() - fn.getStartLineNumber();
  if (totalLines < minLines) return undefined;

  const internals: InternalInfo[] = [];

  for (const stmt of body.getStatements()) {
    if (Node.isFunctionDeclaration(stmt)) {
      const name = stmt.getName();
      if (!name) continue;
      const params = stmt.getParameters().map(p => {
        const t = p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText());
        return `${p.getName()}: ${t}`;
      }).join(', ');
      const ret = stmt.getReturnTypeNode()?.getText() ?? normalizeType(stmt.getReturnType().getText());
      internals.push({
        name,
        kind: 'function',
        signature: `(${params}): ${ret}`,
        lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
      });
      continue;
    }

    if (!Node.isVariableStatement(stmt)) continue;

    for (const decl of stmt.getDeclarationList().getDeclarations()) {
      const nameNode = decl.getNameNode();

      if (Node.isArrayBindingPattern(nameNode) || Node.isObjectBindingPattern(nameNode)) {
        const names = nameNode.getElements()
          .filter((e): e is BindingElement => Node.isBindingElement(e))
          .map(e => e.getName?.() ?? e.getText())
          .filter(Boolean);
        if (names.length > 0) {
          internals.push({
            name: names.join(', '),
            kind: 'destructuring',
            lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
          });
        }
        continue;
      }

      const name = decl.getName();
      const init = decl.getInitializer();

      if (init && (Node.isArrowFunction(init) || Node.isFunctionExpression(init))) {
        const params = init.getParameters().map(p => {
          const t = p.getTypeNode()?.getText() ?? normalizeType(p.getType().getText());
          return `${p.getName()}: ${t}`;
        }).join(', ');
        const ret = init.getReturnTypeNode()?.getText() ?? normalizeType(init.getReturnType().getText());
        internals.push({
          name,
          kind: 'function',
          signature: `(${params}): ${ret}`,
          lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
        });
      } else {
        internals.push({
          name,
          kind: 'variable',
          lineRange: { start: stmt.getStartLineNumber(), end: stmt.getEndLineNumber() },
        });
      }
    }
  }

  return internals.length > 0 ? internals : undefined;
}
