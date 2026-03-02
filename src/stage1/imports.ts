import type { SourceFile } from 'ts-morph';
import type { ImportInfo, PackageInfo } from '../types.js';

export function collectImports(
  sf: SourceFile,
  absPathToId: Map<string, string>,
  packages: PackageInfo[],
): ImportInfo[] {
  const result: ImportInfo[] = [];

  for (const decl of sf.getImportDeclarations()) {
    const specifier = decl.getModuleSpecifierValue();
    const isTypeOnly = decl.isTypeOnly();

    const defaultImport = decl.getDefaultImport()?.getText();
    const namespaceImport = decl.getNamespaceImport()?.getText();
    const namedImports = decl.getNamedImports().map(n => n.getName());
    const importedNames = [
      ...(defaultImport ? [defaultImport] : []),
      ...(namespaceImport ? [`* as ${namespaceImport}`] : []),
      ...namedImports,
    ];

    let resolvedModuleId: string | undefined;
    let isExternal = false;

    if (specifier.startsWith('.')) {
      const resolved = decl.getModuleSpecifierSourceFile();
      if (resolved) {
        resolvedModuleId = absPathToId.get(resolved.getFilePath());
      }
    } else {
      const pkgName = extractPackageName(specifier);
      const isWorkspace = packages.some(p => p.name === pkgName);
      if (isWorkspace) {
        const resolved = decl.getModuleSpecifierSourceFile();
        if (resolved) {
          resolvedModuleId = absPathToId.get(resolved.getFilePath());
        }
        if (!resolvedModuleId) {
          resolvedModuleId = `pkg:${pkgName}`;
        }
      } else {
        isExternal = true;
      }
    }

    result.push({
      moduleSpecifier: specifier,
      resolvedModuleId,
      importedNames,
      isTypeOnly,
      isExternal,
    });
  }

  return result;
}

export function extractPackageName(specifier: string): string {
  if (specifier.startsWith('@')) {
    const parts = specifier.split('/');
    return parts.length >= 2 ? `${parts[0]}/${parts[1]}` : specifier;
  }
  return specifier.split('/')[0];
}
