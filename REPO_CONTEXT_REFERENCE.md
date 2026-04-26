> **Canonical Repo Context Engine full reference** — MCP tools, workflow, file-size rules, semantic annotation, limitations. Lives in the **package root** next to `AGENTS.md`; safe to keep when `.cursor/` is stripped. **Quick start:** `AGENTS.md`.

---

# Repo Context Engine — structure, dependencies, and semantic context

**Universal rule:** Tool names, arguments, and workflow below apply to any MCP client (Cursor, Claude Code, etc.). Only the way you *invoke* the tools is client-specific — see "How to call" per your environment.

Repo Context Engine is exposed through the MCP server **`repo-context`** (four connections: `repo-context-http`, `repo-context-stdio`, `repo-context-http-ui`, `repo-context-stdio-ui`). It provides **three layers**: (1) **syntactic facts** — packages, modules, imports, exports, signatures, routes, env vars, infra resources, and content hashes; (2) **semantic graph** — deterministic nodes and edges for modules, capabilities, domains, services, runtime links, and dependencies; (3) **AI annotations** — the repository's initial semantic map, persisted in `repo-context/artifacts/annotations.json` and committed with the repository, including summaries, assumptions, risks, sideEffects, integration points, freshness, and quality. **HTTP** MCP is on **3334** (`mcp:http` or `ui`); stdio modes are client-spawned.

## Cheat sheet (before any file reading)

1. **Map** — `get_domain_modules_slice` or `get_domain_or_focus_context` for the domain.
2. **Detail** — `get_context_detail` (no body) on 3–5 key modules; use **semantic** and **drill_down** to decide what to read.
3. **Then read** — only after that: `includeBody` / `grepBody` / Read by lineRange.
4. **Before changing types** — call `get_dependency_impact` on the types module (see downstream and `uses[]`).
5. **Before adding env vars** — call `get_env_vars_usage` (optionally scoped by package); align naming and know which modules to touch.

## How to call (CRITICAL)

**In Cursor:** Use `CallMcpTool`. The server name is NOT the JSON key alone — Cursor uses a long identifier (e.g. `project-N-<workspace>-repo-context-http`). Find it: `mcps/*/SERVER_METADATA.json` → `serverIdentifier`, or from system prompt → `mcp_file_system_servers`.
```
CallMcpTool(server: "<serverIdentifier from mcps/>", toolName: "get_domain_modules_slice", arguments: { "domainTag": "example-domain" })
```

**In Claude Code (or other MCP clients):** Use your client's MCP tool. Call **`repo-context-http`**, **`repo-context-stdio`**, **`repo-context-http-ui`**, or **`repo-context-stdio-ui`**; use the **exact same** `toolName` and `arguments` as in the examples below. For HTTP, if down: **`npm run mcp:http`** or **`npm run ui`** in `repo-context` (**3334**).

**Common mistakes (all clients):**
- Calling without `arguments` → server receives `undefined` → crash. ALWAYS pass `arguments` with the required fields.
- **Malformed JSON in `arguments`** (missing double quotes, trailing comma, wrong key name) → parse error. Use valid JSON: `{ "domainTag": "auth" }` not `{ domainTag: "auth" }`.

## Security (secrets)

**Do not store secrets in the graph or annotations.** Repo Context Engine only extracts **env var names** from source (e.g. `process.env.X` → the identifier `X`). It never reads `.env`, `.env.local`, or any env files—only TypeScript/TSX source. Values and secrets must never be written into annotations or any persisted context.

## Availability check (BEFORE starting work)

**If the task depends on context from the graph, FIRST verify that MCP is available:**

1. Make a test call: `get_domain_modules_slice({ domainTag: "example-domain" })` or `get_domain_or_focus_context({ domainOrNodeId: "example-domain" })`.
2. If you get a response with modules — server is up, continue.
3. If connection error or timeout — the HTTP server is not running. **Tell the user** to start it: `npm run mcp:http` in `repo-context` (listens on **3334**). Do not start implementation without context from the graph if the task requires it.

## When to use

**Use Repo Context Engine MCP (`repo-context`) BEFORE reading files or searching the code** when the task involves:
- Understanding architecture: "how is X structured?", "what exists in the project?"
- Impact analysis: "what would a change to X affect?", "who depends on Y?"
- Navigation: "find the module that handles Z", "where is W defined?"
- Domain context: "show everything related to domain D"
- Studying contracts: signatures, types, interfaces, line ranges — WITHOUT reading files

