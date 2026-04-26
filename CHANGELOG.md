# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.3.0] - 2026-04-26

### Added
- **UI graph browser** (optional, `npm run ui` / `mcp:ui`, `UI_PORT`): browser viewer for the live repo graph (domains, modules, services, infra) — explore and search, inspect node details, shareable links, exports (image / JSON), live refresh when context is rebuilt. Use it as a **visual map** of the repository and as **living documentation** that reflects the repository.
- **Claude Code & Codex support** — project-scoped MCP configs shipped with the package: **`.mcp.json`** for Claude Code, **`.codex/config.toml`** `[mcp_servers.*]` for Codex (same four server names, HTTP **3334**, stdio commands as Cursor). **`CLAUDE.md`** loads **`AGENTS.md`** via `@AGENTS.md`; quick workflow and policy stay in **`AGENTS.md`**.
- **`repo-context.config.json`** — optional package-local config (Zod-validated) for **HTTP server** bind address/port (overridable via `REPO_CONTEXT_PORT`), **`scan.ignorePatterns`** for extra paths to skip when indexing the repo.

### Changed
- **Agent documentation (to support Claude Code, Codex, and Cursor together):** long-form MCP guide is **`REPO_CONTEXT_REFERENCE.md`** at package root (tools, workflow, file-size rules, semantic annotation, limitations); **`AGENTS.md`** is **quick reference only**. When this package sits in a monorepo, host **`AGENTS.md`** links to **`repo-context/REPO_CONTEXT_REFERENCE.md`** instead of inlining the full guide.
- **Cursor rules:** **`.cursor/rules/repo-context-reference.mdc`** is a short pointer to **`REPO_CONTEXT_REFERENCE.md`** (canonical copy not locked under `.cursor/`). **`.cursor/rules/repo-context.mdc`** quick reference aligned with **`AGENTS.md`** (monorepo `--prefix` vs standalone).
- **Claude Code / Codex onboarding:** **`CLAUDE.md`** points to **`REPO_CONTEXT_REFERENCE.md`** for depth beyond **`AGENTS.md`**; **`.codex/config.toml`** header comments document that split for Codex’s project-doc flow.

## [0.2.0] - 2026-03-17

Domain intelligence, runtime topology, annotation quality, and orphaned annotation management.

### Added
- **Domain tier classification** — domains are now classified as `business`, `feature`, `layer`, or `technical` based on module count and package spread. Tier is included in domain responses (`get_domain_or_focus_context`, `get_domain_modules_slice`, `get_annotation_coverage_stats`).
- **Subdomain hierarchy** — business/feature domains with 10+ modules get auto-generated subdomains by path prefix clustering (e.g. `domain:auth/oauth-adapters`). Visible in `get_domain_or_focus_context`.
- **`get_cross_package_dependencies`** — new tool: inter-package import analysis with symbol details, top module edges, and boundary violation detection.
- **`get_runtime_topology`** — new tool: Lambda triggers (API/SQS/Schedule), resource references (DynamoDB/SQS via !Ref/!GetAtt in env vars), and data flows between services through queues.
- **Annotation quality scoring** — `computeAnnotationQuality()` rates annotations 0–10 with tier (`minimal`/`basic`/`detailed`/`comprehensive`) and `missingFields`. Shown in `get_context_detail` semanticMeta. Annotation queue now uses quality-based priority and includes `recommendedFields` per item.
- **`get_orphaned_annotations`** — new tool: detects annotations whose node no longer exists in the graph.
- **`cleanup_orphaned_annotations`** — new tool: preview or remove orphaned annotations with auto-backup.
- **Auto-backup on flush** — `AnnotationStore.flush()` creates backup when >5% of entries are removed; rotates to keep max 5 backups.
- **Orphaned warning in `refresh_repo_context`** — response now includes `annotations` section with orphaned count and warning.

### Changed
- **STRUCTURAL_DIRS expanded** — 16 new structural directories: `types`, `config`, `constants`, `store`, `contexts`, `providers`, `middleware`, `models`, `tests`, `__tests__`, `testing`, `mocks`, `fixtures`, `adapters`, `interfaces`, `entities`, `repositories`, `use-cases`, `slices`, `queries`, `columns`. Reduces domain noise.
- **`search_repo_context` returns grouped results** — default response groups results by type (`domains`, `modules`, `services`, `capabilities`) with per-group limits. New `nodeTypes` parameter for flat filtered results.
- **SAM parser extended** — now extracts `Properties.Events` (API/SQS/Schedule triggers) and `Properties.Environment.Variables` references (!Ref/!GetAtt → resource links). New types: `InfraTrigger`, `InfraEnvRef`. New edge kinds: `consumes` (SQS→Lambda), `uses_env` (Lambda→resource).
- **Annotation queue priority** — formula changed to `(downstream × 2) + exports + (lines/200) - (qualityScore × 3)`.

## [0.1.0] - 2025-03-01

Initial release. Repository context over MCP for AI agents: syntactic snapshot (ts-morph + IaC scan) → semantic graph (packages, modules, capabilities, infra modules and services, domains) → optional AI annotations. Tools, config, and workflow are described in README, ARCHITECTURE, and `.cursor/rules/`.

- Pipeline: Stage 1 (snapshot + infra), Stage 2 (graph with `infra` edge Lambda→code), Stage 3 (annotations).
- Infra: SAM/CFN, Helm, Kubernetes (incl. k3d), Dockerfile; one module per file, service nodes per resource; domains infra-sam, infra-k8s, infra-helm, infra-dockerfile.
- Domains: path, clusters, config patterns; domainAliases for query resolution (e.g. kubernetes → infra-k8s).
- Annotations: modules, capabilities, domains, infra modules, services; queue and stats; merge on update.
- Config: repo-context.config.json, domains.config.json. Scripts: mcp, typecheck, lint, test, dump.
