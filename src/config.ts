import * as fs from 'node:fs';
import * as path from 'node:path';
import { z } from 'zod';

// ── Schema ──

const ServerConfigSchema = z.object({
  port: z.number().int().min(1).max(65535).optional(),
  host: z.string().optional(),
});

const ScanConfigSchema = z.object({
  ignorePatterns: z.array(z.string()).optional(),
});

const RepoContextConfigSchema = z.object({
  server: ServerConfigSchema.optional(),
  scan: ScanConfigSchema.optional(),
  verbose: z.boolean().optional(),
});

export type RepoContextFileConfig = z.infer<typeof RepoContextConfigSchema>;

// ── Resolved config (all fields present) ──

export interface ResolvedConfig {
  server: {
    port: number;
    host: string;
  };
  scan: {
    ignorePatterns: string[];
  };
  verbose: boolean;
}

// ── Defaults ──

const DEFAULTS: ResolvedConfig = {
  server: {
    port: 3334,
    host: '127.0.0.1',
  },
  scan: {
    ignorePatterns: [],
  },
  verbose: false,
};

const CONFIG_FILENAME = 'repo-context.config.json';

// ── Loader ──

export function loadConfig(configDir: string): ResolvedConfig {
  const filePath = path.join(configDir, CONFIG_FILENAME);
  let fileConfig: RepoContextFileConfig = {};

  if (fs.existsSync(filePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(filePath, 'utf-8'));
      const parsed = RepoContextConfigSchema.safeParse(raw);
      if (parsed.success) {
        fileConfig = parsed.data;
        console.log(`Config loaded: ${filePath}`);
      } else {
        console.warn(`  Config: validation errors in ${filePath}, using defaults`);
        console.warn(`    ${parsed.error.message}`);
      }
    } catch (e) {
      console.warn(`  Config: failed to parse ${filePath} — ${(e as Error).message}`);
    }
  }

  return resolveConfig(fileConfig);
}

/**
 * Merge file config + env overrides + CLI overrides into a fully resolved config.
 * Precedence: defaults < file < env < CLI.
 */
function resolveConfig(file: RepoContextFileConfig): ResolvedConfig {
  const envPort = process.env.REPO_CONTEXT_PORT;
  const envVerbose = process.env.REPO_CONTEXT_VERBOSE;

  let port = file.server?.port ?? DEFAULTS.server.port;
  if (envPort) {
    const parsed = parseInt(envPort, 10);
    if (Number.isNaN(parsed) || parsed < 1 || parsed > 65535) {
      console.warn(`  Config: invalid REPO_CONTEXT_PORT="${envPort}", using ${port}`);
    } else {
      port = parsed;
    }
  }

  return {
    server: {
      port,
      host: file.server?.host ?? DEFAULTS.server.host,
    },
    scan: {
      ignorePatterns: file.scan?.ignorePatterns ?? DEFAULTS.scan.ignorePatterns,
    },
    verbose: envVerbose === '1' ? true : file.verbose ?? DEFAULTS.verbose,
  };
}

export { CONFIG_FILENAME, DEFAULTS as CONFIG_DEFAULTS };
