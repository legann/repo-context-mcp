# Repo Context

**Structured, queryable repository context for AI agents.** The main goal is to **reduce how much context you need** to assemble for tasks that involve complex dependencies and many links across the repo (e.g. a monorepo with many packages): instead of loading full files, the agent queries only what it needs (slices by domain, impact, annotations) over MCP for targeted code understanding.

---

## Supported languages and clients

- **Parsed codebase:** TypeScript and JavaScript (`.ts`, `.tsx`, `.js`, `.jsx`).
- **Client:** Typically an AI agent (e.g. in Cursor) that uses MCP to query the repository context and do the work - investigation, feature implementation, refactors. Any MCP-capable client can connect.

---

## Overview

No manual tagging or mapping is required. Repo-context:

1. **Parses the repository** with **ts-morph** to build a syntactic snapshot: imports and exports, function/class/interface signatures (params, return types), and content hints (routes, env vars, conditional UI) extracted from the source.
2. **Scans infra (IaC)** for SAM/CloudFormation, Helm, Kubernetes, and Dockerfiles — including **event triggers** (API Gateway, SQS, Schedule) and **environment variable references** (!Ref/!GetAtt to resources).
3. **Structures the codebase** into a hierarchy: repo → packages → modules → exports (capabilities), plus infra modules and services. Modules and services are tagged with **tiered domains** (`business` | `feature` | `layer` | `technical`) inferred from paths, import clusters, and optional config. Large domains get auto-generated **subdomains** by path prefix clustering. Domain aliases (e.g. `kubernetes` → `infra-k8s`) are supported via config.
4. **Maps runtime topology** — Lambda triggers, resource usage (DynamoDB, SQS), and data flows between services through queues.
5. **Layers AI annotations** (summaries, assumptions, risks) on top, persisted by node and kept fresh via content hashes. Annotation **quality scoring** (0–10) identifies gaps; an annotation queue prioritizes modules by downstream impact and quality.
6. **Manages annotation lifecycle** — detects orphaned annotations after structural changes, supports preview/cleanup with auto-backup.

You get a single, queryable view of the repository — by domain, by module, by impact, by runtime topology, or by annotation quality.

**In-memory runtime:** Repository context is built and held **in memory**. The server builds once at startup and again when you call the MCP tool `refresh_repo_context` (e.g. after code changes).

---

## Architecture

Repository context is built in three stages: **syntactic snapshot** (ts-morph parse + infra IaC scan with triggers/resource refs) → **semantic graph** (packages, modules, capabilities, tiered domains with subdomains, infra services, runtime topology) → **semantic annotations** (AI-generated, quality-scored, with orphan management). See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

---

## MCP Tools

The server exposes these tools (call via MCP with the appropriate server id and `arguments`):

### Navigation & Context

| Tool | Purpose |
|------|--------|
| `get_domain_or_focus_context` | Context by domain or focus id — modules, tier, subdomains. |
| `get_domain_modules_slice` | Modules (and optionally consumers) for a domain tag, with tier. |
| `get_context_detail` | Detailed context for a module/export/domain: drill_down, optional body/grepBody/includePrivate; annotation with quality score. |
| `get_path_from_root` | Path from repo root to a given item (by id). |
| `search_repo_context` | Search by name/query — results grouped by type (domains, modules, services, capabilities); optional `nodeTypes` filter. |

### Dependency Analysis

| Tool | Purpose |
|------|--------|
| `get_dependency_impact` | Upstream/downstream dependencies with `uses[]` and optional `exportName` filter. |
| `get_cross_package_dependencies` | Inter-package import edges with symbol details and boundary violation detection. |
| `get_runtime_topology` | Lambda triggers (API/SQS/Schedule), resource usage, data flows between services. |

### Code Structure

| Tool | Purpose |
|------|--------|
| `get_env_vars_usage` | Env var usage across packages. |
| `get_routes_map` | Routes and conditional renders (frontend/Lambda). |
| `get_interface_implementations` | Classes implementing a given interface. |
| `get_export_callees` | Direct callees inside an exported function/class. |

### Annotations