**Domain overview:** `get_domain_or_focus_context(domainOrNodeId)` = simple list; `get_domain_modules_slice(domainTag, includeConsumers: true)` = full slice with consumers (prefer for "everything related to domain").

**Infra and domain aliases:** The graph includes **infra modules** (one per IaC file: SAM, CloudFormation, Helm Chart, K8s manifest, Dockerfile) and **service nodes** (one per resource: Lambda, SQS, K8s Deployment, Helm release, etc.). Lambda services have an **infra** edge to the TS module that implements the handler. Infra domains: `infra-sam`, `infra-k8s`, `infra-helm`, `infra-dockerfile`. You can query by **alias**: e.g. `domainTag: "kubernetes"` or `domainOrNodeId: "k8s"` resolve to `infra-k8s` (see `domainAliases` in `domains.config.json`). Use `get_domain_or_focus_context` or `get_domain_modules_slice` with these tags to get IaC context; `get_context_detail` works on infra module and service node ids (e.g. `infra:helm:.../Chart.yaml`, `service:aws-lambda:FunctionName`).

## Checklist before changing code

- **Before changing shared types** (union types, shared interfaces, etc.): call `get_dependency_impact` on the module that defines those types. Use **downstream** and **uses[]** to decide which modules to update; do not guess.
- **Before adding new env variables**: call `get_env_vars_usage` (optionally `packageId`). Align naming and know which modules to touch.

Full step-by-step: **Workflow** below.

## When to use Grep vs MCP

- **`search_repo_context`** — when you search by **module/symbol/type name**. Returns matching items (modules, exports, domains).
- **`get_context_detail(..., grepBody: "regex")`** — when you search **inside one known module**. Returns matching lines with context; no need to read the whole file.
- **Grep** — when you search a **string/pattern across the whole repo** and you do **not** yet know which module it lives in. Once you know the module, prefer `get_context_detail` + `grepBody` for that file.

**Pattern: how to explore a feature or integration by name (recommended):**

1. Use `search_repo_context` to find relevant domains and modules by keyword:
   - `CallMcpTool(server: "<id>", toolName: "search_repo_context", arguments: { "query": "feature-name" })`
2. Pick a **domain id** from the `domains` group (e.g. `domain:feature-x`) and call:
   - `get_domain_or_focus_context({ "domainOrNodeId": "feature-x" })` for a summary
   - `get_domain_modules_slice({ "domainTag": "feature-x", "includeConsumers": true })` for the full slice with consumers and dependencies
3. For any interesting module from these results, call:
   - `get_context_detail({ "nodeId": "mod:pkg/.../module", "includeBody": false })` to see exports, links, and semantic annotation before reading code

This pattern works the same for platform integrations (e.g. `"monday"`, `"notion"`) and any other feature name: search → pick domain/module → slice → detail.

Avoid duplicating: if you already have the module id from `get_domain_modules_slice` or `search_repo_context`, use `get_context_detail` + `grepBody` instead of Grep on that path.

## File size rules

**Small files (<50 lines):** just `Read` directly — MCP overhead isn't worth it for barrels, configs, etc.

**Large files (>200 lines): do NOT do a full Read.**
1. **Always first**: `get_context_detail` without body (or with narrow `grepBody`).
2. **Then only**: `includeBody: true` for **one** capability, or `Read(offset, limit)` by **lineRange** from drill_down.

**Huge single-function modules** (200+ lines): use `includeInternals: true` to get internal declarations (nested functions, variables, destructuring) with lineRange — like drill_down but one level deeper inside the function body. If that's not enough, follow up with `grepBody` for specific spots or `includeBody` with `bodyOffset`/`bodyLimit`.

## Known limitations

- **No directory listing** — MCP knows modules in the graph, not arbitrary filesystem paths. Use shell `ls` to check folder existence or structure.
- **No dependency versions** — `package.json` dependencies are not in the graph. Use `Read` on package.json.
- **Function internals are top-level only** — `includeInternals` extracts declarations from the function body's top-level statements. Nested blocks (if/for/try) are not traversed.

## Available tools

### `get_domain_or_focus_context` — start here
Get architectural context by domain or focus (id). For domains, response includes **`tier`** (`business` | `feature` | `layer` | `technical`) and **`subdomains`** (auto-generated for large business/feature domains with 10+ modules):
```
CallMcpTool(server: "<id>", toolName: "get_domain_or_focus_context", arguments: { "domainOrNodeId": "example-domain" })
→ { domain: "domain:auth", label: "auth", tier: "business", moduleCount: 55,
    subdomains: [{ id: "domain:auth/oauth-adapters", label: "auth/oauth-adapters", moduleCount: 5 }, ...],
    modules: [...] }
```

