# ScienceDiscovery User Guide: Literature Research Case

This guide follows a cross-database literature research task to demonstrate the full workflow: starting the service, configuring the system, dispatching a task, granting approvals, and reviewing results.

## 1. Case overview

This case is a typical cross-database literature research task: the agent must search PubMed and bioRxiv for papers published 2023–2025 that compare gene expression in adult versus pediatric liver parenchymal cells, focus on immune-related pathways, and generate a bar chart of gene-count comparison for the top 14 enriched pathways, while flagging contradictory findings across studies.

A task like this normally takes researchers days of manual reading and data extraction, with low efficiency and a high risk of omissions. ScienceDiscovery orchestrates multiple tools to automate it end to end:

- **Retrieval**: the literature-search MCP tool builds a search strategy and queries both databases in parallel.
- **Understanding and analysis**: a large model understands the literature, and a code tool performs pathway enrichment analysis and plotting.
- **Traceability**: the whole execution is structured into a memory graph, forming a traceable task chain.
- **Report writing**: the agent actively queries the real execution chain in the graph so that every statement is backed by evidence and nothing is fabricated.

---

## 2. Model configuration

Go to **System configuration → Model registry** and add a model:

| Field | What to enter |
|---|---|
| Display name | `task-gpt5` (user-defined) |
| Base URL | `https://api.openai.com/v1` |
| Model ID | `gpt-5` |
| API token | The model's key. Encrypted at rest; the UI hides the plaintext |

![Model registry](../../images/model.png)

---

## 3. System settings

### 3.1 Connectors

Connectors are the Agent's entry points to external research databases. If a connector is not enabled, the Agent has no corresponding tool.

For this case, enable the following two under **System configuration → Connectors** (or the connector panel in session settings):

- **PubMed**: covers published biomedical literature.
- **bioRxiv**: covers preprints from the same period.

Other connectors (arXiv, UniProt, Reactome, etc.) can stay off.

![Connector settings](../../images/connector.png)

### 3.2 Timeouts (optional)

Timeouts constrain the Agent's maximum wait or run time across five scenarios—model no response, single turn, Runner sandbox, permission wait, and kernel idle—to keep one stalled point from dragging down the whole session.

Under **System configuration → Timeouts** you can configure these five items:

| Field | What it controls |
|---|---|
| Agent no response | Stop this turn automatically when the model produces no streaming output or progress within the time |
| Agent single turn | Total time limit for one full round (model reasoning + tool calls + streaming output) |
| Runner execution | Wall-clock limit for a single sandbox code execution |
| Permission wait | Maximum time the Agent waits for the user to approve a permission card |
| Kernel idle | Survival time of a persistent Python/R kernel with no activity |

![Timeout settings](../../images/timeout.png)

### 3.3 Quotas (optional)

Quotas constrain the resource caps the Agent may occupy in the sandbox and upload paths, covering single-file size, single-request size, workspace total capacity, and single-execution output, to keep large files or large outputs from dragging down the session.

Under **System configuration → Quotas** or the corresponding environment variables, you can configure these four items:

| Field | What it controls |
|---|---|
| Upload per file | Maximum size of a single uploaded file |
| Upload per request | Total body-size limit for a single multipart upload request |
| Workspace total | Total file capacity accumulated in the Runner workspace |
| Execution output | Retention limit for stdout + stderr of a single execution; truncated automatically when exceeded |

![Quota settings](../../images/quotas.png)

### 3.4 Prepare the Python/R environment

This module hosts the Python and R runtimes the Agent uses inside the sandbox. After the Runner starts, it pulls the managed micromamba in the background and prepares a read-only base; users can clone named environments from the base and install packages as needed, and each change produces an immutable revision for traceability.

Go to **System configuration → Environments**. On first start the Runner downloads and verifies micromamba in the background, with status changing from `provisioning` to `ready`; this takes a few minutes. On failure the page shows the reason and offers a retry.
![Environment settings](../../images/python.png)

### 3.5 Skills (optional)

The Skill module hosts the skill packages the Agent can call during a run.

To create a skill, use any of the following under **System configuration → Skills**:

| Method | Operation |
|---|---|
| Manual | Add a skill-package directory directly in the manager and fill in `SKILL.md` and the required fields (`name` must be lowercase-hyphenated and match the directory name; `description` must be non-empty) |
| Natural-language draft | Describe the workflow in natural language; the manager generates a reviewable draft that is then landed as a skill package |
| Distill from the current session | Distill a skill draft from the session history and add it to the skill library after review |
| Local import | Import from a local `SKILL.md` file or a ZIP package; ZIPs are checked for path traversal, symlinks, encryption, duplicates, and size/file-count limits |
| Git repository import | Import from an HTTPS or SSH repository URL (a ref or subdirectory may be specified); credentials are read only from the local credential helper or SSH config and never appear in the repository URL or model context |

![Skill settings](../../images/skill.png)

### 3.6 Specialists (optional)

The Specialist module packages a fixed set of instructions, model, skills, and connectors into a reusable Agent configuration.

