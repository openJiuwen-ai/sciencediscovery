# Science Memory (Task and Citation Chains)

Science Memory is an experimental, disabled-by-default option that records a Session's execution and argumentation as a Neo4j graph. Its value is making "where did this conclusion come from" traceable and clickable: from the research goal, to each task, the code run, the files produced, down to each cited Claim in the final report and its supporting Evidence.

Two core chains in the graph:

- **Task chain**: `ResearchGoal → SubTask → Code/Artifact/Paper`, linked by temporal `next` edges and output `produces` edges; answers "what was done, in what order".
- **Citation chain**: `report Artifact —states→ Claim —cites→ Evidence —extracted_from→ Paper`, written explicitly by declare tools; answers "what does each sentence in the report cite".

The two intersect at **Claim** and **Artifact** nodes: a Claim both `cites` the Evidence/Artifact supporting it and is asserted by the report Artifact via a `states` edge; an Artifact is both a `Code -produces->` product in the task chain and possibly a `cites` target in the citation chain.

## 1. Main modules

Science Memory spans four layers, each with its own responsibility:

- **Frontend `apps/web`**: read-only. Renders the graph (thumbnail card + full-screen explorer), turns `[alias]` in reports into clickable chips, and dispatches clicks to evidence/artifact/node details. Does not connect to the graph directly; all read requests go through the Node API.
- **Shared packages `packages`**: `schema` defines cross-package types (nodes/edges, Declare inputs, ComposerReference, report-version references); `agent-runtime` defines the LLM-callable tools (`query_graph` / `declare_*`) and injects the declare flow into the system prompt when the feature is enabled. Together they keep the frontend, Node, and tools from drifting.
- **Control plane `services/api` (Node)**: the only client that connects to the graph directly. Two jobs — ① fire-and-forget mirror writes on execution events and receive LLM tool callbacks for declare; ② reverse-proxy `/api/memory/*` read requests for the browser. Drains chip references onto the report version at persistence time.
- **Graph sidecar `services/memory-graph` (Python)**: FastAPI service on loopback `:17674`, Bearer-authenticated. Turns Node's writes into Neo4j nodes/edges (`persistence.py`) and answers read queries (`query.py`). Degrades silently when Neo4j is unreachable, without throwing.

Four-layer flow (separate write and read paths, both via the Node API):

```
[write] execution event / LLM tool callback ──trigger──> Node API ──fire-and-forget write──> Python sidecar ──Cypher──> Neo4j
[read]  browser ────────────────────────────> Node API ──reverse proxy──────────> Python sidecar ──Cypher──> Neo4j

bypass: agent-runtime defines LLM tools, schema defines cross-package types (constrains tools/types, does not participate in data flow directly)
```

All graph writes originate from the Node API (execution mirroring + declare); the browser is read-only, gateway and runner do not participate; the Python sidecar is only accessed by the Node API — a closed single-client loop.

### 1.1 Node types (7)

| Node label | Represents | Unique key / source |
|------------|------|---------------|
| `ResearchGoal` | This Session's research goal | `goal_id` (deterministically generated on the Node side, idempotent on resend) |
| `SubTask` | One task step (each code execution / literature search mirrors one) | `task_id` |
| `Code` | A piece of executed code | `code_id` |
| `Artifact` | A produced file version (chart, CSV, the report itself…) | `artifact_id` |
| `Paper` | A literature record | composite `(session_id, link)`, `link` normalized via `_normalize_link` |
| `Evidence` | A piece of evidence extracted from a Paper | `evidence_id` |
| `Claim` | A cited assertion in the report | `claim_id` |

### 1.2 Edge types (6)

| Edge | Direction | Meaning | Belongs to | Writer |
|--------|------|------|------|--------|
| `next` | SubTask→SubTask / ResearchGoal→head | Temporal chain: execution order sorted by `finished_at` | Task chain | `_link_subtasks_by_finish_time` (rebuild, idempotent) |
| `produces` | SubTask→Code/Artifact/Paper/Evidence/Claim | What a task step produced | Task chain + Citation chain | `upsert_execution` / `upsert_mcp_search` / `declare_claim` |
| `extracted_from` | Evidence→Paper | Which paper the evidence was extracted from | Citation chain | `declare_evidence` |
| `cites` | Claim→Evidence/Artifact | What the assertion cites | Citation chain | `declare_claim` |
| `states` | Artifact→Claim | The report asserts this Claim | Citation chain (task↔citation intersection) | `declare_claim` (when `artifact_id` passed) / `link_claims_to_report` |

