import * as fs from 'node:fs';
import * as fsPromises from 'node:fs/promises';
import * as path from 'node:path';
import type { SyntacticSnapshot } from '../types.js';

export interface SnapshotCache {
  load(): SyntacticSnapshot | null;
  loadAsync(): Promise<SyntacticSnapshot | null>;
  save(snapshot: SyntacticSnapshot): void;
  saveAsync(snapshot: SyntacticSnapshot): Promise<void>;
}

export function createFileCache(cacheDir: string): SnapshotCache {
  const filePath = path.join(cacheDir, 'syntactic-snapshot-cache.json');

  return {
    load(): SyntacticSnapshot | null {
      try {
        if (!fs.existsSync(filePath)) return null;
        const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
        if (!raw || !Array.isArray(raw.modules)) return null;
        return raw as SyntacticSnapshot;
      } catch {
        return null;
      }
    },

    async loadAsync(): Promise<SyntacticSnapshot | null> {
      try {
        const content = await fsPromises.readFile(filePath, 'utf-8');
        const raw = JSON.parse(content);
        if (!raw || !Array.isArray(raw.modules)) return null;
        return raw as SyntacticSnapshot;
      } catch {
        return null;
      }
    },

    save(snapshot: SyntacticSnapshot): void {
      fs.mkdirSync(cacheDir, { recursive: true });
      const serializable = {
        ...snapshot,
        modules: snapshot.modules.map(m => ({
          ...m,
          filePath: m.filePath,
        })),
      };
      fs.writeFileSync(filePath, JSON.stringify(serializable));
    },

    async saveAsync(snapshot: SyntacticSnapshot): Promise<void> {
      await fsPromises.mkdir(cacheDir, { recursive: true });
      const serializable = {
        ...snapshot,
        modules: snapshot.modules.map(m => ({
          ...m,
          filePath: m.filePath,
        })),
      };
      await fsPromises.writeFile(filePath, JSON.stringify(serializable));
    },
  };
}
