# ScienceDiscovery Documentation

[中文文档](../zh/README.md) | [Documentation home](../README.md)

This is the complete English documentation set.

## Getting started

- [Quick start](getting-started/quick-start.md) — install a prepackaged binary, start the service, configure
  a model, and complete a first task.
- [Deployment](getting-started/deployment.md) — other ways to install and run ScienceDiscovery when the prebuilt binary does not suit your host or workflow: a source-built single-file binary, local source mode, or Docker.

## Core capabilities

- [Program evolution](core/evolve.md) — understand searches, scoring modes, engines, data splits, and result trustworthiness.
- [Shell, environments, and workspaces](core/execution-workspaces.md) — understand execution, files, environments, completion, and stopping.
- [Idea Tree](core/idea-tree.md) — understand the autonomous-research engine, its use, state, and boundaries.

## Domain guides

- [Design an antibody on Ascend NPU](domains/antibody-design.md) — configure a Runner, run the RFdiffusion → ProteinMPNN → Protenix workflow, and inspect structures and screening results.
- [Evolve a solution](domains/evolve-a-solution.md) — run a program-evolution search end to end and judge whether the improvement is real.
- [Run an evolution search](domains/run-an-evolution-search.md) — size a search, choose a scoring mode, watch it run, and read the held-out result.
- [Analyze correlations and clusters of sepsis endotype scores](domains/analyze-sepsis-endotypes.md) — Use real BiomniBench data, from CSV upload to analysis, delivery, and quality review.
- [Research how migrating birds determine location and direction](domains/literature-research.md) — Use DRB-59 to configure retrieval, synthesize evidence, and inspect a cited report.

## Advanced setup

- [Configure custom MCP servers](advanced-setup/configure-custom-mcp.md) — local/remote connections, secret editing, OAuth, Inspector and Session tool selection.
- [Configure the network proxy](advanced-setup/configure-network-proxy.md) — add a proxy on the settings page and choose a policy for LLM, web, and MCP traffic.
- [Install Neo4j and configure ScienceMemory](advanced-setup/science-memory-setup.md) — install an external Neo4j, enable ScienceMemory in system settings, and explore chains in the frontend graph.

## Reference

- [Configuration](reference/configuration.md) — environment variables, default ports, upload/workspace/output quotas, and data layout.
- [REST API](reference/rest-api.md) — internal HTTP API used by the UI: authentication, request/response, and error semantics.
- [Runtime behavior and limits](reference/runtime-behavior.md) — models, settings inheritance, skills, permissions, timeouts, and execution limits.
- [Built-in tools](reference/builtin-tools.md) — parameters, boundaries, and exposure conditions for model-visible tools.
- [Web tools](reference/web-tools.md) — web search/fetch providers, configuration, permissions, caching, and audit.

## Developer documentation

See the [developer documentation index](developer-docs/README.md) for architecture, module boundaries, protocols, and current feature designs.