### `search_repo_context` — search by name or query
Search the Repo Context Engine graph by name, id, or type. **Multi-word queries** are split into tokens; an item matches if each token appears somewhere in its id, label, or (for capabilities) signature/typeValue/implementsInterfaces.

**Grouped results (default):** Without `nodeTypes`, results are grouped by type: `{ results: { domains: [...], modules: [...], services: [...], capabilities: [...] }, totalResults }`. Each group is capped at `maxResults/4` (min 3).

**Flat results (filtered):** With `nodeTypes: ["module", "domain"]`, returns flat list of only those types: `{ results: [...], totalResults }`.

```
CallMcpTool(server: "<id>", toolName: "search_repo_context", arguments: { "query": "module-name" })
CallMcpTool(server: "<id>", toolName: "search_repo_context", arguments: { "query": "ExportName", "nodeTypes": ["capability"] })
```
`/index` is not required; it is normalized automatically.

### `get_path_from_root` — where it lives in the system
Full path from root to the given item (by id) in one request:
```
CallMcpTool(server: "<id>", toolName: "get_path_from_root", arguments: { "focusId": "mod:pkg-name/path/to/module" })
```

### `get_context_detail` — detailed context (KEY tool)
Detail view (level-of-detail) for a module, export, or domain: children, links, symbol detail.

```
CallMcpTool(server: "<id>", toolName: "get_context_detail", arguments: { "nodeId": "mod:pkg-name/path/to/module" })
```

**For modules** — response includes `drill_down[]` with ALL exports. Each element:
```
{
  id: "cap:pkg/path/ExportName",
  label: "ExportName",
  type: "capability",
  symbolKind: "function" | "class" | "interface" | "type" | "const" | "enum",
  signature: "async doSomething(req, opts?): Promise<Result>",
  typeValue: "'a' | 'b' | 'c'",   // for type/enum/interface
  fields: [{ name: "id", type: "string", optional: false }],  // for interface
  implementsInterfaces: ["SomeInterface"],                     // for class
  calls: ["helper.process", "store.get"],  // for function/class
  lineRange: { start: 65, end: 310 }                        // lines in file!
}
```

**For capability** — full symbol detail: signature, params[], returnType, lineRange, typeValue, fields, calls.

**`includeBody: true`** — returns source code in the response, no separate Read:
```
CallMcpTool(server: "<id>", toolName: "get_context_detail", arguments: { "nodeId": "cap:.../SomeClass", "includeBody": true })
→ { signature: "class SomeClass", lineRange: {start:6, end:144}, body: "export class SomeClass {\n  ..." }
```
For capability: extracts lines by lineRange from file. For module: full file.

**Body pagination** — for large files:
```
get_context_detail({ nodeId: "mod:.../LargeModule", includeBody: true, bodyOffset: 20000, bodyLimit: 5000 })
→ { body: "...", bodyTotalChars: 85000, bodyHasMore: true, bodyNextOffset: 25000 }
```
Parameters: `bodyOffset` (default 0), `bodyLimit` (default 30000). Explicit pagination instead of truncation.

**`grepBody: "pattern"`** — regex search inside file/function without reading full body. Returns matching lines with ±3 lines of context:
```
CallMcpTool(server: "<id>", toolName: "get_context_detail", arguments: { "nodeId": "mod:.../LargeModule", "grepBody": "const handleSubmit" })
→ { grepMatches: [
    { line: 521, text: "  const handleSubmit = async (...) => {", isMatch: true },
    { line: 522, text: "    // implementation...", isMatch: false },
    ...
  ], grepTotalMatches: 2 }
```
**When to use grepBody instead of includeBody:** for large modules (>200 lines) when you need a specific spot without reading the whole file.

**IMPORTANT: use narrow patterns.** On large files (1000+ lines), broad OR-patterns can return 40+ matches and blow up the response. Instead, make 2–3 calls with specific terms per method/variable. Each returns a few matches — fast and cheap.

**`includePrivate: true`** — for class capability, adds private/protected methods and properties to drill_down:
```
CallMcpTool(server: "<id>", toolName: "get_context_detail", arguments: { "nodeId": "cap:.../SomeClass", "includePrivate": true })
→ drill_down: [
    { label: "internalHelper", symbolKind: "function", access: "private", signature: "(...): Promise<void>", lineRange: {...} },
    { label: "parseInput", symbolKind: "function", access: "private", signature: "(...): ...", lineRange: {...} }
  ]
```
Use for large classes (>200 lines) to see internal structure without reading the file.

