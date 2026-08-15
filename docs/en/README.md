# ScienceDiscovery Documentation

[中文文档](../zh/README.md) | [Documentation home](../README.md)

This is the complete English documentation set.

## Tutorials

- [Quick start](tutorial/01-quick-start.md) — install, start the stack, configure a model, and complete a first agent task.

## How-to guides

- [Deployment](how-to/deployment.md) — deploy ScienceDiscovery using the prepackaged binary.
- [Configure the network proxy](how-to/configure-network-proxy.md) — add a proxy on the settings page and choose a policy for LLM, web, and MCP traffic.

## Reference

- [Configuration](reference/configuration.md) — environment variables, default ports, upload/workspace/output quotas, and data layout.
- [REST API](reference/rest-api.md) — internal HTTP API used by the UI: authentication, request/response, and error semantics.
- [Runtime behavior and limits](reference/runtime-behavior.md) — models, settings inheritance, skills, permissions, timeouts, and execution limits.
- [Built-in tools](reference/builtin-tools.md) — parameters, boundaries, and exposure conditions for model-visible tools.
- [Web tools](reference/web-tools.md) — web search/fetch providers, configuration, permissions, caching, and audit.
- [Repository layout](reference/repository-layout.md) — directories, modules, default ports, and data locations.
- [Paper Worker](reference/paper-worker.md) — PDF extraction protocol, pipeline, and limits.
- [Web frontend](reference/web-frontend.md) — frontend stack, event mapping, and development/test entry points.

## Explanation

See the [explanation index](explanation/README.md), which covers the overall architecture, control plane, agent backend, sandbox, Ascend NPU host broker, rate limiting, connectors, MCP tool protocol, network proxy, review and provenance, Science Memory, skill progressive disclosure, subagent orchestration, and content-addressable storage.
