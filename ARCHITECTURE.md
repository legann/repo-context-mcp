# Architecture: Three Stages

Repo-context builds context in three stages: a syntactic snapshot, a semantic graph, and an optional layer of AI annotations.

---

## Stage 1: Syntactic Snapshot

**Input:** repo root path.  
**Output:** `SyntacticSnapshot` = `{ repoRoot, timestamp, packages[], modules[], infraModules[] }`.

- **Package discovery:** The repo is scanned for all **`tsconfig.json`** files (recursively; `node_modules`, `.git`, `dist`, `.cache` are skipped). Each directory that contains a `tsconfig.json` is treated as one **package** (project). Package name is taken from `package.json` in that directory if present, otherwise derived from the path (e.g. `packages/client-ui` -> `packages-client-ui`). This works for monorepos, single-package repos, and repos with several independent apps. No `workspaces` field is required.
- **File types:** `.ts`, `.tsx`, `.js`, `.jsx` (ts-morph with `allowJs: true`). Module id strips these extensions (and `.mjs`/`.cjs` when present).
- **Module id:** `mod:{packageName}/{relativeFilePath}` (extension stripped), e.g. `mod:package-name/src/path/to/module`.
- **Per module we collect:**
  - **Imports:** specifier, resolved `moduleId` (or external), imported names, type-only flag.
  - **Exports:** name, kind (function, class, interface, type, const, etc.), signature, params, returnType, typeValue (for types/aliases), fields (for interfaces), implementsInterfaces (for classes), calls (shallow call graph), privateMembers (for classes), lineRange.
  - **Content hints:** routes (from `<Route path=...>`), conditional renders (components rendered under conditionals), env vars (`VITE_*`, `process.env.*`).
  - **Content hash:** SHA-256 of file text (first 16 chars) for change detection and annotation freshness.

All of this is **deterministic** for a given source tree: same files -> same snapshot.

- **Infra (IaC) scan:** In parallel to code discovery, the repo is scanned for **infrastructure-as-code** files, supported inputs:
  - **YAML/JSON** -- SAM (`Transform: AWS::Serverless-*`), CloudFormation (`Resources`), Kubernetes manifests (`apiVersion` + `kind`), k3d configs (`k3d.io/v1alpha5`), Helm `Chart.yaml` (apiVersion v2 + name).
  - **Dockerfile** -- files named `Dockerfile` or `Dockerfile.*`.
  Each matching file becomes one **infra module**. Parsers are tried in order (SAM/CFN -> Helm -> Kubernetes -> Dockerfile); first match wins. One infra module per file; multi-document YAML yields one document per file (first doc only for K8s).

- **SAM extended parsing:** For SAM/CloudFormation templates, the parser additionally extracts:
  - **Event triggers** (`Properties.Events`) -- API Gateway (method, path), SQS (queue ref), Schedule (cron/rate). Stored as `InfraTrigger[]` on each resource.
  - **Environment variable references** (`Properties.Environment.Variables`) -- values containing `!Ref`, `!GetAtt`, or `Fn::Sub` are resolved to the target resource's logical id. Stored as `InfraEnvRef[]` on each resource.

**Security (secrets):** Only **names** of environment variables (e.g. `process.env.API_URL`) are collected from source code. `.env` and other env files are **never read**. No secrets or values enter the snapshot, graph, or annotations -- by design.

---

## Stage 2: Semantic Graph

**Input:** `SyntacticSnapshot`.  
**Output:** `SemanticGraph` = nodes (Map), edges (flat list + outEdges/inEdges), and `byType` index.

**Passes:**

