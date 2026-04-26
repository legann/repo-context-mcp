# Repo Context Engine — quick reference

## ⛔ STOP — before doing anything in a non-trivial task

**First action: call MCP. Do not read files first.**

Call `get_domain_or_focus_context` (or `get_domain_modules_slice`) to get the module map, exports, dependencies, and annotations. This tells you **what to read and where**. Skip only for trivial single-file tasks.

If the call fails (connection error) — the HTTP MCP server is not running. **Stop and ask the user to start it** (`npm run mcp:http`). Do not fall back to reading files — without the graph you lack structure and dependency info.

---

Repo Context Engine, exposed as MCP server **repo-context**, provides **structure** (packages, modules, dependency graph, domains with **tier classification** and **subdomains**, **infra modules and services** — SAM, K8s, Helm, Dockerfile — with Lambda→code links and **runtime topology**: triggers, resource refs, data flows) and **semantic annotations** (summary, assumptions, risks, sideEffects) with **quality scoring**. **Domain aliases** (e.g. query by `kubernetes` or `k8s` → `infra-k8s`) are resolved from `domains.config.json`.

## How to call

Four MCP entries: **`repo-context-http`**, **`repo-context-stdio`**, **`repo-context-http-ui`**, **`repo-context-stdio-ui`** — see `.cursor/mcp.json`, `.mcp.json`, `.codex/config.toml`.

- **repo-context-http:** `npm run mcp:http` — MCP **3334**
- **repo-context-http-ui:** `npm run ui` — same MCP **3334** + viewer (**3112**); only one HTTP process at a time
- **repo-context-stdio** / **repo-context-stdio-ui:** IDE spawns `npm run mcp` / `npm run mcp:ui`

**Cursor:** long server id in `mcp_file_system_servers` (e.g. `project-*-repo-context-http`).

**Always pass `arguments` as valid JSON.** Missing or malformed `arguments` (e.g. `{ domainTag: "auth" }` without quotes) causes server crash. Use `{ "domainTag": "auth" }`.

## Cheat sheet

1. **Map** — `get_domain_or_focus_context` for domain overview (includes `tier`, `subdomains`); `get_domain_modules_slice` for full module list.
2. **Detail** — `get_context_detail` (no body) on 3–5 key modules; use **semantic** (with **quality** score) and **drill_down** to decide what to read.
3. **Then read** — only after that: `includeBody` / `grepBody` / Read by lineRange.
4. **Before changing types** — `get_dependency_impact` on the types module (see downstream and `uses[]`).
5. **Before adding env vars** — `get_env_vars_usage` (optionally `packageId`).
6. **Cross-package deps** — `get_cross_package_dependencies` for inter-package import analysis with symbol details and boundary violations.
7. **Runtime topology** — `get_runtime_topology` for Lambda triggers (API/SQS/Schedule), resource usage, and data flows between services.
8. **After you edit files** — call `refresh_repo_context` (now reports **orphaned annotations** count); use `get_orphaned_annotations` / `cleanup_orphaned_annotations` if needed.
9. **Infra** — domains `infra-sam`, `infra-k8s`, `infra-helm`, `infra-dockerfile` list IaC modules and service nodes; Lambda services link to code via edge `infra`. Use domain tag `infra-k8s` (or alias `kubernetes` / `k8s`) to get K8s/Helm/k3d context.

## Security

Do not store secrets in the graph or annotations. Repo Context Engine extracts only **env var names** from source; it never reads `.env` or env files.

---

**Full reference:** **`REPO_CONTEXT_REFERENCE.md`** in this package (tools, workflow, file-size rules, semantic annotation, limitations). It is **canonical** and does not depend on `.cursor/`. The Cursor rule **repo-context-reference** is only a pointer to that file.