**`includeInternals: true`** — for function/arrow-function capabilities (200+ lines), adds internal declarations to drill_down:
```
CallMcpTool(server: "<id>", toolName: "get_context_detail", arguments: { "nodeId": "cap:.../LargeComponent", "includeInternals": true })
→ drill_down: [
    { label: "handleSubmit", kind: "function", signature: "(data: FormData): Promise<void>", lineRange: {...}, internal: true },
    { label: "isLoading, setIsLoading", kind: "destructuring", lineRange: {...}, internal: true },
    { label: "formRef", kind: "variable", lineRange: {...}, internal: true }
  ]
```
Use for large function exports (200+ lines) to see internal structure without reading the body. Analogous to `includePrivate` for classes.

**ID normalization:** `/index` and extensions (`.ts`, `.tsx`) are stripped automatically.
`get_context_detail({ nodeId: "mod:.../barrel/index" })` and `get_context_detail({ nodeId: "mod:.../barrel" })` — same thing.

**Annotation quality** — `semanticMeta` now includes `quality` for annotated modules:
```
→ { semantic: {...}, semanticMeta: { pass: 3, updatedAt: "...", fresh: true,
    quality: { score: 7.5, tier: "detailed", missingFields: ["risks", "dataFlow"] } } }
```
Quality `score` 0-10, `tier`: `minimal` (<2) / `basic` (<5) / `detailed` (<8) / `comprehensive` (8+). `missingFields` shows what to add.

**`envVars`/`hasRoutes`** — for modules with env vars or route definitions:
```
→ { envVars: ["API_URL", "FEATURE_FLAG_X"], hasRoutes: true }
```

### `get_dependency_impact` — what a change would affect (ENRICHED)
Downstream (who depends on this) and upstream (what this depends on). Each item includes `uses[]` — which exports are imported:
```
CallMcpTool(server: "<id>", toolName: "get_dependency_impact", arguments: { "nodeId": "mod:pkg/path/types-module" })
→ downstream: [
    { id: "mod:.../consumer-a", uses: ["TypeA", "TypeB"] },
    { id: "mod:.../consumer-b", uses: ["TypeA"] }
  ]
```

**`exportName` filter** — narrow downstream to only consumers that import a specific export:
```
CallMcpTool(server: "<id>", toolName: "get_dependency_impact", arguments: { "nodeId": "mod:.../store-module", "exportName": "useMyStore" })
→ { filteredByExport: "useMyStore", downstream: [only modules importing useMyStore] }
```
Use when refactoring: "who exactly imports this one function?" in a single call instead of get_dependency_impact + N grepBody calls.

### `get_domain_modules_slice` — slice by feature/domain
All modules tagged with a domain + their dependencies, grouped by package:
```
CallMcpTool(server: "<id>", toolName: "get_domain_modules_slice", arguments: { "domainTag": "example-domain" })
```

**`includeConsumers: true`** — adds consumer modules (reverse dependencies) that import from domain modules but are not themselves tagged:
```
CallMcpTool(server: "<id>", toolName: "get_domain_modules_slice", arguments: { "domainTag": "example-domain", "includeConsumers": true })
→ { taggedModules: N, totalWithDeps: M, byPackage: {...},
    consumers: { count: K, byPackage: {
      "pkg:some-package": [
        { id: "mod:.../ConsumerA", label: "..." },
        { id: "mod:.../ConsumerB", label: "..." }
      ]
    }}
  }
```
Use when you need all files related to a domain, including consumers that are not tagged but depend on domain modules.

### `get_env_vars_usage` — env vars map
Which environment variables are used and in which modules. Can scope by package:
```
CallMcpTool(server: "<id>", toolName: "get_env_vars_usage", arguments: {})
CallMcpTool(server: "<id>", toolName: "get_env_vars_usage", arguments: { "packageId": "pkg:some-package" })
→ { envVars: { "API_URL": [{ moduleId: "...", moduleLabel: "..." }], ... } }
```
Use before adding new env vars: you see naming pattern and modules using similar variables.

**Limitation:** static analysis detects `process.env.X` at module level. It may miss env vars accessed via wrapper functions or framework-specific APIs. If `get_env_vars_usage` returns fewer vars than expected: first check `semantic.envDependencies` on the module (annotations may cover vars that static analysis misses); otherwise read the env config file directly.