## 2. Main flows

### 2.1 Passive task-chain mirroring (no LLM involved)

The task chain needs no explicit LLM declaration; the Node API mirrors it fire-and-forget to the graph on execution events:

1. **First user message** → `MemoryGraphSink.observeSessionFirstMessage` → sidecar `POST /observe/session-first-message` → writes `Session` + `ResearchGoal` + `has_goal`.
2. **Plan proposed** → `observeSessionPlan` → `POST /observe/session-plan` → uses `plan.scope` to **refine** the `ResearchGoal`'s `core_objective`/`domain` (does not mirror plan steps as SubTasks, to avoid PENDING skeleton pollution).
3. **Each code execution completes** → `observeExecution` → `POST /observe/execution` → `upsert_execution`:
   - MERGE a `SubTask` (`task_type='code_execution'`) + `Code`, build `SubTask -[:produces]-> Code`;
   - execution diff only records Derivation and CAS; not-yet-declared files are not written to the graph as `produced_artifacts`;
   - call `_link_subtasks_by_finish_time` to rebuild this Session's `next` temporal chain (delete this Session's old `temporal_chain` edges first, then relink: `ResearchGoal → head → … → last`).
4. **Each literature search (MCP) completes** → `observeMcpInvocation` → `POST /observe/mcp-search` → `upsert_mcp_search`: MERGE `SubTask` (`task_id="subtask:mcp:<invocation_id>"`) + batch MERGE `Paper` (deduped by `(session_id, normalized_link)`, `retrieval_count+1` on hit), build `SubTask -[:produces]-> Paper`.

Once the task chain forms, the frontend "workspace panel" shows a directed graph that grows with execution: the research goal on top, SubTasks lined up along `next` as a timeline, each SubTask pointing down via `produces` to its code, files, and literature.

### 2.2 Explicit citation declare (LLM-driven at final report time)

The citation chain is built only when the LLM writes the **final summary report**. The system prompt (`runtime.ts`, injected only when the feature is on) sets three core constraints:

- **Declare only when writing the final report**: intermediate chat / progress replies do not create Claims or enter the graph;
- **Must build a citation chain**: the report must carry clickable `[alias]` chips; a chip-less report is considered incomplete;
- **Silent**: never narrate the graph/tools/nodes/ids to the user.

Two cite paths (a single claim may mix both):

**Path A — literature evidence (`[evidence1]`)**
```
declare_evidence(content, source_paper_link, locator, evidence_type, …)
  → sidecar checks the Paper exists → CREATE Evidence + extracted_from→Paper → return evidence_id
declare_claim(content, cites_evidence_aliases={"evidence1": evidence_id}, …)
  → CREATE Claim + cites→Evidence → return chip_map={"evidence1": {kind:"evidence", id, label:"evidence1"}}
report body writes [evidence1]
```

**Path B — code output (`[artifact1]`, no literature)**
```
run_python → writes a workspace file and records Derivation/CAS
declare_artifact(path) → registers a Project artifact version and returns artifact_id
  → mirrors the declared version as Code -produces-> Artifact
declare_claim(content, cites_artifact_aliases={"artifact1": artifact_id}, …)
  → CREATE Claim + cites→Artifact → return chip_map={"artifact1": {kind:"artifact", id, label:"artifact1"}}
report body writes [artifact1]
```

> `declare_claim`'s `cites_*_aliases` pair (evidence/artifact) is symmetric by design: the alias is a short token the LLM writes into the report, the corresponding id (evidence_id / artifact_id) resolves in the graph. Code-generated files must first go through `declare_artifact` to get a stable `artifact_id`; undeclared files cannot become graph Artifacts. The final report file itself must also be explicitly declared; at declaration time the round's claims are associated with the report version via `states` edges.

### 2.3 Frontend rendering and click dispatch

When a report opens (`MarkdownRenderer` + `version.references`), the `remarkGraphChips` plugin turns `[alias]` tokens into `graph://<kind>/<id>` links rendered as clickable buttons (`Markdown.tsx`). `App.tsx`'s `handleChipClick` dispatches by `reference.kind`:

| chip kind | Click behavior |
|-----------|----------|
| `evidence` | Opens `EvidenceModal` (shows evidence + the source Paper obtained via `getMemoryChain`) |
| `artifact` | Resolves the stable identity by `artifact_id` in the Project artifact directory → opens `ArtifactModal` to view the chart/data directly |

### 2.4 View chain

`get_chain` is the backend for chain viewing; it picks one of three traversals by the requested `chain_kind`:

| `chain_kind` | What it walks | Frontend button |
|---|---|---|
| `full` (default) | **Joint traversal** of task chain + citation chain + derived-from: pull the whole task chain along `next` (`1..` variable-length), then walk `produces`/`extracted_from`/`cites`/`states`/`input` to fill in the citation and derivation chains. Expands into an unordered subgraph in all directions. | Single "View chain" button for ResearchGoal / SubTask / Code, backward-compatible |
| `task` | Pure task chain: walks only the `next` + `produces` edges in `_CHAIN_HOPS`, no citation/derivation edges | Artifact's "View task chain" button |
| `artifact` | Artifact chain: from the report anchor (the Artifact with `states→Claim`, highest version if multiple) walks directionally to the clicked node, then **reverse-reachability-prunes** to keep only the nodes on the anchor→clicked-node path, discarding other branches. Paper/Evidence/Claim also append an upstream task-chain tail (clicked node ←produces← SubTask ←next← Goal). Note: the artifact chain spans task+citation+derived-from, not the pure citation chain defined at the top of this doc | Single "View chain" button for Paper/Evidence/Claim, Artifact's "View artifact chain" button |

Directional walking avoids spreading into sibling branches; `artifact`'s reverse-reachability pruning further compresses the fork tree into "the path that reaches the clicked node".

Frontend entry: the **View chain** button in `ScientificArtifacts.tsx` (shown only when Science Memory is enabled) → `client.getMemorySubgraph` finds the Artifact node → opens `MemoryGraphExplorer` with `autoChain`, which on mount runs `getMemoryChain` with the node's default chain type to expand that node's chain. In `MemoryGraphExplorer`, Artifact nodes show two buttons (task chain / artifact chain), other nodes show one. Text is bilingual, switching with the system language (i18n key prefix `chain.`).

### 2.5 Artifact provenance tracing (trace_provenance, for reviewer specialist)

`get_chain` returns an **undirected subgraph** (walks both upstream and downstream, for humans to view), suited to "chain viewing". When the reviewer specialist checks artifact provenance it needs something else: **an ordered upstream chain + a verdict on whether the chain is broken** — "can this artifact be traced back to ResearchGoal?" This question can't be left for the reviewer to assemble from a subgraph and infer breakpoints itself; the endpoint must give the conclusion directly. That is what `trace_provenance` does.

Key differences from `get_chain`:

| | `get_chain` (chain viewing) | `trace_provenance` (provenance tracing) |
|---|---|---|
| Output | Unordered subgraph `{nodes[], edges[]}` | Ordered linear chain `{chain[], broken, truncated, reason}` |
| Direction | Bidirectional, upstream + downstream | **Fixed upstream** (walks from start toward the source, does not expose direction) |
| Verdict | None | `broken`/`truncated`/`reason` — three provenance signals |
| Consumer | Rendered by the frontend for humans | reviewer specialist derives `decision` from it |

`trace_provenance` reuses `get_chain`'s `_CHAIN_HOPS` hop-by-hop expansion engine, but takes only `direction=="in"` (upstream) entries, recording the node reached each hop + the `via_edge` hop order, and verdicts:

- Reaches `target_label` (default ResearchGoal) → `broken:false`, last hop marked `is_terminal` (chain complete, artifact traceable)
- A hop finds no upstream edge (chain broken) → `broken:true`, `reason` points to the chain-tail node (breakpoint location)
- Reaches `max_hops` (default 8) without reaching the target → `truncated:true` + `broken:false` (chain not broken, just not fully walked; distinct from a broken chain)
- Start node does not exist → HTTP 404 (artifact has no memory at all, worse than broken)
- Graph unreachable → `broken:true` + `reason:"memory_graph_unreachable"`, HTTP 200 (degrades without crashing, consistent with all read endpoints)

