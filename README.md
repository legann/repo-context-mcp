# Repo Context Engine

A local Context Engine for AI coding agents.

Repo Context Engine turns a repository into a structured, queryable semantic graph exposed through MCP. It gives an AI agent precise, task-relevant context: modules, exports, imports, dependencies, domains, runtime topology, routes, environment usage, infrastructure links, and semantic annotations.

The goal is simple: help agents understand where and how to make changes before and during implementation.

## Core idea

AI coding agents need context, but reading files blindly pollutes the context window.

If an agent reads too little, it misses architectural relationships. If it reads too much, useful signal gets buried under unrelated source, stale assumptions, and implementation details that do not matter for the task.

Repo Context Engine takes a different approach: it builds a structured model of the repository and lets the agent request focused context slices when needed.

## Responsibility boundary

Repo Context Engine is focused on repository understanding, not final verification.

It helps agents answer questions such as:

- Which modules are relevant to this task?
- What imports, exports, routes, services, and infrastructure resources are involved?
- What domains or capabilities does this code belong to?
- What downstream code may depend on this module?
- What semantic annotations, assumptions, risks, or invariants should the agent know before editing?
- Where should the agent look next?

The agent applies edits to the real working directory using its normal coding tools.

The optional UI adds a human-facing view of the same repository graph. It helps developers inspect structure, relationships, and annotations visually, and can serve as wiki-style documentation for the repository.

## What this is not

Repo Context Engine is not:

- a replacement for git diff;
- a code review tool;
- a test runner;
- a CI system;
- a live file watcher;
- an autonomous patch validator;
- a long-term memory system detached from the repository.

After implementation, validation remains part of the standard engineering workflow: git diff, code review, tests, type checks, linters, runtime checks, and CI/CD.

## Context model

Repo Context Engine is intentionally not live by default.

AI agents should not chase a continuously changing codebase while editing it. The engine provides a stable semantic view of the working directory for the duration of a task, so the agent can reason from a consistent repository model while applying changes.

This avoids mixing:

- the original repository structure;
- partially applied edits;
- stale semantic annotations;
- unrelated working-tree changes;
- newly generated context from an intermediate state.

When the developer or agent needs updated repository knowledge, the context can be refreshed explicitly.

## Architecture summary

Repo Context Engine separates repository knowledge into several layers:

1. **Syntactic facts**
   Deterministic extraction from source code and infrastructure files: files, packages, modules, imports, exports, signatures, routes, environment variables, and content hashes.

2. **Semantic graph**
   A deterministic graph built from the snapshot: root, packages, modules, capabilities, domains, infra modules, services, and edges such as `contains`, `imports`, `tagged`, `infra`, `consumes`, and `uses_env`.

3. **AI annotations**
   The initial semantic map written by an AI agent after the graph is built. The agent works through the annotation queue, reads the relevant modules, and writes persisted explanations attached to graph nodes in `repo-context/artifacts/annotations.json`: summaries, assumptions, risks, invariants, side effects, extension points, implementation notes, freshness metadata, and quality scoring. Agents use this layer to understand relationships and architectural intent that are not obvious from deterministic graph edges alone.

The first two layers are rebuilt locally in memory when the MCP server starts or `refresh_repo_context` runs. The annotation layer is persisted in the repository and loaded on top of the current graph.

For deeper architecture details, see [ARCHITECTURE.md](ARCHITECTURE.md).

## Supported languages and clients