### `get_routes_map` — frontend routes and backend endpoints
Extracts route definitions from frontend code and service endpoints from the graph.
Also shows **conditional renders** — components rendered outside route declarations (guest views, loading states, etc.):
```
CallMcpTool(server: "<id>", toolName: "get_routes_map", arguments: { "layer": "frontend" })
→ { frontend: {
    routes: [{ path: "/page", component: "PageComponent" }],
    conditionalRenders: [
      { component: "GuestView", condition: "!isReady", renderedIn: "Shell", moduleId: "mod:...", lineRange: {...} }
    ]
  }}
```
Use for full navigation picture: `routes` — declarative routes, `conditionalRenders` — imperative/conditional renders.

### `get_interface_implementations` — all implementations of an interface (D)
Find all classes implementing a given interface:
```
CallMcpTool(server: "<id>", toolName: "get_interface_implementations", arguments: { "interfaceName": "SomeInterface" })
→ { count: N, implementations: [
    { className: "ImplA", calls: ["helper.foo", "this.bar", ...] },
    { className: "ImplB", calls: ["fetch", "response.json", ...] }
  ]}
```
Use to understand implementation patterns before creating a new implementation.

### `get_export_callees` — calls inside a function (E)
Shows which functions/methods are called inside an export (1 level deep):
```
CallMcpTool(server: "<id>", toolName: "get_export_callees", arguments: { "nodeId": "cap:.../SomeClass" })
→ { calls: ["helper.get", "store.set", "request", "this.validate"] }
```
Only for exports ≤ 500 lines. Filters stdlib (console, JSON, Math, etc).

### `get_cross_package_dependencies` — inter-package imports
Show dependency edges between packages with import counts and key symbols:
```
CallMcpTool(server: "<id>", toolName: "get_cross_package_dependencies", arguments: {})
CallMcpTool(server: "<id>", toolName: "get_cross_package_dependencies", arguments: { "packageId": "pkg:@acme/api-service", "direction": "imports" })
→ { packages: ["pkg:A", "pkg:B"], edges: [
    { from: "pkg:A", to: "pkg:B", moduleEdges: 47, direction: "imports",
      topModuleEdges: [{ fromModule: "...", toModule: "...", symbols: ["authMiddleware", "checkAuth"] }] }
  ], boundaryViolations: [{ from: "...", to: "...", note: "Direct import bypasses public API" }] }
```
Use for understanding cross-package coupling, finding boundary violations, and planning refactors. `direction`: `"imports"` = what package imports, `"exports"` = what others import from package, `"both"` (default).

### `get_runtime_topology` — Lambda triggers, resources, data flows
Show runtime topology: how services are triggered, what resources they use, data flow through queues:
```
CallMcpTool(server: "<id>", toolName: "get_runtime_topology", arguments: {})
CallMcpTool(server: "<id>", toolName: "get_runtime_topology", arguments: { "scope": "auth" })
→ { scope: "all", services: [
    { id: "service:aws-lambda:FormulaManagerFunction", label: "FormulaManagerFunction",
      triggers: [{ type: "api", method: "GET", path: "/formula" }, { type: "sqs", queueRef: "ComputeQueue" }],
      resources: [{ id: "service:aws-dynamodb:FormulasTable", access: "read-write" }] }
  ], resources: [...], dataFlows: [{ from: "FuncA", through: "resource:sqs:Queue", to: "FuncB" }] }
```
`scope`: `"all"` (default), domain name, or package id. SAM parser extracts Events (Api/SQS/Schedule triggers) and Environment.Variables references (!Ref/!GetAtt → resource links).

### `get_modules_annotation_queue` — queue for semantic annotation
Get list of modules that need annotation (unannotated or **stale**):
- **stale** = file content changed (contentHash) **or** annotation is outdated by schema version.
- When new fields are added to the annotation contract, schema version is bumped; old annotations without the new version enter the queue with reason `"Schema outdated (v1 < v2), needs backfill"` — they need to be updated (backfill).
```
CallMcpTool(server: "<id>", toolName: "get_modules_annotation_queue", arguments: { "domain": "example-domain", "limit": 10 })
→ { items: [{ nodeId: "mod:...", status: "unannotated"|"stale", priority: 26, reason: "...",
    context: { topExports: [...], downstreamCount, totalLines },
    recommendedFields: ["dataFlow", "risks", "envDependencies"] }] }
```
Priority formula: `(downstream × 2) + exports + (lines/200) - (qualityScore × 3)`. Items with high downstream impact and low annotation quality are prioritized. `recommendedFields` tells which annotation fields are missing for this module type. Used by the annotator agent. Full instructions — section **«Semantic annotation»** below in this file.