The reviewer derives `decision` from the returned `broken`: `broken:false` → `ACCEPT_AND_PROCEED`; `broken:true` or `truncated:true` → `REVISE_AND_RETRY`. **The endpoint only outputs `broken`, not verdict/decision** — the latter is the reviewer agent's internal business, preserving the "only the endpoint, not the specialist's decision logic" boundary.

## 3. API interfaces

Science Memory adds three kinds of HTTP interfaces: **sidecar native routes** (Python, loopback `:17674`, Bearer auth), **Node API reverse-proxy routes** (browser entry `:4310`, `/api/memory/*`), and **LLM tool callbacks** (Node-internal, not HTTP-facing for the browser).

### 3.1 Sidecar routes (`services/memory-graph/.../server.py`, Bearer-protected)

**Write / mirror (observe + persist)**

| Method + path | Purpose |
|-------------|------|
| `POST /observe/execution` | Mirrors a code execution → SubTask + Code; only declared versions replayed after `declare_artifact` carry Artifact + produces; rebuilds the next chain |
| `POST /observe/mcp-search` | Mirrors a literature search → SubTask + Papers + produces |
| `POST /observe/session-first-message` | Writes Session + ResearchGoal + has_goal |
| `POST /observe/session-plan` | Refines ResearchGoal with plan.scope |
| `POST /persist/evidence` | CREATE Evidence + extracted_from→Paper (Paper missing → 422 `source_paper_not_found`) |
| `POST /persist/claim` | CREATE Claim + cites (Evidence/Artifact) + optional produces + optional states; returns `chip_map`. No cite target → 422 `no_cites_target` (triggered before the degrade branch, reported even if the graph is down) |
| `POST /persist/states` | MERGE states (report Artifact→Claims); the Artifact may not be mirrored yet, polls and waits up to 10×0.3s |
| `POST /internal/neo4j-password` | Pushes the Neo4j password + ensure_schema |

**Read / query**

| Method + path | Purpose |
|-------------|------|
| `GET /health` | State: `disabled`/`needs-password`/`degraded`/`healthy` (no auth) |
| `GET /subgraph?session_id=` | All nodes + all "meaningful" edges (whitelist includes produces/next/extracted_from/cites/states/supersedes/input; the frontend filters out `supersedes` when drawing, version lineage not in the chain view) |
| `POST /query/match` | Cross-session substring search (term-AND, ranked by hit count + field priority); `session_id=null` crosses sessions |
| `POST /query/by-node-type` | Filter nodes by label |
| `POST /query/by-edge-type` | Filter by edge type, returns edges + deduped endpoints |
| `POST /query/chain` | Chain traversal (`node_id` + optional `session_id`/`version`/`chain_kind`: `full` joint / `task` pure task chain / `artifact` pruned from report anchor to clicked node); not found → 404 |
| `POST /trace/provenance` | Artifact provenance tracing (`node_id` + optional `target_label`/`max_hops`/`session_id`); fixed upstream, returns ordered chain + `broken`/`truncated`/`reason`; start missing → 404 |
| `GET /nodes/{label}/{id}` | Single node detail (label not in whitelist → 400) |

### 3.2 Node API reverse-proxy routes (`services/api/src/http/`, browser entry)

Browser is read-only, all reverse-proxied to the sidecar; feature off (client=null) returns an empty result + `reason:"memory_graph_disabled"`, sidecar unreachable returns `reason:"memory_graph_unreachable"`:

| Method + path | Client method (`apps/web/src/api/`) |
|-------------|--------------------------------------|
| `GET /api/memory/subgraph?session_id=` | `getMemorySubgraph` |
| `POST /api/memory/query/match` | `queryMemoryMatch` |
| `POST /api/memory/query/by-node-type` | `byMemoryNodeType` |
| `POST /api/memory/query/by-edge-type` | `byMemoryEdgeType` |
| `POST /api/memory/query/chain` | `getMemoryChain` |
| `POST /api/memory/trace/provenance` | `traceProvenance` (reviewer provenance; returns `broken`/`truncated`/`reason`) |
| `GET /api/memory/nodes/{label}/{id}` | `getMemoryNode` (id is URL-decoded before forwarding; Paper id is a full URL) |
| `GET /health` (includes `memoryGraph` field) | `getMemoryHealth` |

> declare/persist classes are **not on the browser client**: `declareEvidence`/`declareClaim`/`linkClaimsToReport` are Node-internal LLM tool callbacks (see 3.3), calling the sidecar `/persist/*` directly via `MemoryGraphClient`.