- **Parsed codebase:** TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`).
- **Client:** Typically an AI agent (e.g. in Cursor) that uses MCP to query the repository context and do the work - investigation, feature implementation, refactors. Any MCP-capable client can connect.

---

## Supported IaC (infrastructure as code)

Repo Context Engine **recursively scans the repository** and parses **candidate files** into infra **modules** and **service** nodes on the semantic graph. Supported kinds:

| Kind | Typical files | What is extracted |
|------|----------------|-------------------|
| **AWS SAM / CloudFormation** | `.yaml` / `.yml` with `Transform: AWS::Serverless-*` or a `Resources` map | **Lambda** (`AWS::Serverless::Function`, `AWS::Lambda::Function`), **SQS**, **SNS**, **DynamoDB**, **REST/HTTP API**, **S3**, **IAM roles** (as resources). **Events:** API, SQS, Schedule (and similar). **Environment:** `!Ref` / `!GetAtt` to other resources; **merge** of `Globals.Function.Environment` with each function. **Cross-template links:** after all templates are loaded, **deferred** `uses_env` and `consumes` edges so Lambdas in one file can point to queues/tables declared in another (nested stacks). **IAM:** DynamoDB table refs inside `Policies` / `AWS::IAM::ManagedPolicy` are turned into extra `uses_env` where resolvable. **Parameters** named `*TableName` / `*TableArn` are resolved to table resources when the real logical id is `*Table`. |
| **Kubernetes** | Manifests under scanned trees (e.g. `.yaml` with `apiVersion` / `kind`) | Deployments, services, and related workload resources (as **k8s-** service kinds). |
| **Helm** | `Chart.yaml` / `Chart.yml` | Chart metadata as a **helm-release** style resource. |
| **Dockerfile** | `Dockerfile`, `Dockerfile.*` | First **FROM** image reference. |

**Not supported today:** Terraform / Pulumi / CDK as first-class parsers (only if they emit YAML/JSON that already matches one of the parsers above).

**Configuration** (`domains.config.json` next to this package, or `.repo-context-domains.json` at repo root):

- **`infraExclude`** — repo-root-relative path fragments; matching IaC files are skipped (e.g. omit a root template if you only use nested stacks).
- **`lambdaBundleScripts`** — paths to **esbuild-style** bundle scripts (`entryPoint` + `outputFile` lists) so SAM `Handler` paths that differ from `src/` still resolve to TypeScript modules for **`infra`** edges.

---

## Repository extraction

No manual tagging or mapping is required. Repo Context Engine:

1. **Parses the repository** with **ts-morph** to build a syntactic snapshot: imports and exports, function/class/interface signatures (params, return types), and content hints (routes, env vars, conditional UI) extracted from the source.
2. **Scans infra (IaC)** — see **[Supported IaC](#supported-iac-infrastructure-as-code)** for file types, resource kinds, Globals merge, deferred cross-template links, and config.
3. **Structures the codebase** into a hierarchy: repo → packages → modules → exports (capabilities), plus infra modules and services. Modules and services are tagged with **tiered domains** (`business` | `feature` | `layer` | `technical`) inferred from paths, import clusters, and optional config. Large domains get auto-generated **subdomains** by path prefix clustering. Domain aliases (e.g. `kubernetes` → `infra-k8s`) are supported via config.
4. **Maps runtime topology** — Lambda triggers, resource usage (DynamoDB, SQS), and data flows between services through queues.
5. **Layers AI annotations** (summaries, assumptions, risks) on top, persisted by node and kept fresh via content hashes. Annotation **quality scoring** (0–10) identifies gaps; an annotation queue prioritizes modules by downstream impact and quality.
6. **Manages annotation lifecycle** — detects orphaned annotations after structural changes, supports preview/cleanup with auto-backup.

## MCP Tools

The server exposes these tools (call via MCP with the appropriate server id and `arguments`):

### Navigation & Context

| Tool | Purpose |
|------|--------|
| `get_domain_or_focus_context` | Context for a domain or focus id — modules, tiering, subdomains. |
| `get_domain_modules_slice` | Module slice for a domain tag (ex. optional consumer side, tier metadata). |
| `get_context_detail` | Rich detail for a module, export, or domain — structured drill-down, optional source reads, semantic annotation (ex. quality score). |
| `get_path_from_root` | Repo-root-relative path for a graph item by id. |
| `search_repo_context` | Text search over the graph; grouped hits (ex. domains, modules, services) and optional type filter. |

### Dependency Analysis

| Tool | Purpose |
|------|--------|
| `get_dependency_impact` | Who imports whom around a symbol or module (ex. upstream/downstream, optional export filter). |
| `get_cross_package_dependencies` | Imports that cross package boundaries (ex. symbol-level edges, boundary checks). |
| `get_runtime_topology` | How deployed services connect at runtime. |

### Code Structure

| Tool | Purpose |
|------|--------|
| `get_env_vars_usage` | Where configured environment variables appear in scanned code. |
| `get_routes_map` | HTTP routes and conditional UI surfaces found in the scan (ex. web app, API handlers). |
| `get_interface_implementations` | Implementations of a named interface. |
| `get_export_callees` | Callees reachable from an exported function or class. |

### Annotations

| Tool | Purpose |
|------|--------|
| `get_modules_annotation_queue` | Ordered list of modules worth annotating (ex. quality-based rank, suggested fields). |
| `write_module_annotation` | Create or merge a semantic annotation on a node. |
| `get_annotation_coverage_stats` | How much of the graph is annotated (ex. freshness, breakdown by domain or tier). |
| `get_orphaned_annotations` | Annotations that no longer match any live graph node. |
| `cleanup_orphaned_annotations` | Preview or delete orphaned records (ex. dry-run, auto-backup). |

### Maintenance

| Tool | Purpose |
|------|--------|
| `refresh_repo_context` | Rebuild snapshot and graph from the working tree (ex. after edits; reports orphan counts). |

Annotation fields are also returned through the context/navigation tools, not only through the annotation tools:

- `get_domain_or_focus_context` and `get_domain_modules_slice` return domain-level `semantic` and `semanticMeta` when a domain has an annotation.
- `get_context_detail` returns module, capability, domain, infra, or service `semantic` plus `semanticMeta`; annotated modules can include `semanticMeta.quality` with `score`, `tier`, and `missingFields`.
- `get_context_detail` for modules also returns `drill_down[]` with exports, signatures, calls, and `lineRange`, so agents can use annotation context and symbol structure before reading source.

This server follows the [MCP specification — Tools (2024-11-05)](https://modelcontextprotocol.io/specification/2024-11-05/server/tools):

---

## IDE / Agent integration (Cursor, Claude Code, Codex)

The server names below match **`.cursor/mcp.json`**, **`.mcp.json`**, and **`.codex/config.toml`** in this repo (and the parent repository root when this package is nested inside a larger project). Keep those files in sync when you change commands or ports.

| Name | How you run it | MCP URL / transport |
|------|----------------|---------------------|
| **repo-context-http** | `npm run mcp:http` | `http://localhost:3334` |
| **repo-context-http-ui** | `npm run ui` (`--http --ui`) | Same **3334** + viewer on **UI_PORT** (default **3112**) |
| **repo-context-stdio** | IDE spawns `npm run mcp` | stdio |
| **repo-context-stdio-ui** | IDE spawns `npm run mcp:ui` | stdio + viewer |

