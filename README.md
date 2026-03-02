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
2. **Scans infra (IaC)** for SAM/CloudFormation, Helm, Kubernetes, and Dockerfiles.
3. **Structures the codebase** into a hierarchy: repo → packages → modules → exports (capabilities), plus infra modules and services. Modules and services are tagged with domains (e.g. auth, api, ui, infra-sam, infra-k8s) inferred from paths, import clusters, and optional config (including domain aliases, e.g. `kubernetes` → `infra-k8s`).
4. **Optionally layers AI annotations** (summaries, assumptions, risks) on top, persisted by node (modules, capabilities, domains, infra modules, services) and kept fresh via content hashes.

You get a single, queryable view of the repository - by domain, by module, by impact, or by annotation coverage.

**In-memory runtime:** Repository context is built and held **in memory**. The server builds once at startup and again when you call the MCP tool `refresh_repo_context` (e.g. after code changes).

---

## Architecture

Repository context is built in three stages: **syntactic snapshot** (ts-morph parse + infra IaC scan) → **semantic graph** (packages, modules, capabilities, domains, infra modules and services, Lambda→code links) → **semantic annotations** (AI-generated, optional). See [ARCHITECTURE.md](ARCHITECTURE.md) for details.

---

## MCP Tools

The server exposes these tools (call via MCP with the appropriate server id and `arguments`):

| Tool | Purpose |
|------|--------|
| `get_domain_or_focus_context` | Context by domain or focus id (modules, structure). |
| `get_domain_modules_slice` | Modules (and optionally consumers) for a domain tag. |
| `get_context_detail` | Detailed context for a module/export/domain (by id): drill_down, optional body, grepBody, includePrivate; plus semantic annotation if present and fresh. |
| `get_path_from_root` | Path from repo root to a given item (by id). |
| `search_repo_context` | Search repo context by name/query (modules, exports, domains). |
| `get_dependency_impact` | Upstream/downstream dependencies for a module or export. |
| `get_env_vars_usage` | Env var usage across packages. |
| `get_routes_map` | Routes and conditional renders (frontend/Lambda). |
| `get_interface_implementations` | Classes implementing a given interface. |
| `get_export_callees` | Direct callees inside an exported function/class. |
| `get_modules_annotation_queue` | Prioritized list of modules to annotate (optional domain filter). |
| `write_module_annotation` | Write or merge a semantic annotation for a module. |
| `get_annotation_coverage_stats` | Annotation coverage (total, fresh, stale, by domain). |
| `refresh_repo_context` | Re-run snapshot + graph build (e.g. after code change). |

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