### 3.3 LLM tools (`packages/workspace/src/workspace.ts`, registered when the feature is on)

| Tool | Input | Purpose |
|--------|------|------|
| `query_graph` | `{query}` | Substring search on this Session's graph nodes; called at most once, only before the final report to resolve node ids to cite |
| `declare_evidence` | `{content, source_paper_link, locator, evidence_type, confidence, strength}` | Creates Evidence + extracted_from, returns `evidence_id` |
| `declare_claim` | `{content, claim_type, confidence, locator, cites_node_ids[], cites_evidence_aliases{}, cites_artifact_aliases{}, cites_artifact_versions{}, artifact_id?, artifact_version?, task_id?}` | Creates Claim + cites (Evidence/Artifact) + optional produces/states, returns `chip_map` (alias→{kind,id,label}) |
| `trace_provenance` | `{node_id, target_label?, max_hops?}` | Traces artifact provenance: returns an ordered upstream chain + `broken`/`truncated`/`reason`. The reviewer specialist derives `decision` from it, no need to assemble the chain itself |

These tools are grouped in `RunTimeline` under `GRAPH_TOOL_NAMES = {query_graph, declare_evidence, declare_claim}`. The system prompt also constrains: declare/query steps are **silent**, never narrated to the user.

> **`trace_provenance` is visible differently from the other three**: `query_graph`/`declare_*` are registered for all workspaces when Science Memory is enabled; `trace_provenance` is registered only when the **reviewer specialist is active** (`reviewerSpecialistAvailable(enabled, message)` gating: the user message contains "reviewer specialist" + the toggle is on), invisible to the main agent otherwise. Its description also carries a RESTRICTED USE constraint (only for provenance review, no exploration) — double insurance against misuse, because the reviewer specialist is currently a "main agent + gated tool" model (not a separate subagent), so after activation the main agent can still see the tool.

## 4. Storage

Science Memory's own data lives in Neo4j, but to support chip rendering and surviving refreshes, the existing Node-side storage model was extended with fields:

### 4.1 Node-side file-storage extensions

| Location | Addition |
|------|----------|
| `.sciencediscovery-data/scientific-artifacts/` (catalog) | `ScientificArtifactVersion.references?: ComposerReference[]` — the report version's chip alias→graph node mapping, letting chips survive refresh (`store/catalog.ts`) |
| Project artifact directory | `ScientificArtifact` stores the stable `artifact_id`, `projectId`, `origin`, and the creating Session snapshot; `ScientificArtifactVersion` stores the CAS reference and source path |
| Report version | At `declare_artifact` persistence, drains `chipMapBuffer`→`references` + `claimIds`→`states` edges |
| `ComposerReferenceKind` | Extended to `artifact | session | skill | paper | evidence | claim`, carrying the chip's kind |

### 4.2 Environment variables

Connection, auth, and log variables for the sidecar and Node client:

| Variable | Default | Purpose |
|------|------|------|
| `SCIENCE_AGENT_MEMORY_GRAPH_HOST` / `_PORT` | `127.0.0.1` / `17674` | Sidecar bind address and port (service process) |
| `SCIENCE_AGENT_MEMORY_GRAPH_URL` | `http://127.0.0.1:17674` | Endpoint the Node API client uses to reach the sidecar (trailing slash trimmed) |
| `SCIENCE_AGENT_MEMORY_GRAPH_INTERNAL_TOKEN` | `sciencediscovery-memory-graph-local` | Sidecar Bearer token; verified by both Node and sidecar |
| `SCIENCE_AGENT_MEMORY_GRAPH_LOG_LEVEL` | `INFO` | Log level shared by the sidecar and the Node side (propagated) |

> Enabling Science Memory, plus the Neo4j connection address, user, and password, are all managed in **System Settings → Science Memory** (single toggle; no `.env` edit or stack restart needed).

Startup: `scripts/start-stack.sh` unconditionally launches the sidecar with `.sciencediscovery-data/envs/memory-graph/bin/python -m sciencediscovery_memory_graph.server` (the environment is provisioned unconditionally with the stack) and `wait_healthy` waits for `http://127.0.0.1:17674/health`. When the toggle is off the sidecar runs idle; sink writes and read paths short-circuit to return `memory_graph_disabled`.