Only **one** process can bind MCP port **3334** — use either **http** or **http-ui**, not both at once.

**Configuration:** `repo-context/repo-context.config.json` — server (port, host), scan (ignorePatterns), verbose. Optional `domains.config.json` — path→domain patterns and domain aliases (e.g. `kubernetes` → `infra-k8s`).

| Client | MCP config | Rules / instructions |
|--------|------------|----------------------|
| **Cursor** | `.cursor/mcp.json` | `.cursor/rules/*.mdc` (IDE rules) |
| **Claude Code** | **`.mcp.json`** at repo root ([MCP scopes](https://code.claude.com/docs/en/mcp#project-scope)) | Root **`CLAUDE.md`** imports **`AGENTS.md`** via `@AGENTS.md` ([memory](https://code.claude.com/docs/en/memory.md#agentsmd)). Optional topic splits: **`.claude/rules/*.md`** ([rules](https://code.claude.com/docs/en/memory.md#organize-rules-with-clauderules)). |
| **Codex** | **`.codex/config.toml`** `[mcp_servers.*]` ([config](https://developers.openai.com/codex/config-reference)) | Root **`AGENTS.md`** ([agents-md guide](https://developers.openai.com/codex/guides/agents-md)); `project_doc_max_bytes` raised in `.codex/config.toml` so the full guide fits. |

**Quick policy** lives in **`AGENTS.md`**; the **full** tool/workflow/annotation reference is **`REPO_CONTEXT_REFERENCE.md`** in this package (canonical, no `.cursor/` required). When you change workflow or tool docs, update those files and keep **`.cursor/rules/repo-context*.mdc`** pointers in sync.

- **Cursor:** Open this repo as the workspace; project rules and MCP config load from the paths in the table above. Enable only the servers you need in **Settings → MCP** (HTTP vs stdio; with or without UI — see the first table).
- **Claude Code:** Approve project-scoped servers when prompted. Agent instructions: `CLAUDE.md` → `AGENTS.md`.
- **Codex:** Stdio-based entries are started by Codex; for HTTP-based entries you must start the MCP process yourself (commands and URL in the first table) before calling tools.
- **Other MCP clients:** Mirror the same commands, URLs, tool names, and `arguments` shape as in those config files and in `AGENTS.md`.

---

## Workflow

The steps below apply to whichever mode you use (stdio or HTTP). For stdio, the client starts the server on first use; for HTTP, you start it before using the tools.

1. **Start the server** (HTTP only; with stdio the MCP client starts it automatically)  
   On startup the server builds the syntactic snapshot and semantic graph **in memory** and loads annotations from `artifacts/annotations.json`. **On first run** (when Repo Context Engine has no annotations yet) run the annotation step below to populate annotations.

2. **Creating the initial semantic map** — have the agent call **`get_modules_annotation_queue`** to start the annotation process (after first start or when the queue has new/stale modules).
   The agent uses the queue returned by that tool, gets context for each module (`get_context_detail` — exports, signatures, domains), reads module files when needed, then writes semantic annotations via `write_module_annotation`. Repeat until the queue is empty or the batch is done. This creates the repository's semantic map: persisted explanations in `artifacts/annotations.json` that future agents load before implementation work.

3. **When a feature is implemented and changes are committed**  
   The graph in memory does not auto-update automatically. To bring it in line with the latest changes and keep annotations useful:
   - **Rebuild the graph:** call the MCP tool `refresh_repo_context` (rebuilds snapshot + graph in place). New and changed modules will appear; removed modules drop out.
   - **Update annotations:** new modules have no annotation; changed modules become *stale* (content hash mismatch). Have the agent call **`get_modules_annotation_queue`** again, then for each item use `get_context_detail` and (optionally) read module files → `write_module_annotation`.

---

## Export (Dump)

`npm run dump` runs the same snapshot + graph build as the MCP server and serializes the result to `.cache/graph.yaml` and `.cache/graph.json`. The output is a **snapshot of the repo at the time you run it** (not kept in sync afterwards). Use it for offline inspection, scripts, or passing context to other tools without running the server. Options: `--yaml` or `--json` to write only one format.

---
