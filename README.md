# ScienceDiscovery

ScienceDiscovery is a one‑stop AI research workspace built specifically for scientific research. Leveraging this platform, researchers can efficiently complete the highly cumbersome research exploration workflow of "literature review, hypothesis formulation, code development, experimental trial‑and‑error, and parameter tuning" in a single unified environment..

English | [中文](README_zh.md)

> [!WARNING]
> ScienceDiscovery is not a multi-user production service. The API, runner, and gateway listen on loopback by default; the API uses one bearer token and does not terminate TLS. Exposing the API on another interface must be an explicit deployment choice on a trusted, secured network. Python, R, and shell commands run in a fail-closed bubblewrap sandbox; the control API, gateway, PDF worker, and outbound model/provider calls run outside that sandbox as trusted control-plane operations.

## Project positioning

A browser UI communicates with a Node control API. Each agent run is driven by a Python Gateway, while workspace tools, sandbox execution, scientific connectors, PDF extraction, permissions, provenance, and review checks are enforced by the Node control plane. The product is intended for trusted local or workstation use, not hosted multi-tenant use.

## Features

- **One‑click configuration and high‑efficiency access to massive resources**: The platform’s built‑in research‑database Connector enables one‑click rapid setup of literature and data repositories, granting quick access to vast volumes of cutting‑edge papers and core experimental datasets.
- **Autonomous code exploration within a secure sandbox**: Agents are empowered to independently write, debug and run Python, R or Shell code inside a securely isolated sandbox, delivering a stable runtime for complex scientific data processing.
- **Automatic decomposition and dynamic execution of sophisticated research tasks**: Powered by robust task‑planning and multi‑agent collaboration capabilities, the system automatically breaks down complex research assignments, and dynamically orchestrates and invokes over 300 cross‑domain Skills.
- **Full‑chain traceability for research workflows**: The platform visualizes the complete end‑to‑end workflow and provides traceability of all deliverables including codes, environments and logs, ensuring high credibility across the entire research lifecycle.

## Related documents

- [Documentation](docs/README.md) — complete English and Chinese Tutorial / How-to / Reference / Explanation indexes.
- [Contributing](CONTRIBUTING.md) — documentation and contribution notes for this branch.

## Requirements

ScienceDiscovery is distributed as a prepackaged binary, the only user path: take the executable matching the host architecture, install Bubblewrap, then run `./ScienceDiscovery serve`.

| Path | Host requirements |
|---|---|
| Prepackaged binary | Linux x86_64/aarch64 and bubblewrap |

Managed scientific environments use the application's pinned micromamba and do not require system Python, R, or conda. Deployment also requires Linux and the user-namespace capabilities described in the deployment guide.

## Installation

Prepare a ScienceDiscovery executable for the host architecture; see the [deployment guide](docs/en/how-to/deployment.md) for installation and run steps.

## Quick start

From the directory containing the `ScienceDiscovery` executable, start the stack:

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

In another terminal, run `curl -fsS http://127.0.0.1:4310/health`. Then open <http://127.0.0.1:4310>, log in with the access token the server printed on startup, and configure a task model under **System configuration → Global defaults**. See the [Quick Start tutorial](docs/en/tutorial/01-quick-start.md) for the first task; see the [deployment guide](docs/en/how-to/deployment.md) for the complete deployment.

## License

[Apache License 2.0](LICENSE).

This product serves solely as a workflow orchestration tool and does not embed any AI model capabilities. When users integrate AI models for specific business scenarios, they shall bear full responsibility for compliance obligations under the EU AI Act and other relevant regulatory frameworks.