| Tool | Purpose |
|------|--------|
| `get_modules_annotation_queue` | Prioritized queue with quality-based ranking and `recommendedFields`. |
| `write_module_annotation` | Write or merge a semantic annotation for a node. |
| `get_annotation_coverage_stats` | Coverage stats: total/fresh/stale, by domain, by tier. |
| `get_orphaned_annotations` | Detect annotations whose node no longer exists in the graph. |
| `cleanup_orphaned_annotations` | Preview or remove orphaned annotations (with auto-backup). |

### Maintenance

| Tool | Purpose |
|------|--------|
| `refresh_repo_context` | Re-run snapshot + graph build; reports orphaned annotations. |

---

## Running



**MCP server - two modes:**

- **stdio (default):** You do **not** start the server yourself; add this repo to your MCP client (e.g. Cursor via `.cursor/mcp.json`). The client spawns the process when needed and talks over stdin/stdout.
- **HTTP:** `npm run mcp:http`. Start the server yourself; it listens on port **3334** (configurable). Point your MCP client at `http://localhost:3334` (e.g. for debugging or multi-client access).

**Configuration:** `repo-context/repo-context.config.json` — server (port, host), scan (ignorePatterns), verbose. Optional `domains.config.json` — path→domain patterns and domain aliases (e.g. `kubernetes` → `infra-k8s`).

---

## Workflow

The steps below apply to whichever mode you use (stdio or HTTP). For stdio, the client starts the server on first use; for HTTP, you start it before using the tools.

1. **Start the server** (HTTP only; with stdio the MCP client starts it automatically)  
   On startup the server builds the syntactic snapshot and semantic graph **in memory** and loads annotations from `artifacts/annotations.json`. **On first run** ( when the repo context  has no annotations yet ) run the annotation step below to populate annotations.

2. **Creating annotations** — have the agent call **`get_modules_annotation_queue`** to start the annotation process (after first start or when the queue has new/stale modules).  
   The agent uses the queue returned by that tool, gets context for each module (`get_context_detail` — exports, signatures, domains), reads module files when needed, then writes semantic annotations via `write_module_annotation`. Repeat until the queue is empty or the batch is done. Annotations are persisted in `artifacts/annotations.json` and loaded on the next server start.

3. **When a feature is implemented and changes are committed**  
   The graph in memory does not auto-update automatically. To bring it in line with the latest changes and keep annotations useful:
   - **Rebuild the graph:** call the MCP tool `refresh_repo_context` (rebuilds snapshot + graph in place).New and changed modules will appear; removed modules drop out.
   - **Update annotations:** new modules have no annotation; changed modules become *stale* (content hash mismatch). Have the agent call **`get_modules_annotation_queue`** again, then for each item use `get_context_detail` and (optionally) read module files → `write_module_annotation`.

---

## Cursor integration (`.cursor/rules/` and `.cursor/mcp.json`)

This repo includes **rules and MCP config** under `.cursor/` (Cursor convention):

- **`.cursor/rules/repo-context.mdc`**  -  short rule (how to call MCP, cheat sheet, security).  
- **`.cursor/rules/repo-context-reference.mdc`**  -  full reference (all tools, workflow, annotation).  
- **`.cursor/mcp.json`**  -  MCP server config (stdio + HTTP).

Open the repo in Cursor and rules + MCP are picked up automatically. For other IDEs or MCP clients, copy the rule content and configure the server (e.g. stdio command or HTTP URL) as needed.

- **Cursor:** The repo-context MCP server is usually configured via the project (e.g. `mcps/` or Cursor MCP settings). Ensure it is enabled; the agent finds the server identifier in the environment.
- **Claude Code (and other MCP clients):** Add the repo-context MCP server in your client's settings: for HTTP point at port **3334** (and run `npm run mcp:http` yourself); for stdio use the repo path and command `npm run mcp`. The AI agent uses the same tool names and arguments as documented in the rule; no extra setup on the agent side.
---

## Export (Dump)

`npm run dump` runs the same snapshot + graph build as the MCP server and serializes the result to `.cache/graph.yaml` and `.cache/graph.json`. The output is a **snapshot of the repo at the time you run it** (not kept in sync afterwards). Use it for offline inspection, scripts, or passing context to other tools without running the server. Options: `--yaml` or `--json` to write only one format.

---

