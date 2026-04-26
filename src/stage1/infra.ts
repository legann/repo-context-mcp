import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import yaml from 'js-yaml';
import type {
  InfraKind,
  InfraModuleInfo,
  InfraResource,
  InfraResourceKind,
  InfraTrigger,
  InfraEnvRef,
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
  /** Repo-root-relative path fragments; matching files are skipped (see `domains.config.json` `infraExclude`). */
  excludePatterns?: string[];
}

function matchesInfraExclude(relPath: string, patterns: string[] | undefined): boolean {
  if (!patterns?.length) return false;
  const norm = relPath.replace(/\\/g, '/');
  for (const p of patterns) {
    const q = p.replace(/\\/g, '/').replace(/^\//, '');
    if (norm === q || norm.endsWith('/' + q)) return true;
  }
  return false;
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

/**
 * Extract a CloudFormation reference from a YAML value.
 * Handles !Ref, !GetAtt, Fn::Ref, Fn::GetAtt, and !Sub with variable references.
 */
function logicalIdIsDynamoDbTable(logicalId: string, allResourceTypes: Map<string, string>): boolean {
  return allResourceTypes.get(logicalId) === 'AWS::DynamoDB::Table';
}

/** Walk a policy fragment (!Ref, !GetAtt, nested objects) and collect DynamoDB table logical IDs. */
function collectDynamoTableRefsInValue(
  node: unknown,
  allResourceTypes: Map<string, string>,
  out: Set<string>,
): void {
  if (node === null || node === undefined) return;
  if (typeof node === 'string') {
    if (logicalIdIsDynamoDbTable(node, allResourceTypes)) out.add(node);
    return;
  }
  if (Array.isArray(node)) {
    for (const x of node) collectDynamoTableRefsInValue(x, allResourceTypes, out);
    return;
  }
  if (typeof node !== 'object') return;
  const o = node as Record<string, unknown>;
  if ('Ref' in o && typeof o.Ref === 'string' && logicalIdIsDynamoDbTable(o.Ref, allResourceTypes)) {
    out.add(o.Ref);
  }
  if ('Fn::GetAtt' in o) {
    const ga = o['Fn::GetAtt'];
    const first = Array.isArray(ga) && typeof ga[0] === 'string' ? ga[0]
      : typeof ga === 'string' ? ga.split('.')[0] : undefined;
    if (first && logicalIdIsDynamoDbTable(first, allResourceTypes)) out.add(first);
  }
  for (const v of Object.values(o)) collectDynamoTableRefsInValue(v, allResourceTypes, out);
}

/** Attach DynamoDB table refs from Lambda Policies (inline + !Ref ManagedPolicy). */
function appendDynamoRefsFromLambdaPolicies(
  policies: unknown,
  policyIdToTables: Map<string, string[]>,
  allResourceTypes: Map<string, string>,
  envRefs: InfraEnvRef[],
  seenTableIds: Set<string>,
): void {
  if (!Array.isArray(policies)) return;
  for (const pol of policies) {
    const fromPol = new Set<string>();
    collectDynamoTableRefsInValue(pol, allResourceTypes, fromPol);
    if (pol && typeof pol === 'object' && 'Ref' in pol && typeof (pol as { Ref: unknown }).Ref === 'string') {
      const pid = (pol as { Ref: string }).Ref;
      const extra = policyIdToTables.get(pid);
      if (extra) for (const t of extra) fromPol.add(t);
    }
    for (const tid of fromPol) {
      if (seenTableIds.has(tid)) continue;
      seenTableIds.add(tid);
      envRefs.push({ varName: `iamPolicy:${tid}`, refType: 'ref', targetLogicalId: tid });
    }
  }
}

function extractRef(
  value: unknown,
  allResourceTypes: Map<string, string>,
): Omit<InfraEnvRef, 'varName'> | null {
  if (typeof value === 'string') {
    if (allResourceTypes.has(value)) {
      return { refType: 'ref', targetLogicalId: value };
    }
    if (value.endsWith('TableName') || value.endsWith('TableArn')) {
      return { refType: 'ref', targetLogicalId: value };
    }
    return null;
  }
  if (!value || typeof value !== 'object') return null;
  const obj = value as Record<string, unknown>;

  if ('Ref' in obj && typeof obj.Ref === 'string') {
    const ref = obj.Ref;
    if (allResourceTypes.has(ref)) return { refType: 'ref', targetLogicalId: ref };
    if (ref.endsWith('TableName') || ref.endsWith('TableArn')) {
      return { refType: 'ref', targetLogicalId: ref };
    }
    return null;
  }

  if ('Fn::GetAtt' in obj) {
    const getAtt = obj['Fn::GetAtt'];
    if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') {
      return allResourceTypes.has(getAtt[0]) ? { refType: 'getatt', targetLogicalId: getAtt[0] } : null;
    }
    if (typeof getAtt === 'string') {
      const [logId] = getAtt.split('.');
      return allResourceTypes.has(logId) ? { refType: 'getatt', targetLogicalId: logId } : null;
    }
  }

  if ('Fn::Sub' in obj) {
    return { refType: 'sub' };
  }

  return null;
}

function parseSamEvent(
  name: string,
  type: string,
  props: Record<string, unknown>,
  allResourceTypes: Map<string, string>,
): InfraTrigger | null {
  const typeLower = type.toLowerCase();
  if (typeLower === 'api') {
    return {
      name,
      type: 'api',
      method: props.Method ? String(props.Method) : undefined,
      path: props.Path ? String(props.Path) : undefined,
    };
  }
  if (typeLower === 'sqs') {
    let queueRef: string | undefined;
    const queue = props.Queue;
    if (queue && typeof queue === 'object') {
      const qObj = queue as Record<string, unknown>;
      if ('Fn::GetAtt' in qObj) {
        const getAtt = qObj['Fn::GetAtt'];
        if (Array.isArray(getAtt) && typeof getAtt[0] === 'string') queueRef = getAtt[0];
        else if (typeof getAtt === 'string') queueRef = getAtt.split('.')[0];
      }
    }
    if (!queueRef && typeof queue === 'string' && allResourceTypes.has(queue)) {
      queueRef = queue;
    }
    return { name, type: 'sqs', queueRef };
  }
  if (typeLower === 'schedule') {
    return {
      name,
      type: 'schedule',
      schedule: props.Schedule ? String(props.Schedule) : undefined,
    };
  }
  if (typeLower === 'websocket') {
    return { name, type: 'websocket' };
  }
  return null;
}

/** Stable 16-char hash for a single IaC resource payload (not the whole template). */
function hashResourcePayload(payload: unknown): string {
  return createHash('sha256').update(JSON.stringify(payload)).digest('hex').slice(0, 16);
}

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
      Globals?: Record<string, unknown>;
      Resources?: Record<string, Record<string, unknown>>;
    };

    const contentHash = createHash('sha256')
      .update(JSON.stringify(doc))
      .digest('hex')
      .slice(0, 16);

    const resources: InfraResource[] = [];
    const allResourceTypes = new Map<string, string>();

    const globalFunc = root.Globals?.Function as Record<string, unknown> | undefined;
    const globalVariables = (globalFunc?.Environment as Record<string, unknown> | undefined)?.Variables as
      | Record<string, unknown>
      | undefined;

    if (root.Resources && typeof root.Resources === 'object') {
      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = (res?.Type as string) ?? 'other';
        allResourceTypes.set(logicalId, type);
      }

      const policyIdToTables = new Map<string, string[]>();
      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = (res?.Type as string) ?? 'other';
        if (type !== 'AWS::IAM::ManagedPolicy') continue;
        const mpProps = (res?.Properties ?? {}) as Record<string, unknown>;
        const set = new Set<string>();
        collectDynamoTableRefsInValue(mpProps.PolicyDocument, allResourceTypes, set);
        if (set.size > 0) policyIdToTables.set(logicalId, [...set].sort());
      }

      for (const [logicalId, res] of Object.entries(root.Resources)) {
        const type = (res?.Type as string) ?? 'other';
        const kind: InfraResourceKind = samResourceKindMap[type] ?? 'other';
        const props = (res?.Properties ?? {}) as Record<string, unknown>;

        const attributes: Record<string, string> = {};
        if (props.FunctionName) attributes.functionName = String(props.FunctionName);
        if (props.Handler) attributes.handler = String(props.Handler);

        const envVars: string[] = [];
        const envRefs: InfraEnvRef[] = [];
        const funcEnv = (props.Environment as Record<string, unknown> | undefined)
          ?.Variables as Record<string, unknown> | undefined;
        const mergedEnv: Record<string, unknown> | undefined =
          globalVariables && typeof globalVariables === 'object'
            ? { ...globalVariables, ...(funcEnv && typeof funcEnv === 'object' ? funcEnv : {}) }
            : funcEnv && typeof funcEnv === 'object'
              ? funcEnv
              : undefined;
        if (mergedEnv && typeof mergedEnv === 'object') {
          for (const [key, val] of Object.entries(mergedEnv)) {
            envVars.push(key);
            const ref = extractRef(val, allResourceTypes);
            if (ref) {
              envRefs.push({ varName: key, ...ref });
            }
          }
        }

        if (kind === 'lambda') {
          const seenTableIds = new Set(
            envRefs.map(r => r.targetLogicalId).filter((x): x is string => Boolean(x)),
          );
          appendDynamoRefsFromLambdaPolicies(
            props.Policies,
            policyIdToTables,
            allResourceTypes,
            envRefs,
            seenTableIds,
          );
        }

        const triggers: InfraTrigger[] = [];
        const events = props.Events as Record<string, Record<string, unknown>> | undefined;
        if (events && typeof events === 'object') {
          for (const [evtName, evt] of Object.entries(events)) {
            const evtType = (evt?.Type as string) ?? '';
            const evtProps = (evt?.Properties ?? {}) as Record<string, unknown>;
            const trigger = parseSamEvent(evtName, evtType, evtProps, allResourceTypes);
            if (trigger) triggers.push(trigger);
          }
        }

        const resourceContentHash = hashResourcePayload(res);

        resources.push({
          id: logicalId,
          kind,
          provider: 'aws',
          contentHash: resourceContentHash,
          attributes,
          envVars: envVars.length > 0 ? envVars : undefined,
          triggers: triggers.length > 0 ? triggers : undefined,
          envRefs: envRefs.length > 0 ? envRefs : undefined,
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
  'node_modules', '.git', '.aws-sam', 'dist', 'dist-bundled', '.next', '__tests__', '__mocks__',
  'tests', 'e2e', 'cypress', 'playwright', '__e2e__', '__snapshots__',
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
    const dockerResourceBody = { id: parentDir, kind: 'dockerfile' as const, attributes: attrs };
    const resources: InfraResource[] = [{
      id: parentDir,
      kind: 'other',
      provider: 'generic',
      contentHash: hashResourcePayload(dockerResourceBody),
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
    const k8sResourceBody = {
      id: name,
      apiVersion: d.apiVersion,
      kind: kindStr,
      metadata: d.metadata,
    };
    const resources: InfraResource[] = [{
      id: name,
      kind: resKind,
      provider: 'k8s',
      contentHash: hashResourcePayload(k8sResourceBody),
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
    const helmResourceBody = {
      id: name,
      name: d.name,
      version: d.version,
      appVersion: d.appVersion,
    };
    const resources: InfraResource[] = [{
      id: name,
      kind: 'helm-release',
      provider: 'generic',
      contentHash: hashResourcePayload(helmResourceBody),
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
  const { repoRoot, excludePatterns } = options;
  const infraModules: InfraModuleInfo[] = [];
  const seenModuleId = new Set<string>();

  const candidates: { filePath: string; relPath: string }[] = [];
  discoverInfraFiles(repoRoot, repoRoot, candidates);
  if (candidates.length === 0) return infraModules;

  for (const { filePath, relPath } of candidates) {
    if (matchesInfraExclude(relPath, excludePatterns)) continue;
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

