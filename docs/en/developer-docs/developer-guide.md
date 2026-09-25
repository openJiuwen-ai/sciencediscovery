# Deep Developer Guide

This guide is for developers and code agents that need to modify ScienceDiscovery. It provides an entry point for understanding the repository architecture.

## Recommended reading order

1. [Runtime architecture](architecture.md)
   - Understand API, Runner, Web, tools, and execution boundaries.

2. [Agent backend](agent-backend.md)
   - Understand the Agent loop, model calls, tool dispatch, and context handling.

3. [Control plane](control-plane.md)
   - Understand Session, Project, permissions, storage, and lifecycle.

4. [Runtime Core boundaries](runtime-core.md)
   - Understand domain-independent runtime responsibilities.

5. [Plugin architecture](plugins.md)
   - Understand where new capabilities should be added.

## Core design principles

### API is the Agent control plane

The Agent loop currently runs inside `services/api`. API owns:

- model calls;
- tool dispatch;
- MCP clients;
- permissions and provenance;
- Session lifecycle.

Runner provides isolated execution and does not own Agent semantics.

### services assemble, packages provide capabilities

When adding capabilities:

- put reusable capabilities in `packages/`;
- keep service lifecycle and wiring in `services/`;
- keep UI concerns in `apps/web`.

Avoid implementing the same capability in multiple layers.

## Guidance for Code Agents

Before modifying code, identify:

- module ownership;
- data flow entry points;
- public interfaces;
- related tests.

Do not infer ownership only from filenames. Some historical compatibility code remains in the repository.

## Historical design documents

Some documents describe previous development stages and should not be treated as current implementation references:

- MVP/M1/M2 design records;
- deprecated architecture proposals;
- migration notes.

Current behavior should be verified from architecture docs, source code, and tests.