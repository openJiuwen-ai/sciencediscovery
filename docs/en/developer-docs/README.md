# Developer Documentation

These pages are for developers and code agents modifying ScienceDiscovery core code. They document **current implementation, module ownership, and architecture invariants**. For user workflows and precise configuration, use the [documentation index](../README.md).

> If this is your first time in the repository, start with the [Deep Developer Guide](developer-guide.md). Do not infer current architecture from a historical feature document.

## Start here

- [Deep Developer Guide](developer-guide.md) — reading order, code navigation, current architecture facts, change checklist.
- [Runtime architecture](architecture.md) — native/JiuwenSwarm executors, adapter, API, Runner, and sidecars.
- [Repository layout](repository-layout.md) — service/package ownership, dependency rules, and entry points.
- [Control plane](control-plane.md) — authoritative API state, Run lifecycle, and executor seam.

## Agent Runtime

- [Native Agent backend](agent-backend.md) — native loop, models, tools, deadlines, and semantics shared with JiuwenSwarm.
- [Runtime Core boundaries](runtime-core.md) — lowest-level domain-neutral runtime contracts.
- [Dynamic context assembly](context-assembly.md) — contributors, budgets, traces, dependency boundary.
- [Context assembly examples](context-assembly-examples.md) — example model inputs from the production assembly path.
- [Session trajectory and model context](session-trajectory.md) — trajectories, frozen context/state, read-only projections.
- [Subagent orchestration](subagent-orchestration.md) — parent/child contracts, handoff, guardrails, failure semantics.

## Capability and extension architecture

- [Plugin architecture](plugins.md) — capability ownership, plugin manifest/runtime/web contracts, host composition.
- [MCP tool and protocol design](mcp-tool-protocol.md) — MCP Sources, tool protocol, permission, audit, control-plane interface.
- [Science connectors](science-connectors.md) — scientific-source governance, citation, audit.
- [External-source rate limiting](rate-limiting.md) — data-source admission, 429 cooldown, boundary with LLM retry.
- [Skill Library current implementation](skill-library-management.md) — versions, content-addressed packages, search, proposal, publish, rollback.
- [Skill progressive disclosure](skill-progressive-disclosure.md) — Skill catalog, frozen snapshots, on-demand reads.
- [Skill self-evolution current implementation](skill-self-evolution.md) — proposal → user authorization → new Library version.
- [Review and provenance](review-provenance.md) — Artifact Reviewer, claims/evidence, Prompt Manifest.
- [ScienceMemory](science-memory.md) — task/citation graph, storage, module boundaries.
- [Evolution sidecar](evolve-standalone.md) — PUCT/OpenEvolve sidecar contracts and control-plane coupling.
- [Idea Tree implementation](idea-tree.md) — Idea Tree runtime, persistence, recovery boundaries.

## Execution, storage, and infrastructure

- [Single-file binary packaging and releases](binary-packaging.md) — build identifiers, package contents, dual-architecture releases, and first-launch bootstrap.
- [Deployment runtime internals](deployment-runtime.md) — local startup chain, remote Runner deployment, Docker internals, and multi-instance behavior.
- [Sandbox execution](sandbox-execution.md) — Bubblewrap/Seatbelt, scientific environments, network, NPU execution.
- [Project/Session Runner inheritance](runner-inheritance.md) — Runner selection, remote execution, inheritance semantics.
- [Ascend NPU Host Broker](ascend-npu-runner.md) — allowlisted host workloads.
- [Network proxy](network-proxy.md) — outbound proxy resolution and security boundary.
- [Content-addressable storage](cas.md) — CAS, version objects, workspace change detection.
- [PDF worker](paper-worker.md) — PDF extraction protocol and limits.
- [Web frontend](web-frontend.md) — Web host, event mapping, frontend development entry points.

## Documentation maintenance rules

Developer Docs should describe current implementation or compatibility behavior that still matters.

- Milestone-specific MVP/M1/M2 delivery documents do not stay in the main doc set; use Git history when needed.
- Do not present plans, proposals, or future work as implemented behavior.
- Architecture changes should update `architecture.md`, `repository-layout.md`, and the owning subsystem document.
- When documentation conflicts, prefer current source/tests, `scripts/start-stack.sh`, and `scripts/check-architecture.mjs`.
