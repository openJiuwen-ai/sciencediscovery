# Install Neo4j and configure ScienceMemory

ScienceMemory is an optional ScienceDiscovery feature that stores a session's research goal, each task, the code run, the files produced, and each cited assertion in the final report with its supporting evidence as a Neo4j graph, making "where did this conclusion come from" traceable and clickable. It is disabled by default and has no effect on the web or conversation path.

> This guide covers how to install Neo4j, how to configure it in system settings, and how to use it in the frontend. For the feature's architecture, node/edge types, and API, see [ScienceMemory](../explanation/science-memory.md); for environment variables and ports, see the [configuration reference](../reference/configuration.md).

## 1. Prerequisite: install Neo4j

None of the three ScienceDiscovery deployment modes (single-file binary, Docker, or source local mode) bundle Neo4j. ScienceMemory needs an external Neo4j server. Until it is configured the feature stays off and nothing else is affected.

You need:

- a Neo4j 5.x server (Community edition is enough);
- its HTTP port 7474 reachable by the ScienceDiscovery process (both default to the same machine, loopback);
- the username (default `neo4j`) and password.

> Note: the connection uses Neo4j's HTTP port (7474), not the Bolt port (7687). The Bolt port is never configured. A Neo4j install exposes HTTP on 7474 and Bolt on 7687; ScienceMemory only uses the former.

### 1.1 Option A: Docker (recommended, simplest)

This is the quick start the UI itself suggests. On a machine with Docker:

```bash
docker run -d --name neo4j \
  -p 7474:7474 -p 7687:7687 \
  -e NEO4J_AUTH=neo4j/yourpassword \
  -v neo4j-data:/data \
  neo4j:5
```

- `-e NEO4J_AUTH=neo4j/yourpassword` sets the initial username (fixed `neo4j`) and password on first start. Replace "yourpassword" with your own strong password; you will enter it in ScienceDiscovery's system settings next.
- `-p 7474:7474` exposes the HTTP port ScienceMemory connects to.
- `-v neo4j-data:/data` persists graph data in a Docker named volume, so deleting the container keeps the data.

Wait about thirty seconds, then open <http://127.0.0.1:7474>. If the Neo4j Browser login page loads, Neo4j is ready (log in with `neo4j` / your password to verify).

If you want Neo4j to start and stop alongside ScienceDiscovery, add the Neo4j container to your own Compose file. Do not edit ScienceDiscovery's bundled `docker-compose.yml`, which only carries ScienceDiscovery itself.

### 1.2 Option B: native Linux install (when you don't want Docker)

On Debian/Ubuntu, add the official Neo4j repository and install via apt:

```bash
# Import the Neo4j signing key and repository
sudo install -d /etc/apt/keyrings && \
wget -qO- https://keyserver.ubuntu.com/4046BCA5E2F9A889B1A6FDB0E8E8F9A1B5A3C9F5 | \
  sudo gpg --dearmor -o /etc/apt/keyrings/neo4j.gpg
echo "deb [signed-by=/etc/apt/keyrings/neo4j.gpg] https://deb.neo4j.com stable latest" | \
  sudo tee /etc/apt/sources.list.d/neo4j.list
sudo apt-get update && sudo apt-get install -y neo4j
```