### `write_module_annotation` — write a semantic annotation
Write an AI-generated annotation for a **module, capability, domain, infra module, or service**. **Merge on update:** if the item already has an annotation, the provided `semantic` object is **merged** with the existing one (`{ ...existing.semantic, ...incoming }`). You can send only new/changed fields (e.g. on backfill after schema extension). Node ids: `mod:...`, `cap:...`, `domain:...`, `infra:aws-sam:...`, `infra:helm:...`, `service:aws-lambda:...`, etc.

**Module annotation:**
```
CallMcpTool(server: "<id>", toolName: "write_module_annotation", arguments: {
  "nodeId": "mod:pkg/path/to/module",
  "semantic": {
    "summary": "Short description of what the module does (1–3 sentences).",
    "assumptions": ["Assumption about inputs or environment"],
    "sideEffects": ["writes: TABLE_NAME", "external: Some API"],
    "risks": ["What can go wrong or be slow"],
    "integrationPoints": "How to extend or integrate with this module",
    "envDependencies": { "ENV_VAR": "when it is required" }
  }
})
```

**Domain annotation** — annotate an entire domain with architectural context:
```
CallMcpTool(server: "<id>", toolName: "write_module_annotation", arguments: {
  "nodeId": "domain:example-domain",
  "semantic": {
    "summary": "What this domain is responsible for.",
    "assumptions": ["Architectural assumptions about this domain"],
    "risks": ["Cross-domain risks"],
    "integrationPoints": "How other domains interact with this one"
  }
})
```
Domain annotations are surfaced in `get_domain_or_focus_context` and `get_domain_modules_slice` responses. Use for architectural context that doesn't belong to any single module (boundaries, cross-domain dependencies, migration notes).

Response may include `merged: true` and `schemaVersion: N`. Annotations are persisted in `repo-context/artifacts/annotations.json`, committed with the repository, and served automatically via `get_context_detail`, `get_domain_or_focus_context`, and `get_domain_modules_slice`. Optional extension fields: `integrationPoints`, `stateShape`, `dataFlow`, `envDependencies` (see «Semantic annotation» section below).

### `get_annotation_coverage_stats` — annotation coverage
Stats: how many modules are annotated, **fresh** (content unchanged and schemaVersion current), **stale** (re-annotation or backfill needed), breakdown by domain and **by tier**:
```
CallMcpTool(server: "<id>", toolName: "get_annotation_coverage_stats", arguments: {})
→ { totalModules: N, annotated: M, fresh: K, stale: M-K,
    infraModules: { total, annotated, fresh }, services: { total, annotated, fresh },
    byDomain: { ... },
    byTier: { business: { domains: ["auth", ...], totalModules: 280 }, feature: {...}, layer: {...}, technical: {...} },
    domainAnnotations: { totalDomains, annotated, list } }
```
After extending the annotation schema, all old records are considered stale until the annotator is run again (backfill).

### `get_orphaned_annotations` — detect dead annotations
Find annotations whose node no longer exists in the graph (e.g. after STRUCTURAL_DIRS changes removed domains):
```
CallMcpTool(server: "<id>", toolName: "get_orphaned_annotations", arguments: {})
CallMcpTool(server: "<id>", toolName: "get_orphaned_annotations", arguments: { "nodeType": "domain" })
→ { total: 203, orphaned: [{ nodeId, nodeType, pass, summaryPreview, reason }], byType: { domain: 198, module: 3 } }
```

### `cleanup_orphaned_annotations` — remove dead annotations
Preview or remove orphaned annotations (creates auto-backup before deletion):
```
CallMcpTool(server: "<id>", toolName: "cleanup_orphaned_annotations", arguments: { "mode": "preview" })
→ { mode: "preview", wouldRemove: 203, wouldRemoveByType: { domain: 198, ... }, entries: [...] }

CallMcpTool(server: "<id>", toolName: "cleanup_orphaned_annotations", arguments: { "mode": "remove" })
→ { mode: "remove", removed: 203, removedByType: { domain: 198, ... } }
```