1. **Root + packages** -- one root node, one node per package; `contains` edges root -> package.
2. **Modules** -- one node per module, `contains` from parent package; **imports** edges between modules (resolved from snapshot).
3. **Infra** -- Domain nodes for infra (`domain:infra-sam`, `domain:infra-k8s`, `domain:infra-helm`, `domain:infra-dockerfile`). One **module**-type node per infra module (IaC file); one **service**-type node per declared resource (Lambda, queue, K8s Deployment, Helm release, etc.). Edges: root -> infra module -> services (`contains`); each infra module and its services are `tagged` with the corresponding infra domain. For Lambda resources, Handler is resolved to a TS module and an **infra** edge is added from the Lambda service node to that module. SQS trigger refs create `consumes` edges (queue -> Lambda); environment variable refs to resources create `uses_env` edges (Lambda -> resource).
4. **Capabilities** -- one node per export (function, class, interface, etc.) with symbol detail (signature, params, returnType, fields, implementsInterfaces, calls, privateMembers, lineRange); `contains` from module.
5. **Domains** -- Domain nodes and `tagged` edges from modules to domains (path-based, cluster-based, config patterns).
6. **Content-based domains** -- `domain:routing` for modules with `<Route>`, `domain:config` for modules that reference env vars.
7. **Propagate infra domains** -- For each service that has an `infra` edge to a code module, copy that module's domain tags onto the service (so e.g. domain "formula-manager" includes both the TS module and the Lambda).
8. **Domain tier classification** -- Each domain gets a `tier` based on module count and package spread: `business` (5+ modules, 2+ packages), `feature` (3+ modules or 2+ modules in 2+ packages), `layer` (structural names like types/utils/config), `technical` (everything else). Stored in `domain.data.tier`.
9. **Subdomains** -- For business/feature domains with 10+ modules, path prefix clustering creates subdomain nodes (e.g. `domain:auth/oauth-adapters`). Subdomain -> parent linked via `tagged` edge; modules tagged with both domain and subdomain.

**Node types:** `root` | `package` | `module` | `capability` | `domain` | `service`.  
**Edge kinds (used):** `contains`, `imports`, `tagged`, `infra`, `consumes`, `uses_env`.

---

### Domains

Domains are **labels** attached to modules and services via `tagged` edges. They are inferred in several ways (all combined, no overwriting):

1. **Path-based**  
   From each module's `relativeFilePath`, take the first path segments that are **not** structural (`src`, `lib`, `shared`, `utils`, `components`, `hooks`, `pages`, `app`, `features`, `modules`, `services`, `internal`, `common`, `core`, `types`, `config`, `configs`, `constants`, `store`, `stores`, `contexts`, `providers`, `middleware`, `models`, `tests`, `__tests__`, `testing`, `mocks`, `fixtures`, `setup`, `adapters`, `interfaces`, `entities`, `repositories`, `use-cases`, `slices`, `queries`, `columns`). Each such segment becomes a domain slug (lowercase, hyphenated).  
   Example: `src/auth/session-manager.ts` -> domain `auth`; `src/auth/types/auth-types.ts` -> `auth` (not `auth-types`, because `types` is structural).  
   This works for any repo layout without project-specific keywords.

2. **Import clustering**  
   Build an undirected graph of modules linked by `imports` edges. Run **label propagation** (each node adopts the most frequent label among neighbors) to get clusters. Name each cluster by the most common path-based segment among its modules. Every module in the cluster is tagged with that cluster name.  
   So tightly coupled modules get an extra domain reflecting their "community".

3. **Content-based**  
   Hard-coded: modules with route definitions -> `domain:routing`; modules that reference env vars -> `domain:config`.

4. **Optional config**  
   If present, `repo-context/domains.config.json` or `.repo-context-domains.json` in repo root can define:
   ```json
   {
     "domainAliases": { "infra-k8s": ["infra-kubernetes", "k8s", "kubernetes"] },
     "patterns": [ { "pattern": "\\b(auth|oauth)\\b", "domain": "auth" } ]
   }
   ```
   - **patterns:** Each pattern is a regex (string) applied to the module's path; on match, that domain is added. Duplicates are not created.
   - **domainAliases:** Maps canonical domain label -> list of aliases. When a tool is called with a domain name (e.g. `get_domain_or_focus_context(domainOrNodeId: "kubernetes")`), the value is resolved to the canonical label (e.g. `infra-k8s`) so that querying by alias returns the same domain. Aliases are resolved at state build time (config loaded once into `AppState.domainsConfig`).

5. **Infra domains**  
   Infra modules and service nodes are tagged with domain nodes by kind: SAM/CloudFormation -> `domain:infra-sam`, Kubernetes/k3d -> `domain:infra-k8s`, Helm -> `domain:infra-helm`, Dockerfile -> `domain:infra-dockerfile`. Path-based config patterns (e.g. `^infrastructure/sam`) can add the same labels for code-side consistency.

