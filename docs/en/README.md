# ScienceDiscovery Documentation

[中文文档](../zh/README.md) | [Documentation home](../README.md)

This is the complete English documentation set.

## Getting started

- [Quick start](getting-started/quick-start.md) — follow the shortest Linux or macOS path, configure a model, and complete a first inspectable Agent task.
- [Deployment](getting-started/deployment.md) — choose a prepackaged single file, local source mode, or Docker, with long-running operation and first-run troubleshooting.

## Core capabilities

From running code to exploring directions, improving artifacts, and checking evidence, these six capabilities support research you can inspect and iterate on.

- [Scientific sandbox](core/execution-workspaces.md) — Write, debug, and run code in an isolated workspace, with results you can inspect.
- [Idea Tree](core/idea-tree.md) — Propose, design, and assess candidates, then use feedback to guide another round.
- [RSI for scientific artifacts](core/evolve.md) — Improve evaluable artifacts through variant search and held-out assessment.
- [ScienceMemory and Reviewer](core/science-memory-reviewer.md) — Connect tasks, evidence, and conclusions, and identify issues worth reviewing.
- [Specialists](core/specialists.md) — Package responsibilities, skills, and tools into reusable research roles.
- [Scientific MCP and Skills](core/mcp-skills.md) — Combine scientific interfaces with reusable working methods.

## Domain guides

- [Design an antibody on Ascend NPU](domains/antibody-design.md) — configure a Runner, run the RFdiffusion → ProteinMPNN → Protenix workflow, and inspect structures and screening results.
- [Evolve a solution](domains/evolve-a-solution.md) — run a program-evolution search end to end and judge whether the improvement is real.
- [Run an evolution search](domains/run-an-evolution-search.md) — size a search, choose a scoring mode, watch it run, and read the held-out result.
- [Analyze correlations and clusters of sepsis endotype scores](domains/analyze-sepsis-endotypes.md) — Use real BiomniBench data, from CSV upload to analysis, delivery, and quality review.
- [Research how migrating birds determine location and direction](domains/literature-research.md) — Use DRB-59 to configure retrieval, synthesize evidence, and inspect a cited report.

## Advanced setup

- [Create and use custom Specialists](advanced-setup/configure-specialists.md) — define responsibilities, configure resources, and verify a task.
- [Import and manage research Skills](advanced-setup/configure-skills.md) — local/Git import, runtime availability, and draft review.

- [Configure custom MCP servers](advanced-setup/configure-custom-mcp.md) — local/remote connections, secret editing, OAuth, Inspector and Session tool selection.
- [Configure the network proxy](advanced-setup/configure-network-proxy.md) — add a proxy on the settings page and choose a policy for LLM, web, and MCP traffic.
- [Install Neo4j and configure ScienceMemory](advanced-setup/science-memory-setup.md) — install an external Neo4j, enable ScienceMemory in system settings, and explore chains in the frontend graph.

## Reference

- [Execution and workspaces](reference/execution-workspaces.md) — execution states, file handoff, environment revisions, and stopping.

- [CLI](reference/cli.md) — command and behavior reference for `serve`, `run`, `extract`, and `version`.
- [Configuration](reference/configuration.md) — environment variables, default ports, upload/workspace/output quotas, and data layout.
- [REST API](reference/rest-api.md) — internal HTTP API used by the UI: authentication, request/response, and error semantics.
- [Runtime behavior and limits](reference/runtime-behavior.md) — models, settings inheritance, skills, permissions, timeouts, and execution limits.
- [Built-in tools](reference/builtin-tools.md) — parameters, boundaries, and exposure conditions for model-visible tools.
- [Web tools](reference/web-tools.md) — web search/fetch providers, configuration, permissions, caching, and audit.

## Developer documentation

- [Idea Tree implementation](developer-docs/idea-tree.md) — research loops, persisted state, budgets, and recovery limits.

See the [developer documentation index](developer-docs/README.md) for architecture, module boundaries, protocols, and current feature designs.