### `refresh_repo_context` — rebuild the graph
If code changed and you need a fresh graph. Now includes **orphaned annotations** detection:
```
CallMcpTool(server: "<id>", toolName: "refresh_repo_context", arguments: {})
→ { status: "rebuilt", before: {...}, after: {...},
    annotations: { total: 925, orphaned: 203, orphanedByType: { domain: 198 },
      warning: "203 annotations reference nodes that no longer exist..." } }
```
If `orphaned > 0`, run `get_orphaned_annotations` for details and `cleanup_orphaned_annotations` to resolve.

## Node types (id → type)
- `root` — repo root
- `pkg:name` — package
- `mod:pkg/path` — module (code file)
- `infra:kind:path` — infra module (IaC file: e.g. `infra:aws-sam:infrastructure/sam/template.yaml`, `infra:helm:.../Chart.yaml`)
- `cap:pkg/path/export` — capability (export with signature and line range)
- `service:provider:name` — service (infra resource: e.g. `service:aws-lambda:MyFunc`, `service:k8s-deployment:my-app`)
- `domain:name` — domain with **tier** (`business`/`feature`/`layer`/`technical`). Large business/feature domains have auto-generated **subdomains** (`domain:auth/oauth-adapters`). Infra domains: `infra-sam`, `infra-k8s`, `infra-helm`, `infra-dockerfile`.

### Where domains come from (no project-specific hardcoding)
1. **Path-based** — first non-structural path segment (`src/auth/...` → `auth`; skip `src`, `shared`, `utils`, `types`, `config`, `store`, `tests`, `adapters`, `interfaces`, `entities`, `repositories`, `use-cases`, etc.).
2. **Import clusters** — label propagation on the import graph; cluster name = most frequent path segment in the cluster.
3. **Infra** — infra modules and services are tagged by kind: SAM/CFN → `infra-sam`, Kubernetes/k3d → `infra-k8s`, Helm → `infra-helm`, Dockerfile → `infra-dockerfile`.
4. **Optional config** — extra domains from regex on paths; **domainAliases** for query resolution. Files: `repo-context/domains.config.json` or `.repo-context-domains.json`. Format: `{ "domainAliases": { "infra-k8s": ["k8s", "kubernetes"] }, "patterns": [ { "pattern": "\\\\b(segment1|segment2)\\\\b", "domain": "domain-name" } ] }`. Aliases resolve to canonical when calling tools (e.g. `domainTag: "kubernetes"` → `infra-k8s`).
5. **Tier classification** — each domain gets a tier: `business` (5+ modules, 2+ packages), `feature` (3+ modules), `layer` (types/utils/config/etc.), `technical` (everything else).
6. **Subdomains** — business/feature domains with 10+ modules get auto-generated subdomains by path prefix clustering (e.g. `domain:auth/oauth-adapters`).

## Edge types
- `contains` — hierarchy (root→pkg→mod→cap; root→infra module→service)
- `imports` — module imports module
- `tagged` — module or service is tagged with a domain; subdomain → parent domain
- `infra` — Lambda service node → TS module that implements the handler (deploys)
- `consumes` — SQS queue service → Lambda service triggered by that queue
- `uses_env` — Lambda service → resource service referenced via environment variable (!Ref/!GetAtt)

## Workflow (same as Cheat sheet, in order)

1. **Server id** — `mcp_file_system_servers` or `mcps/*/SERVER_METADATA.json`
2. **Availability** — test `get_domain_modules_slice` or `get_domain_or_focus_context`; if fail → tell user to run `npm run mcp:http` in `repo-context`
3. **Map** — `get_domain_modules_slice({ domainTag, includeConsumers: true })` → full module list for domain
4. **Detail** — `get_context_detail` (no body) on **3–5 key modules** (e.g. most imported or central to task) → drill_down + semantic
5. **Plan reads** — use semantic/drill_down to decide where `includeBody` / `grepBody` / Read; then only those
6. **Types/env** — see **Checklist** above (get_dependency_impact for types, get_env_vars_usage for env)
7. **Patterns** — `get_interface_implementations`, `get_export_callees`; routes → `get_routes_map`; search in file → `grepBody`; large class internals → `includePrivate: true`; large function internals → `includeInternals: true`
8. **Targeted read** — `includeBody: true` (or bodyOffset/bodyLimit) or Read by lineRange from drill_down

### How to use includeBody and lineRange to save tokens

**Option 1 (recommended): `includeBody: true`**
```
get_context_detail({ nodeId: "cap:.../SomeClass/methodName", includeBody: true })
→ body contains the function code — no separate Read!
```