> Verify the key fingerprint and repository URL against the [official Neo4j install guide](https://neo4j.com/docs/operations-manual/current/install/). Steps differ by distribution; RHEL/openEuler uses `dnf`, Alpine uses `apk`.

After installing, set the initial password and start:

```bash
sudo neo4j-admin dbms set-initial-password yourpassword   # first-time setup
sudo systemctl enable --now neo4j                          # enable + start now
```

Verify at <http://127.0.0.1:7474> as above. For remote access or custom ports edit `/etc/neo4j/neo4j.conf` and `sudo systemctl restart neo4j`, but local loopback defaults need no changes.

### 1.3 Verify Neo4j is ready

Regardless of install method, confirm both:

1. `curl -s http://127.0.0.1:7474` returns JSON (including `neo4j_version`);
2. you can log in to <http://127.0.0.1:7474> with `neo4j` / your password.

Neo4j does not need to start in lockstep with ScienceDiscovery, but it must be online whenever ScienceMemory writes or reads the graph. If Neo4j is temporarily unreachable, ScienceMemory degrades silently: no errors, no blocked conversation.

## 2. Configure ScienceMemory in system settings

Once Neo4j is running, all configuration happens in System configuration → Memory, with no `.env` edit and no stack restart.

### 2.1 Open settings

1. Open the ScienceDiscovery Web UI (default <http://127.0.0.1:4310>) and sign in.
2. Click the System configuration button (top right) to open the settings dialog.
3. Select Memory in the left-hand group list.

### 2.2 Fill in the fields

The Memory section has:

| Field | What to enter | Default placeholder |
|---|---|---|
| Enable ScienceMemory (toggle) | Turn on to actually enable | Off |
| Neo4j HTTP | Neo4j's HTTP address | `http://127.0.0.1:7474` |
| Neo4j user | Neo4j username | `neo4j` |
| Neo4j password | The password you set in 1.1/1.2 | — |

Notes:

- There is no Bolt URL, port, or database name field, only HTTP address, user, and password. For a local install the defaults suffice; just enter your password.
- The password is write-only. The backend encrypts it with AES-256-GCM into the data directory; the browser never gets the plaintext back. Once a password is saved, the box shows "Saved · enter a new password to replace it", with a "Remove saved password" button beside it.
- A dependency note at the top links straight to the [official Neo4j install guide](https://neo4j.com/docs/operations-manual/current/install/).
- If Neo4j is not yet running or is unreachable, a degraded hint appears at the bottom of the section with a `docker run` quick-start command you can run directly.

### 2.3 Save

Click Save (or "Save and close") at the bottom. On save the backend pushes the HTTP address, username, and password to the memory-graph sidecar over a loopback, Bearer-protected internal endpoint; the sidecar immediately uses them to connect to Neo4j. A "ScienceMemory settings updated" toast confirms success.

### 2.4 Confirm it connected

Back in the session workspace, expand Memory > ScienceMemory in the right rail. The thumbnail reflects the live connection status (sourced from `/health`). Disabled memory has no entry; enabled but unreachable memory retains status feedback:

| Status | Meaning | Action |
|---|---|---|
| `healthy` | Neo4j reachable, password configured | Working; reads/writes the graph |
| `needs-password` | Sidecar up but no password pushed yet | Go back to settings, enter the password, save |
| `degraded` | Password set but Neo4j unreachable | Check Neo4j is running, port 7474 is open, address/password are correct |
| `disabled` | Toggle is off | Turn the toggle on |

> Pausing (toggle off) does not delete existing graph data; turning it back on restores the view.

## 3. Use ScienceMemory in the frontend

With the toggle on and status `healthy`, a session's task chain, artifacts, and citation chain are mirrored into the graph automatically as the session runs. The frontend is read-only. All read requests are reverse-proxied through the control API to the sidecar; the browser never talks to 7474 or 17674 directly.

### 3.1 Open the graph

Two entry points:

- Session workspace thumbnail: when enabled, expand ScienceMemory within the right-rail Memory folder to see node/edge counts and task completion. Click the thumbnail to open the session's full-screen graph view. The top-level folder starts open; its ScienceMemory details start closed.
- From a specific artifact (the recommended entry for chain viewing): open an artifact preview → click View this product in ScienceMemory; the graph opens already positioned on that artifact's chain view.

### 3.2 Default view: the research spine

On first open the graph shows only the research spine by default: research goal → tasks → tool calls, lined up by execution order. Each task's produced code, papers, and artifacts, plus the citation-chain evidence and claim nodes, are folded away to avoid an unreadable tangle.

### 3.3 Double-click to expand / collapse

- Double-click a Task node (subagent scope) to unfold the tool-call chain it contains.
- Double-click any other node (tool call, code, paper, evidence, claim, or artifact) to unfold one layer of its direct produces, one layer at a time. Double-click again to collapse, which cascades to orphan descendants.
- Hovering a node shows a "Double-click to expand / Double-click to collapse" tooltip.

### 3.4 Chain buttons (per node type)

With a node selected, chain buttons specific to that node type appear beside it or at the top. Clicking one highlights the chain from that node to the related nodes and fogging everything else out. Different node types offer different chains, for example:

- Artifact node: view contained claims, citing claims, producing code, cited papers, related task, …
- Paper node: view extracted evidence, citing claims, the searching task, …
- Task node: view previous task, next task, research goal.

> Buttons are shown by existence: if a chain has no matching data in the graph, its button is hidden rather than clickable-but-empty. When done, click ← Back to full graph at the top to return to the full graph.

### 3.5 Color-chip type filters

A row of color chips sits at the top of the graph, each representing a node or edge type. Click a chip to show only that type; click again to cancel; several types can be filtered at once. Hovering a chip shows a bubble explaining that type's meaning.

Node colors for reference: research goal red, task teal, tool call amber, paper rose, evidence green, claim orange, code purple, artifact teal-green.

### 3.6 Node detail panel

Click a node to select it. The right-hand detail panel shows the node's fields (for example code content, file path, paper title, claim text) and its relations, with jumps to related nodes.

### 3.7 First-run tour

The first time you open the graph, a two-step onboarding tour appears. Step 1 covers the default research-spine view and double-click to expand; step 2 covers the top color-chip filters. Step through with "Next", or "Skip". It can be re-triggered later.

## 4. Citation chips in reports

With ScienceMemory on, the agent's final summary report carries clickable `[alias]` chips. Each chip in the report body corresponds to a piece of cited content, either evidence extracted from a paper or an artifact produced by code. Click a chip to pop up that evidence or artifact's detail and source chain, so each conclusion can be verified link by link. A chip-less report is treated as incomplete.

## 5. Troubleshooting

| Symptom | What to check |
|---|---|
| Settings shows `degraded` | Neo4j is down or 7474 is unreachable. `curl -s http://127.0.0.1:7474` for JSON; check `docker ps` / `systemctl status neo4j`. |
| Shows `needs-password` | Password not pushed to the sidecar. Go back to settings, enter the password, save; if already entered, confirm it matches what Neo4j was set to. |
| Changed `src` but rerun shows old behavior | After editing source you must `pnpm build` and restart, or you run the stale build. |
| Graph is empty | This session has produced no execution events yet (the task chain is mirrored only when code runs / literature searches complete). Run a task first. |
| Can't reach host Neo4j from Docker | With loopback, `127.0.0.1:7474` means the container itself. Set the Neo4j HTTP address to something reachable from inside the container (for example `host.docker.internal:7474` or the host IP), and make sure Neo4j listens beyond loopback. |

## 6. Next

- Architecture, node/edge types, full API: [ScienceMemory](../explanation/science-memory.md)
- End-to-end literature survey case (with ScienceMemory in action): [Literature research case guide](literature-research-case-guide.md)
- Environment variables, ports, data layout: [Configuration reference](../reference/configuration.md)
