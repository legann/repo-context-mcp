import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type {
  InfraKind,
  InfraModuleInfo,
  InfraResource,
  InfraResourceKind,
  PackageInfo,
} from '../types.js';

/** Schema that allows CloudFormation/SAM tags (!Ref, !Sub, !If, !Join, etc.) without throwing. */
const CLOUDFORMATION_SAFE_SCHEMA = yaml.DEFAULT_SCHEMA.extend([
  // Match any tag starting with '!' for scalars (e.g. !Ref, !Sub, !GetAtt) — pass through value
  new yaml.Type('!', {
    kind: 'scalar',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
  // Match any tag starting with '!' for sequences (e.g. !If, !Join, !Select)
  new yaml.Type('!', {
    kind: 'sequence',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
  new yaml.Type('!', {
    kind: 'mapping',
    multi: true,
    resolve: () => true,
    construct: (data: unknown) => data,
  }),
]);

export interface InfraScanOptions {
  repoRoot: string;
  packages: PackageInfo[];
}

export interface IaCParser {
  kind: InfraKind;
  supports(filePath: string, doc: unknown): boolean;
  parse(filePath: string, relPath: string, doc: unknown): InfraModuleInfo | null;
}

const samResourceKindMap: Record<string, InfraResourceKind> = {
  'AWS::Serverless::Function': 'lambda',
  'AWS::Lambda::Function': 'lambda',
  'AWS::SQS::Queue': 'queue',
  'AWS::SNS::Topic': 'topic',
  'AWS::DynamoDB::Table': 'table',
  'AWS::ApiGateway::RestApi': 'api',
  'AWS::ApiGatewayV2::Api': 'api',
  'AWS::S3::Bucket': 'bucket',
  'AWS::IAM::Role': 'role',
};

const samParser: IaCParser = {
  kind: 'aws-sam',

  supports(_filePath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const root = doc as { Transform?: unknown; Resources?: unknown };
    if (typeof root.Transform === 'string' && root.Transform.startsWith('AWS::Serverless::')) {
      return true;
    }
    if (root.Resources && typeof root.Resources === 'object') {
      return true;
    }
    return false;
  },

  parse(filePath, relPath, doc): InfraModuleInfo | null {
    if (!doc || typeof doc !== 'object') return null;
    const root = doc as {
      Transform?: unknown;
      Resources?: Record<
        string,
        {
          Type?: string;
          Properties?: {
            Handler?: string;
            FunctionName?: string;
            Environment?: { Variables?: Record<string, unknown> };
          };
        }
      >;
    };

    const contentHash = createHash('sha256')
      .update(JSON.stringify(doc))
      .digest('hex')
      .slice(0, 16);

    const resources: InfraResource[] = [];

    if (root.Resources && typeof root.Resources === 'object') {
      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = res?.Type ?? 'other';
        const kind: InfraResourceKind = samResourceKindMap[type] ?? 'other';

        const attributes: Record<string, string> = {};
        if (res?.Properties) {
          const props = res.Properties as {
            Handler?: string;
            FunctionName?: string;
          };
          if (props.FunctionName) attributes.functionName = String(props.FunctionName);
          if (props.Handler) attributes.handler = String(props.Handler);
        }

        const envVars: string[] = [];
        const env = (res?.Properties as { Environment?: { Variables?: Record<string, unknown> } } | undefined)
          ?.Environment?.Variables;
        if (env && typeof env === 'object') {
          for (const key of Object.keys(env)) {
            envVars.push(key);
          }
        }

        resources.push({
          id: logicalId,
          kind,
          provider: 'aws',
          attributes,
          envVars: envVars.length > 0 ? envVars : undefined,
        });
      }
    }

    if (resources.length === 0) return null;

    const isSam = typeof root.Transform === 'string' && root.Transform.startsWith('AWS::Serverless::');
    const kind: InfraKind = isSam ? 'aws-sam' : 'cloudformation';
    const moduleId = `infra:${kind}:${relPath}`;

    return {
      id: moduleId,
      kind,
      filePath,
      relativeFilePath: relPath,
      contentHash,
      resources,
    };
  },
};

/** Dir names to skip when scanning for infra files (build artifacts, deps, etc.). */
const INFRA_SCAN_SKIP_DIRS = new Set([
  'node_modules', '.git', '.aws-sam', 'dist', 'dist-bundled', '.next', '__tests__',
  'coverage', '.cache', 'build', '.turbo', '.nx',
]);

/** Extensions and names that are infra candidates. */
const INFRA_YAML_EXT = new Set(['.yaml', '.yml']);
const INFRA_JSON_EXT = new Set(['.json']);
const INFRA_NAMES = new Set(['Chart.yaml', 'Chart.yml']);

function isInfraCandidateFileName(name: string, ext: string): boolean {
  if (INFRA_NAMES.has(name)) return true;
  if (INFRA_YAML_EXT.has(ext) || INFRA_JSON_EXT.has(ext)) return true;
  if (name === 'Dockerfile' || (name.startsWith('Dockerfile.') && !ext)) return true;
  return false;
}

/**
 * Recursively discover candidate infra files under dir, relative to repoRoot.
 * Returns list of { filePath, relPath }.
 */
function discoverInfraFiles(repoRoot: string, dir: string, out: { filePath: string; relPath: string }[]): void {
  let entries: fs.Dirent[];
  try {
    entries = fs.readdirSync(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const e of entries) {
    const full = path.join(dir, e.name);
    const rel = path.relative(repoRoot, full);
    if (e.isDirectory()) {
      if (INFRA_SCAN_SKIP_DIRS.has(e.name)) continue;
      discoverInfraFiles(repoRoot, full, out);
      continue;
    }
    if (!e.isFile()) continue;
    const ext = path.extname(e.name).toLowerCase();
    const base = e.name;
    if (!isInfraCandidateFileName(base, ext)) continue;
    out.push({ filePath: full, relPath: path.normalize(rel).replace(/\\/g, '/') });
  }
}

/** Extract path-based infra domains from relative path (e.g. k8s-services/some-service). */
function pathBasedDomainsFromRelPath(relPath: string): string {
  const segments = relPath.replace(/\/Dockerfile.*$/, '').split(/[/\\]/).filter(Boolean);
  const skip = new Set(['infrastructure', 'infra', 'src', 'app']);
  const meaningful = segments.filter(s => !skip.has(s.toLowerCase()));
  return meaningful.length > 0 ? meaningful.join('/') : segments.join('/') || 'root';
}

/** Parse first FROM line from Dockerfile content (image[:tag]). */
function parseFirstFrom(content: string): string {
  const line = content.split('\n').find(l => /^\s*FROM\s+/i.test(l));
  if (!line) return '';
  const match = line.match(/\bFROM\s+(?:--platform=\S+\s+)?(\S+)/i);
  return match ? match[1].trim() : '';
}

const dockerfileParser: IaCParser = {
  kind: 'dockerfile',

  supports(filePath: string, doc: unknown): boolean {
    const base = path.basename(filePath);
    if (base !== 'Dockerfile' && !base.startsWith('Dockerfile.')) return false;
    return typeof doc === 'string';
  },

  parse(filePath: string, relPath: string, doc: unknown): InfraModuleInfo | null {
    if (typeof doc !== 'string') return null;
    const content = doc;
    const contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16);
    const domainPath = pathBasedDomainsFromRelPath(relPath);
    const parentDir = path.basename(path.dirname(filePath));
    const baseImage = parseFirstFrom(content);
    const attrs: Record<string, string> = { domainPath };
    if (baseImage) attrs.baseImage = baseImage;
    const resources: InfraResource[] = [{
      id: parentDir,
      kind: 'other',
      provider: 'generic',
      attributes: attrs,
    }];
    const id = `infra:dockerfile:${relPath}`;
    return {
      id,
      kind: 'dockerfile',
      filePath,
      relativeFilePath: relPath,
      contentHash,
      resources,
    };
  },
};

const k8sKindMap: Record<string, InfraResourceKind> = {
  Deployment: 'k8s-deployment',
  Service: 'k8s-service',
  ConfigMap: 'k8s-crd',
  Secret: 'k8s-crd',
  ServiceAccount: 'k8s-crd',
  Namespace: 'k8s-crd',
  DaemonSet: 'k8s-deployment',
  StatefulSet: 'k8s-deployment',
  Ingress: 'k8s-service',
};

const kubernetesParser: IaCParser = {
  kind: 'kubernetes',

  supports(_filePath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (d.Resources && typeof d.Resources === 'object') return false;
    if (typeof d.Transform === 'string') return false;
    if (typeof d.apiVersion === 'string' && typeof d.kind === 'string') return true;
    return false;
  },

  parse(filePath: string, relPath: string, doc: unknown): InfraModuleInfo | null {
    if (!doc || typeof doc !== 'object') return null;
    const d = doc as { apiVersion?: string; kind?: string; metadata?: { name?: string; namespace?: string } };
    const contentHash = createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
    const kindStr = d.kind ?? 'Unknown';
    const resKind: InfraResourceKind = k8sKindMap[kindStr] ?? 'k8s-crd';
    const name = d.metadata?.name ?? path.basename(filePath, path.extname(filePath));
    const resources: InfraResource[] = [{
      id: name,
      kind: resKind,
      provider: 'k8s',
      attributes: {
        apiVersion: String(d.apiVersion ?? ''),
        kind: kindStr,
        ...(d.metadata?.namespace ? { namespace: d.metadata.namespace } : {}),
      },
    }];
    return {
      id: `infra:kubernetes:${relPath}`,
      kind: 'kubernetes',
      filePath,
      relativeFilePath: relPath,
      contentHash,
      resources,
    };
  },
};

const helmParser: IaCParser = {
  kind: 'helm',

  supports(_filePath, doc): boolean {
    if (!doc || typeof doc !== 'object') return false;
    const d = doc as Record<string, unknown>;
    if (d.Resources && typeof d.Resources === 'object') return false;
    if (typeof d.apiVersion === 'string' && d.apiVersion.startsWith('v2') && typeof d.name === 'string') return true;
    return false;
  },

  parse(filePath: string, relPath: string, doc: unknown): InfraModuleInfo | null {
    if (!doc || typeof doc !== 'object') return null;
    const d = doc as { name?: string; version?: string; appVersion?: string; description?: string };
    const contentHash = createHash('sha256').update(JSON.stringify(doc)).digest('hex').slice(0, 16);
    const name = d.name ?? path.basename(path.dirname(filePath));
    const resources: InfraResource[] = [{
      id: name,
      kind: 'helm-release',
      provider: 'generic',
      attributes: {
        ...(d.version ? { version: String(d.version) } : {}),
        ...(d.appVersion ? { appVersion: String(d.appVersion) } : {}),
        ...(d.description ? { description: String(d.description).slice(0, 200) } : {}),
      },
    }];
    return {
      id: `infra:helm:${relPath}`,
      kind: 'helm',
      filePath,
      relativeFilePath: relPath,
      contentHash,
      resources,
    };
  },
};

const parsers: IaCParser[] = [samParser, helmParser, kubernetesParser, dockerfileParser];

export function collectInfraModules(options: InfraScanOptions): InfraModuleInfo[] {
  const { repoRoot } = options;
  const infraModules: InfraModuleInfo[] = [];
  const seenModuleId = new Set<string>();

  const candidates: { filePath: string; relPath: string }[] = [];
  discoverInfraFiles(repoRoot, repoRoot, candidates);
  if (candidates.length === 0) return infraModules;

  for (const { filePath, relPath } of candidates) {
    let doc: unknown;
    const ext = path.extname(filePath).toLowerCase();
    const base = path.basename(filePath);

    if (base === 'Dockerfile' || base.startsWith('Dockerfile.')) {
      try {
        doc = fs.readFileSync(filePath, 'utf8');
      } catch (err) {
        if (process.env.REPO_CONTEXT_VERBOSE) {
          console.warn(`  ⚠ Infra: failed to read ${relPath}:`, (err as Error).message);
        }
        continue;
      }
    } else if (INFRA_JSON_EXT.has(ext)) {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        doc = JSON.parse(text);
      } catch (err) {
        if (process.env.REPO_CONTEXT_VERBOSE) {
          console.warn(`  ⚠ Infra: failed to parse ${relPath}:`, (err as Error).message);
        }
        continue;
      }
    } else if (INFRA_YAML_EXT.has(ext) || INFRA_NAMES.has(base)) {
      try {
        const text = fs.readFileSync(filePath, 'utf8');
        doc = yaml.load(text, { schema: CLOUDFORMATION_SAFE_SCHEMA });
      } catch (err) {
        if (process.env.REPO_CONTEXT_VERBOSE) {
          console.warn(`  ⚠ Infra: failed to parse ${relPath}:`, (err as Error).message);
        }
        continue;
      }
    } else {
      continue;
    }

    for (const parser of parsers) {
      if (!parser.supports(filePath, doc)) continue;
      const mod = parser.parse(filePath, relPath, doc);
      if (mod && !seenModuleId.has(mod.id)) {
        seenModuleId.add(mod.id);
        infraModules.push(mod);
      }
      break;
    }
  }

  return infraModules;
}