### Domain Tiers

Each domain is classified into a **tier** after graph construction:

| Tier | Criteria | Examples |
|------|----------|---------|
| `business` | 5+ modules AND 2+ packages | auth, engine, formula-editor, dashboard |
| `feature` | 3+ modules OR (2+ modules AND 2+ packages) | validation, realtime, messaging |
| `layer` | label is a structural name (types, utils, config, etc.) | types, utils, config, testing |
| `technical` | everything else (1-2 modules, 1 package) | jest-config, vite-env-d |

Tiers are exposed in `get_domain_or_focus_context`, `get_domain_modules_slice`, and `get_annotation_coverage_stats` (`byTier` grouping).

### Subdomains

Business and feature domains with **10+ modules** get auto-generated subdomains by path prefix clustering. For example, `domain:auth` (55 modules) may produce: `domain:auth/oauth-adapters`, `domain:auth/session`, `domain:auth/middleware`, `domain:auth/client`.

Subdomains are `domain`-type nodes with `data.parent` pointing to the parent domain. Modules are tagged with both the parent domain and the subdomain. Subdomains are visible in `get_domain_or_focus_context` response.

**Server & config:** Port, host, and scan ignorePatterns are set in **`repo-context/repo-context.config.json`** (Zod-validated; env override).

---

## Stage 3: Semantic Annotations

Annotations are **AI-generated** and stored in `artifacts/annotations.json`. They are keyed by **node id** (usually module id). Each record has:

- `nodeId`, `nodeType`, `contentHash`, `pass`, `updatedAt`, `schemaVersion`, `semantic`.

**Semantic** includes: `summary` (required), and optionally `keyExports`, `assumptions`, `sideEffects`, `risks`, `patterns`, `flowDescription`, `invariants`, `extensionPoints`, and extension fields (`integrationPoints`, `stateShape`, `dataFlow`, `envDependencies`).

- **Freshness:** An annotation is *fresh* if its `contentHash` matches the current module hash **and** its `schemaVersion` is at least the engine's `CURRENT_ANNOTATION_SCHEMA_VERSION`. Otherwise it is *stale* (content changed or schema upgraded).
- **Merge on update:** When writing an annotation for a node that already has one, the new `semantic` object is **merged** into the existing one (`{ ...existing.semantic, ...incoming }`). So backfills can send only new fields.
- **Queue:** `get_modules_annotation_queue` returns modules that are unannotated or stale; priority formula: `(downstream x 2) + exports + (lines/200) - (qualityScore x 3)`. Modules with high downstream impact and low annotation quality are prioritized first. Each item includes `recommendedFields` listing which annotation fields are missing for the module type.
- **Quality scoring:** `computeAnnotationQuality()` rates each annotation 0-10 and classifies it as `minimal` (<2), `basic` (<5), `detailed` (<8), or `comprehensive` (8+). Missing fields are reported. Quality is included in `get_context_detail` responses (`semanticMeta.quality`).

Annotations are **not** tied to the set of domains; they are per-node. Adding more domains (more edges) does not invalidate annotations.

**Infra and services:** Annotations are supported for **infra module** nodes and **service** nodes (Lambda, SQS, K8s Deployment, etc.). For services, freshness is derived from the parent infra module's `contentHash`. The annotation queue and coverage stats include infra modules and services; the same `write_module_annotation` tool is used (by node id, e.g. `infra:helm:path/to/Chart.yaml` or `service:aws-lambda:MyFunction`).

### Orphaned Annotations

After structural changes (e.g. expanding STRUCTURAL_DIRS, which removes domain nodes), some annotations may reference nodes that no longer exist in the graph. These are **orphaned**.

- **Detection:** `refresh_repo_context` now reports orphaned annotation count and a warning. `get_orphaned_annotations` lists all orphaned entries with type, pass, and summary preview.
- **Cleanup:** `cleanup_orphaned_annotations` supports `preview` (dry run) and `remove` (delete with auto-backup) modes.
- **Auto-backup:** `AnnotationStore.flush()` creates a timestamped backup when >5% of entries are removed. Max 5 backups are retained (older ones are rotated out).