**Option 2: lineRange → targeted Read**
```
get_context_detail({ nodeId: "mod:pkg/path/to/module" }) → drill_down[].lineRange
Read("path/to/module.ts", offset=lineRange.start, limit=lineRange.end - lineRange.start)
```
For files >200 lines see **Large files** above.

### Recommendations

- **Batch calls** — `get_context_detail` on 3–5 modules in parallel (one message, multiple CallMcpTool). Same for `includeBody` calls. Cuts wall-clock time significantly.
- **Semantic annotations are high-value** — `semantic.assumptions` prevents wrong reuse; `semantic.integrationPoints` shows exactly where to add new methods; `semantic.patterns` explains architecture without reading code.
- **grepBody** — narrow patterns per method, not one broad regex (see grepBody docs above).
- **lineRange** — Read(offset, limit) for the needed export from drill_down; easier for search_replace.
- **get_dependency_impact / get_env_vars_usage** — see **Checklist** and Workflow steps 5–6.

### Anti-pattern (DO NOT)

Do not read full files (or many files in a row) without `get_context_detail` (no body) first. **Good:** detail view (drill_down + semantic) → then only includeBody / grepBody / Read by lineRange where needed.

## Semantic annotation (initial semantic map)

Use this workflow to create or maintain the repository's semantic map. The annotator agent works through the queue, reads relevant modules, and writes explanations back to graph nodes. The result is committed in `repo-context/artifacts/annotations.json` and loaded by future agents before implementation work. Same server identifier; tools: `get_modules_annotation_queue`, `write_module_annotation`, `get_annotation_coverage_stats`.

### Workflow

1. **Check coverage** — `get_annotation_coverage_stats({})`. On a first run, this shows what is missing from the initial semantic map. For maintenance, start with the least covered domain or the one specified by the user.
2. **Queue** — `get_modules_annotation_queue({ domain: "example-domain", limit: 10 })`. First **stale** (content changed or schema outdated → backfill), then unannotated by descending downstream. In `reason`: `"Schema outdated (v1 < v2), needs backfill"` or `"Content changed since last annotation"`. For simple modules, `context.topExports` is often enough.
3. **For each module:** when `totalLines < 50` and `exportCount <= 3` annotate from `topExports`; otherwise — `get_context_detail({ nodeId, includeBody: false })` or with `grepBody`/`includeBody`. Write the annotation and call `write_module_annotation`.
4. **Repeat** — after saving, modules leave the queue. Continue until the queue is empty.

### Stale (content changed) — point merge: yes

**When updating stale always do a point merge (yes).** Do not overwrite the entire `summary` or entire `keyExports` — change only what actually changed in the code. Take current annotation from the detail view and do `keyExports = { ...existing.keyExports, "NewExport": "…" }`. Otherwise you lose detail (export count, other keys). Forbidden: taking `semantic` from the detail view and sending it to `write_module_annotation` unchanged just to "update the hash".

### Backfill (schema extended)

When reason is **"Schema outdated, needs backfill"**: call `get_context_detail({ nodeId })`, extend the annotation with new fields (`integrationPoints`, `stateShape`, `dataFlow`, `envDependencies`), call `write_module_annotation` with **only new/updated fields** — the server will merge with the existing annotation.

### Annotation format

- **Required:** `summary` (1–3 sentences).
- **Recommended:** `keyExports`, `assumptions`, `sideEffects`, `risks`.
- **Optional:** `patterns`, `flowDescription`, `invariants`, `extensionPoints`.
- **Extension (backfill):** `integrationPoints`, `stateShape`, `dataFlow`, `envDependencies`.

### Quality rules

Concrete names (classes, methods, tables); honesty; brevity; assumptions and risks are most valuable for agents. Do not read files via Read — MCP only. Stale = semantic update, not re-save. Work in batches of 10 modules.

### Strategy by module type

Types/interfaces → summary + keyExports. Adapters → summary, assumptions, sideEffects, patterns. Managers/services → summary, assumptions, sideEffects, risks. UI → summary, assumptions, sideEffects. API/serverless handlers → summary, flowDescription, sideEffects, risks.

## Graph dump

For offline analysis or passing to other tools:

```bash
npm run dump              # from this package root — writes .cache/graph.yaml + .cache/graph.json
npm run dump -- --yaml    # YAML only
npm run dump -- --json    # JSON only
```

(In a monorepo you may invoke the same script via `npm run dump --prefix repo-context`.)

Files in `.cache/` under this package. Structure: `meta` → `domains` → `services` → `packages` → `modules` → `exports` (with signature, lineRange).
