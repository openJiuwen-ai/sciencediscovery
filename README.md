<div align="center">

# ScienceDiscovery

**The one-stop AI research workspace, built for scientists.**

Literature review, hypothesis, code, experiments and tuning — in one environment, with every step on the record.

[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)
[![Release](https://img.shields.io/badge/Release-0.2.0-1f6feb?style=flat-square)](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/0.2.0)
[![Platform](https://img.shields.io/badge/Platform-Linux%20binary%20%7C%20macOS%20source-6e7781?style=flat-square)](#requirements)
[![Docs](https://img.shields.io/badge/Docs-EN%20%7C%20ZH-6e7781?style=flat-square)](https://sciencediscovery.github.io/docs/)

[Download](#installation) · [Quick start](https://sciencediscovery.github.io/docs/getting-started/quick-start.html) · [Documentation](https://sciencediscovery.github.io/docs/) · [Contributing](CONTRIBUTING.md) · [中文](README_zh.md)

<img src="docs/images/task.gif" width="920" alt="The ScienceDiscovery workspace: project and session navigation, the composer, and the artifact, reviewer and provenance panels" />

</div>

## Overview

ScienceDiscovery is a locally run research workspace, built on
[JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm): an agent reads the literature,
writes and runs code inside a sandbox, and records the origin of every result. Everything
executes on your own machine, against your own files, with your own model keys.

## Installation

The prepackaged binary is the shortest path to a first run. On the
[Releases page](https://github.com/openJiuwen-ai/sciencediscovery/releases), download
the `ScienceDiscovery-<version>-linux-x86_64` asset for x86_64 or the
`ScienceDiscovery-<version>-linux-aarch64` asset for arm64. Rename the downloaded
file to `ScienceDiscovery`, then run:

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

Open the **`Open to sign in`** URL that `serve` prints. The browser stores the local service access token automatically, so there is nothing to copy. That token is distinct from a model API key, and the URL grants access to this machine's workspace — keep it private. The web interface is served at <http://127.0.0.1:4310>; the terminal window only runs the service.

For the prepackaged binary, Bubblewrap is the only system dependency. The
[deployment guide](https://sciencediscovery.github.io/docs/getting-started/deployment.html) covers building a portable binary
from source, local source mode for development, and Docker for advanced container
operations. It also has [first-run help](https://sciencediscovery.github.io/docs/getting-started/deployment.html#first-run-troubleshooting-for-binary-and-local-mode)
for the binary and local modes. Every deployment path uses JiuwenSwarm by default; the deployment
guide covers the deployment-specific operations.

## Configure a model

ScienceDiscovery does not bundle a model; you connect your own API. Open **System configuration** at
the bottom of the left sidebar, then open **Model registry**. Select a preset provider or add one
manually, enter its details and API key, then select **Save & connect**. This registers the provider's
models and tests the first one. When it is the first model in the system, it also becomes the default
task model. If you already have models, select one from **Global default task model** at the top of
Model registry.

Field definitions, and which of them an environment variable can set instead, are in the [configuration reference](https://sciencediscovery.github.io/docs/reference/configuration.html).

## First task

Create a Project and a Session, drop a CSV or a PDF into the workspace, and describe the analysis
you want. A permission card appears before the first code execution; once approved, inspect tool calls
and their results in the timeline. Generated files that the task declares as **Artifacts** appear in the
workspace. For a step-by-step walkthrough, see the [Quick Start](https://sciencediscovery.github.io/docs/getting-started/quick-start.html).

## Capabilities

| Capability | Description | Reference |
|---|---|---|
| **Literature and data access** | Built-in connectors reach paper and data repositories; PDFs are parsed into citable evidence | [Literature research](https://sciencediscovery.github.io/docs/domains/literature-research.html) · [Custom MCP servers](https://sciencediscovery.github.io/docs/advanced-setup/configure-custom-mcp.html) |
| **Sandboxed code execution** | The agent writes, debugs and runs Python, R and shell inside a fail-closed sandbox | [Sandbox execution](https://sciencediscovery.github.io/docs/developer-docs/sandbox-execution.html) |
| **Task decomposition** | Planning and multi-agent orchestration distribute a task across sub-agents and a cross-domain skill library | [Subagent orchestration](https://sciencediscovery.github.io/docs/developer-docs/subagent-orchestration.html) · [Skills](https://sciencediscovery.github.io/docs/developer-docs/skill-progressive-disclosure.html) |
| **End-to-end provenance** | Code, environment, logs and cited evidence are recorded per deliverable; the optional memory graph makes the chain navigable | [Review and provenance](https://sciencediscovery.github.io/docs/developer-docs/review-provenance.html) · [ScienceMemory](https://sciencediscovery.github.io/docs/advanced-setup/science-memory-setup.html) |

## Command line

A running `serve` can also be driven from the terminal:

```bash
./ScienceDiscovery run "Summarize these results" > answer.md
cat prompt.txt | ./ScienceDiscovery run --stdin --auto-approve | jq .
```

`run` connects to the same control plane as the browser and reads the access token from the data directory, so sharing a `--data-dir` with `serve` requires no further configuration. Run directly in a terminal, it writes the answer to stdout and progress to stderr; in a pipe it emits JSONL, and a non-interactive run must pass `--auto-approve`, since it cannot answer permission prompts. For the full option list, run `./ScienceDiscovery run --help`.

## Requirements

| Path | System requirements |
|---|---|
| **Prepackaged binary** | Linux x86_64/aarch64, Bubblewrap |
| **Local source mode** | Linux x86_64/aarch64 or macOS x64/arm64; Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, Git; Bubblewrap on Linux, built-in Seatbelt on macOS |
| **Docker** | Linux x86_64/aarch64, Docker Engine 24+, Compose v2, unprivileged user namespaces |

Managed scientific environments run on a pinned micromamba, so no system Python, R or conda is required.

## Architecture

ScienceDiscovery is built on [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm). In every
deployment path, a browser UI talks to an adapter on the public port, which reverse-proxies the Node
control API behind it. JiuwenSwarm runs the model loop and calls back into the API for
ScienceDiscovery tool calls, while workspace tools, sandbox execution, scientific connectors, PDF
extraction, permissions, provenance, and review checks stay enforced by the Node control plane. The
[deployment guide](https://sciencediscovery.github.io/docs/getting-started/deployment.html) explains the deployment-specific topology.

> [!WARNING]
> ScienceDiscovery is not a multi-user production service. The adapter and the API listen on loopback by default; access uses one bearer token and there is no TLS termination. Exposing either interface elsewhere must be an explicit deployment choice on a trusted, secured network. Python, R, and shell commands run in a fail-closed platform sandbox (Bubblewrap on Linux and Seatbelt in macOS source mode); the control API, the adapter, JiuwenSwarm, the PDF worker, and outbound model/provider calls run outside that sandbox as trusted control-plane operations.

## Documentation

| Section | Guides |
|---|---|
| **Getting started** | [Quick start](https://sciencediscovery.github.io/docs/getting-started/quick-start.html) · [Deployment](https://sciencediscovery.github.io/docs/getting-started/deployment.html) |
| **Advanced setup** | [Custom MCP](https://sciencediscovery.github.io/docs/advanced-setup/configure-custom-mcp.html) · [Network proxy](https://sciencediscovery.github.io/docs/advanced-setup/configure-network-proxy.html) · [ScienceMemory](https://sciencediscovery.github.io/docs/advanced-setup/science-memory-setup.html) |
| **Reference** | [Configuration](https://sciencediscovery.github.io/docs/reference/configuration.html) · [REST API](https://sciencediscovery.github.io/docs/reference/rest-api.html) · [Built-in tools](https://sciencediscovery.github.io/docs/reference/builtin-tools.html) · [Runtime behavior](https://sciencediscovery.github.io/docs/reference/runtime-behavior.html) |
| **Developer documentation** | [Architecture](https://sciencediscovery.github.io/docs/developer-docs/architecture.html) and the [developer index](https://sciencediscovery.github.io/docs/developer-docs/) |

The complete English and Chinese indexes are in the [documentation site](https://sciencediscovery.github.io/docs/); development setup and test commands are in [CONTRIBUTING.md](CONTRIBUTING.md).

## Join the community

Join the ScienceDiscovery community on [Slack][slack-invite] or scan this QR code:

[slack-invite]: https://join.slack.com/t/sciencediscovery-hq/shared_invite/zt-4avv6fbom-uLrBalsUBR45N9sC2mGO~A

<img src="docs/images/slack.png" alt="ScienceDiscovery Slack community invite QR code" width="200">

## License

[Apache License 2.0](LICENSE).

This product serves solely as a workflow orchestration tool and does not embed any AI model capabilities. When users integrate AI models for specific business scenarios, they shall bear full responsibility for compliance obligations under the EU AI Act and other relevant regulatory frameworks.
