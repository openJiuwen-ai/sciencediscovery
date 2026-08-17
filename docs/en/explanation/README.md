# Explanation Index

These pages explain why the system is designed this way and how components cooperate. For concrete parameters, routes, and paths, use [Reference](../README.md#reference).

- [Runtime architecture](architecture.md) — resident processes, module boundaries, and cross-process timing.
- [Control plane](control-plane.md) — responsibilities, storage, and run lifecycle of `services/api`.
- [Agent backend](agent-backend.md) — the Node-native agent loop: modules, model transport, deferred tools, compaction.
- [Sandbox execution](sandbox-execution.md) — bubblewrap/seccomp, scientific environments, and persistent-kernel mechanism.
- [Ascend NPU Host Broker](ascend-npu-runner.md) — host allowlist job scheme used when Ascend devices cannot reliably pass through to bwrap.
- [External-source rate limiting](rate-limiting.md) — MCP rate-limit base, queueing, 429 cooldown, and coverage boundaries.
- [Science connectors](science-connectors.md) — governance chain, audit, and citation for scientific MCP sources.
- [MCP tool and protocol design](mcp-tool-protocol.md) — Source Manifest, tool protocol, Agent Loop, permissions, audit, and control-plane interface.
- [Network proxy](network-proxy.md) — proxy policy resolution, outbound access, and security boundary.
- [Review and provenance](review-provenance.md) — integrity checks, semantic review, claims/evidence, and Prompt Manifest.
- [Science Memory](science-memory.md) — task chain, citation chain, module boundary, and storage.
- [Skill progressive disclosure](skill-progressive-disclosure.md) — catalog search and frozen-snapshot reads.
- [Subagent orchestration](subagent-orchestration.md) — parent/child Agent contract, guardrails, and trade-offs.
- [Content-addressable storage](cas.md) — CAS addressing, workspace change detection, writers, and lifecycle.