To create a specialist under **System configuration → Specialists**:

1. Open **System configuration → Specialists** and click **New specialist**.
2. Fill in the basic information: a display name and a task description that describes the Agent's role and applicable scenarios.
3. Bind the resources the run needs: a task model, an optional skill whitelist, an optional connector whitelist, an optional environment, and a review model.
4. After saving, the specialist appears in the "Specialist" dropdown on the Session creation page and can be selected by name when creating or running a session.
![Specialist settings](../../images/specialist.png)

This case does not need a custom specialist; the system built-in default is sufficient.

### 3.7 Science Memory (optional)

The Science Memory module stores the session's execution and argumentation as a graph: the research goal, each task step, the code that runs, the output files, down to each cited claim in the final report and its evidence source, all persisted as nodes and edges so that "how this conclusion came to be" is click-traceable.

Enable and use it as follows:

1. **Prepare Neo4j**: the memory graph requires an external Neo4j service (not packaged in the image). Under **System configuration → Memory graph**, fill in the Bolt address, username, and password.
2. **Enable the service**: turn on the memory-graph feature in system settings. Once enabled, the Python sidecar `services/memory-graph` (loopback `:17674` only) is started and self-checks its health with the Runner on startup.
3. **Agent-side auto-mirroring**: once enabled, execution events (MCP search, `run_python`) are mirrored automatically into the graph to form a "task chain"; the Agent builds a "citation chain" through the three tools `declare_evidence`, `declare_artifact`, and `declare_claim` when writing the final report.
4. **Query and view**: the Agent can call the `query_graph` tool for a case-insensitive substring search; the frontend renders `[alias]` in the report as a clickable chip that jumps to the corresponding evidence or artifact.

When Neo4j is unreachable, this module degrades silently and does not affect the web or conversation main path.

![Science Memory settings](../../images/memory.png)

---

## 4. Create a Project and Session

On the left, **New Project**:

- Name: `adult-pediatric-liver-immunity`
- Description: one sentence stating the goal

New Session: open the Project → **Add session**.

![New Project](../../images/project.png)

---

## 5. Dispatch the task

Enter the following task description in the dialog:

```text
Search PubMed and bioRxiv for papers published 2023-2025 comparing gene
expression in adult vs pediatric liver parenchymal cells. Focus on immune-related
pathways. Generate a pathway enrichment bar chart showing gene count comparison
between the two populations for the top 14 enriched pathways. Flag any
contradictory findings across studies.
```

Click **Run analysis**.
![Dispatch task](../../images/task.png)

---

## 6. Approvals and permissions

While a task runs, the Agent pauses before high-risk operations and pops a permission card, waiting for the user to approve. The table below lists the common approval types and what they mean:

| Approval type | Meaning |
|---|---|
| code | The Agent calls `run_python` or `run_shell` to execute code in the sandbox |
| connector | The Agent calls an MCP tool (e.g. `mcp__pubmed__search`, `mcp__biorxiv__search`) to access an external research database |
| download | The Agent calls `artifact_download` to download candidate files into the workspace |
| extraction | The Agent calls `paper_extract_pdf` to extract text and tables from a downloaded PDF |
| scientific-environments | The Agent calls `environment.install` and other managed-environment change APIs |
| web | The Agent calls `web_search` or `web_fetch` to make a public-network request |
| remote-job | The Agent submits an immutable job card on a remote SSH / SLURM host (each job approved separately) |

Authorization applies to the current Session by default. To persist it at the Project or Global scope, go to **System configuration → Permissions** to adjust or revoke it.

If you do not want to confirm manually each time a card appears, click **Always allow** on that card to grant long-term authorization for that operation category.
![Permission approval card](../../images/permission.png)

---

## 7. Review the results

The agent finally outputs a report with clickable citation tags. Each tag corresponds to specific cited content, its source literature, and the execution chain, so it can be verified by clicking. Every statement in the report is linked to execution evidence in the memory graph, making conclusions traceable and re-checkable and compressing a literature survey that would normally take days into minutes.

### 7.1 View artifacts

Open the artifact (Markdown report) in the right-hand artifact panel. The Evidence citations in the report body are clickable chips.
![View the artifact and its evidence](../../images/evidence1.jpg)

### 7.2 View Evidence

Click any Evidence chip to open the Evidence card. The card offers three entries:

| Entry | Use |
|---|---|
| **Preview** | View the content of the Evidence |
| **Provenance** | View the provenance of the Evidence, including the code, execution environment, and execution logs that generated it |
| **View chain** | View the Science Memory graph information related to this Evidence |

![Preview](../../images/evidence2.jpg)
![Provenance](../../images/evidence3.jpg)

### 7.3 View the generation chain and citation chain

Click **View chain** to inspect the two chains of this Evidence:

- **Generation chain**: from the research goal, follow the task nodes to the code and execution records that generated the Evidence.
- **Citation chain**: from the Evidence up to its source literature, and to the Artifact / report claim that declared this Evidence.
![Science Memory view](../../images/evidence4.jpg)
