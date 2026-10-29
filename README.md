<div align="center">

<img src="docs/images/logo.png" width="120" alt="ScienceDiscovery app icon">

# ScienceDiscovery

**The all-in-one AI research workspace built for science.** · [Visit the official website →](https://sciencediscovery.github.io/index.html)

Read the literature, form hypotheses, write and run code, conduct experiments, and tune parameters — all in one place. Every step leaves a record, and every result is traceable.

[![Release](https://img.shields.io/badge/Release-0.3.0-1f6feb?style=flat-square)](https://github.com/openJiuwen-ai/sciencediscovery/releases/tag/v0.3.0)
[![License](https://img.shields.io/badge/License-Apache%202.0-1f6feb?style=flat-square)](LICENSE)
[![Platform](https://img.shields.io/badge/Platform-Windows%20%7C%20Linux-6e7781?style=flat-square)](#requirements)
[![Docs](https://img.shields.io/badge/Docs-EN%20%7C%20ZH-6e7781?style=flat-square)](https://sciencediscovery.github.io/docs/)

English · [简体中文](README_zh.md)

[Download](#quick-start) · [Product tour](#product-tour) · [Documentation](https://sciencediscovery.github.io/docs/) · [Contributing](CONTRIBUTING.md) · [Get slides](https://github.com/ScienceDiscovery/sciencediscovery.github.io/blob/main/site/src/media/ScienceDiscovery-Slides.pdf)

<a href="https://github.com/ScienceDiscovery/sciencediscovery.github.io/blob/main/site/src/media/demo.gif"><img src="https://raw.githubusercontent.com/ScienceDiscovery/sciencediscovery.github.io/main/site/src/media/demo.gif" width="720" alt="ScienceDiscovery product demo: scientific MCP, protein 3D viewer, artifact evolution and provenance"></a>

</div>

## Why ScienceDiscovery

ScienceDiscovery runs locally: the agent reads the literature, writes and runs code, and delivers reports, tables, and figures, while the workspace keeps every result together with the evidence behind it.

- **Scientific MCP: one place for your scattered research tools.** Papers and data are retrieved and downloaded through Scientific MCP — no code to write, no API keys to wire up, no hopping between a dozen websites. Say what you need and the files land in your workspace.
- **Protein 3D structures, one click away.** Drop a PDB file into the workspace and the artifact preview opens an interactive 3D structure: rotate, zoom, a sequence panel, and protein, pocket and ligand atoms colored automatically by layer (the built-in Mol* viewer).
- **Self-evolving artifacts (RSI): auto-tune with fewer tokens.** Hand over something measurable — a program, a parameter table, even a prompt — and it generates variants, scores each one, validates the winner on held-out data and returns the best version. Every variant keeps its code, score and run record, so you can roll back.
- **Result provenance: trace any result back to its source.** Runs, artifacts and claims all carry their version and provenance: open a claim and see which run, which dataset and which code produced it, along with the inputs and outputs from that moment.
- **A research environment that runs locally.** ScienceDiscovery runs locally against your own files, and model keys stay on your machine. Python, R, and shell run inside a sandbox, scientific environments are provisioned and pinned for you, and long analyses keep running in the background. Connect a preset provider or any compatible endpoint — requests go only to the provider you configure.

## Product Tour

### 1. Flexible MCP selection: plug in what you need

Enable scientific MCP connectors on demand in System settings — PubMed, arXiv, Europe PMC, PDB, UniProt, Reactome and more — or add your own MCP servers. Tools join the same session, with permissions and governance applied.

![Scientific MCP settings: enabling PubMed, bioRxiv, PDB, UniProt and other research connectors](docs/images/connector-en.png)

### 2. View protein 3D structures in place

Drop a PDB file into the workspace and the artifact preview opens an interactive 3D structure: rotate, zoom, a sequence panel, with protein, pocket and ligand atoms colored automatically by layer.

![The protein 3D structure viewer showing 1ATP with sequence and structure panels](docs/images/readme/tour-protein.jpg)

### 3. Self-evolving artifacts: auto-tune and keep the trail

Hand over something measurable — a program, a parameter table, even a prompt — and it generates variants, scores each one, validates the winner on held-out data and returns the best version; every variant keeps its code, score and run record, so you can roll back.

![The Evolve run panel: score curve, candidate stream and search tree](docs/images/evolve/live-panel-en.png)

### 4. Trace every artifact: click to inspect

Runs, artifacts and claims all carry their version and provenance: open the artifact's Provenance tab to see which run, dataset and code produced the result, along with the inputs and outputs from that run.

![The artifact Provenance view showing version history, preview and provenance tabs](docs/images/evidence1.jpg)

## Evaluation Results

**BiomniBench-DA — 77.4 with GLM-5.2 (August 2026).** In this biomedical data-analysis benchmark, ScienceDiscovery scored 77.4. In the same media-reported comparison, Claude Code with Opus 4.7 scored 73.3 — the configuration the report labels as the previous industry SOTA — and Claude Code with GLM-5.2 scored 69.

| Configuration | BiomniBench-DA score |
| --- | --- |
| ScienceDiscovery + GLM-5.2 | **77.4** |
| Claude Code + Opus 4.7 (labelled the previous industry SOTA in the report) | 73.3 |
| Claude Code + GLM-5.2 | 69 |

![BiomniBench-DA comparison: ScienceDiscovery with GLM-5.2 scores 77.4, Claude Code with Opus 4.7 scores 73.3, and Claude Code with GLM-5.2 scores 69](docs/images/readme/benchmark-biomnibench-da.png)

The chart and scores come from the [published report](https://mp.weixin.qq.com/s/XSaX6oyok9qqZmwBUiQCFg) (Machine Heart, 2026-08-16).

## Quick Start

ScienceDiscovery is available for Windows and Linux. Download the Windows installer `ScienceDiscovery-<version>-win-x64-setup.exe`, or the Linux executable `ScienceDiscovery-<version>-linux-x86_64` (x86_64) / `ScienceDiscovery-<version>-linux-aarch64` (arm64), from the [Releases page](https://github.com/openJiuwen-ai/sciencediscovery/releases). See the [official installation guide](https://sciencediscovery.github.io/docs/getting-started/deployment.html) for detailed installation and startup steps.

### Connect a model

ScienceDiscovery does not bundle a model; you connect your own model API. On Linux, open **System configuration** at the bottom of the left sidebar, choose **Model registry**, select a preset provider or add one manually, enter its details and API key, then choose **Save & connect**. The first model also becomes the default task model; change it later under **Global default task model**. Protocol support and connection-check costs are documented in [Model API compatibility](docs/en/model-api-compatibility.md).

### Run your first task

Create a Project and a Session, drop a CSV or a PDF into the workspace, and describe the analysis you want. Approve the first execution when the permission card appears, follow tool calls and their results in the timeline, and open the files the task declares as **Artifacts** from the workspace panel.

## Requirements

| Path | System requirements |
| --- | --- |
| **Windows desktop app** | Windows 10 or later on x64; about 5 GB of free disk space; no Node.js, Python, or WSL required |
| **Linux binary** | glibc-based Linux x86_64 or aarch64, including WSL 2; Bubblewrap 0.6+ with unprivileged user namespaces; no system Python, R, or conda required |

Managed scientific environments run on a pinned micromamba, so Python and R dependencies are prepared for you.

## Community

Join the ScienceDiscovery community on Slack or Feishu to ask questions, share results, and shape the roadmap.

| [Slack][slack-invite] | Feishu |
| :---: | :---: |
| <img src="docs/images/slack.png" alt="ScienceDiscovery Slack community invite QR code" width="200"> | <img src="docs/images/feishu.jpg" alt="ScienceDiscovery Feishu community invite QR code" width="200"> |

[slack-invite]: https://join.slack.com/t/sciencediscovery-hq/shared_invite/zt-4avv6fbom-uLrBalsUBR45N9sC2mGO~A

Bug reports and feature ideas are welcome on [GitHub Issues](https://github.com/openJiuwen-ai/sciencediscovery/issues), and contributions are described in [CONTRIBUTING.md](CONTRIBUTING.md). If ScienceDiscovery helps your work, a star on the repository helps more researchers find it.

## License

[Apache License 2.0](LICENSE). ScienceDiscovery is open source and self-hosted.

This product serves solely as a workflow orchestration tool and does not embed any AI model capabilities. When users integrate AI models for specific business scenarios, they shall bear full responsibility for compliance obligations under the EU AI Act and other relevant regulatory frameworks.
