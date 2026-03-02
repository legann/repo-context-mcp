# Changelog

All notable changes to this project will be documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/).

## [0.1.0] - 2025-03-01

Initial release. Repository context over MCP for AI agents: syntactic snapshot (ts-morph + IaC scan) → semantic graph (packages, modules, capabilities, infra modules and services, domains) → optional AI annotations. Tools, config, and workflow are described in README, ARCHITECTURE, and `.cursor/rules/`.

- Pipeline: Stage 1 (snapshot + infra), Stage 2 (graph with `infra` edge Lambda→code), Stage 3 (annotations).
- Infra: SAM/CFN, Helm, Kubernetes (incl. k3d), Dockerfile; one module per file, service nodes per resource; domains infra-sam, infra-k8s, infra-helm, infra-dockerfile.
- Domains: path, clusters, config patterns; domainAliases for query resolution (e.g. kubernetes → infra-k8s).
- Annotations: modules, capabilities, domains, infra modules, services; queue and stats; merge on update.
- Config: repo-context.config.json, domains.config.json. Scripts: mcp, typecheck, lint, test, dump.
