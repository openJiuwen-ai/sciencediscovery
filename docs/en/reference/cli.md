# CLI Reference

This page records the command-line behavior of the ScienceDiscovery single-file launcher and local source mode. For installation procedures, see the [deployment guide](../getting-started/deployment.md).

## Commands

```text
ScienceDiscovery serve [options]       Start the Web UI, API, runner, and default JiuwenSwarm/adapter
ScienceDiscovery run [input] [options] Run an Agent task against an already running serve
ScienceDiscovery evolve <action> ...   List, inspect, watch, or stop evolve searches
ScienceDiscovery idea <action> ...     List, inspect, watch, pause, continue, or stop Idea Tree research
ScienceDiscovery extract --to <dir>    Extract the embedded runtime without starting services
ScienceDiscovery version               Print the build and embedded Node / CPython / micromamba versions
ScienceDiscovery help                  Show help
```

Local source mode has no `ScienceDiscovery` single-file launcher. Its CLI client entry point is:

```bash
node services/launcher/dist/main.js run ...
```

`evolve` and `idea` use the same entry point.

## `serve`

Common options:

| Option | Default | Purpose |
| --- | --- | --- |
| `--data-dir <path>` | `./.sciencediscovery-data` | Runtime data directory |
| `--host <address>` | `127.0.0.1` | Web UI / API bind address |
| `--port <port>` | `4310` | Web UI / API port |
| `--runner-port <port>` | `4311` | Runner port, loopback only |
| `--env-file <path>` | — | Read `KEY=VALUE` before startup; existing environment values win |
| `--bwrap <path>` | `bwrap` on PATH | Bubblewrap executable |
| `--skip-sandbox-check` | off | Start the UI without Bubblewrap; sandbox execution is unavailable |
| `--no-scientific-envs` | off | Do not initialize managed scientific environments |
| `--jiuwenswarm` | on | Use JiuwenSwarm; this is currently already the default |
| `--no-jiuwenswarm` | off | Use the native Agent loop; equivalent to `SCIENCE_AGENT_EXECUTOR=native` |

See [Configuration reference](configuration.md) for complete environment variables, ports, and storage layout.

The API and Runner bind to loopback by default. If you must expose the API, replace `SCIENCE_AGENT_AUTH_TOKEN` first and use `--host 0.0.0.0` only on a protected network.

## `run`

`run` is the command-line front end for an already running `serve`. It is useful for terminal workflows, scripts, and pipelines.

Start the service first:

```bash
./ScienceDiscovery serve
```

Then run a task from another terminal:

```bash
./ScienceDiscovery run "Analyze the CSV in the current workspace and generate a report"
```

By default it connects to `http://127.0.0.1:4310` and reads the authentication token from the same `--data-dir` used by `serve`. When both commands use the same data directory, no explicit token is normally required.

Agent-generated files are stored under:

```text
<data-dir>/projects/<project-id>/sessions/<session-id>/workspace/
```

They are not written to the shell's current working directory.

### Interactive mode

When invoked directly from a terminal, text mode is the default:

- final answer on stdout;
- progress on stderr;
- permission requests presented interactively.

### Non-interactive mode

When used from a pipe or script, JSONL output is the default. A non-interactive process cannot answer permission cards, so it must pass `--auto-approve` (or `--approval always_allow`) or the run is refused. Automatic approval applies to the tool actions of the run's session; direct host execution after a sandbox failure still needs explicit consent, so a non-interactive run that requests it waits.

To write only the answer to a file, select text output explicitly:

```bash
./ScienceDiscovery run --auto-approve --output text "Explain what a p-value does and does not tell you, in one paragraph" > answer.md
```

For exact options in the current build, use:

```bash
./ScienceDiscovery run --help
```

### Thinking and reasoning effort

`--thinking` and `--effort` set thinking for the model the run uses. Like `--model`, the choice is saved on the run's session.

| Option | Effect |
| --- | --- |
| `--thinking off` | Turn thinking off |
| `--thinking auto` | Leave thinking to the model's default |
| `--thinking on` | Turn thinking on at the session's current effort |
| `--effort <level>` | Think at `low`, `medium`, `high`, `xhigh`, or `max`; implies `--thinking on` |

The accepted values are exactly the choices the composer offers for that model. They are checked after `--model` is applied and before anything is saved or the run starts. A value the model does not accept fails the command with exit code 1 and a message that lists what the model does accept; in JSONL mode the message is an `error` line with `"code": "THINKING_NOT_ACCEPTED"`. This covers an effort level the model has no stop for, `off` on a model that cannot turn thinking off, and either option on a model without a thinking control. `--effort` together with `--thinking off` or `--thinking auto` is rejected as a contradiction. Without either option, the session's thinking is left as it is.

To compare efforts, run the same task once per level:

```bash
for level in high max; do
  ./ScienceDiscovery run --auto-approve --output text --effort "$level" "Summarize the dataset" > "answer-$level.md"
done
```

Each run records its effective thinking in `settingsSnapshot.thinkingMode` and `settingsSnapshot.thinkingEffort` of `GET /api/sessions/:sessionId/runs/:runId`; the effort applies only when the mode is `enabled`. The Reviewer and Idea Tree stages can have their own effort; those are settings, not `run` options. See [Thinking effort per role](runtime-behavior.md#thinking-effort-per-role).

### Local source mode

Use:

```bash
node services/launcher/dist/main.js run ...
```

against the service started by `start-stack.sh`. Address and data-directory rules are the same as single-file mode.

### Docker

There is normally no reason to run `run` inside the container. A host-side client can connect to the published port and use the bind-mounted data directory or an explicit token.

## `evolve` and `idea`

An evolve search (`/evolve-design`) and an Idea Tree research (`/idea-tree`) keep running on the server for minutes to hours after the turn that started them has ended. These two commands list, inspect, follow, and control them from a terminal. They call the same HTTP routes as the Web cards, so stopping from the CLI has the same effect as **Stop** on the evolve dashboard or **End research** on the Idea Tree card. Like `run`, they connect to an already running `serve`, read the token from the same `--data-dir`, and accept `--token`, `--host`, `--port`, and `--output <jsonl|text>`.

```text
ScienceDiscovery evolve list [--session <id>]
ScienceDiscovery evolve get <run-id> [--candidate <hash>]
ScienceDiscovery evolve watch <run-id> [--after <sequence>]
ScienceDiscovery evolve stop <run-id>

ScienceDiscovery idea list --session <id>
ScienceDiscovery idea get <research-id> --session <id>
ScienceDiscovery idea watch <research-id> --session <id>
ScienceDiscovery idea pause|continue|stop <research-id> --session <id>
```

| Action | `evolve` | `idea` |
| --- | --- | --- |
| `list` | Every search, newest first; `--session` narrows it to one session, as the route's `sessionId` filter does | The research in the session given by `--session` |
| `get` | Status, candidates, tokens, cost, and best node; `--candidate <hash>` prints that candidate's source instead | Status, phase, round, tokens, and each candidate with its score |
| `watch` | Streams the search's events until it ends | Streams the research's progress until it stops running |
| `stop` | Stops the search | Ends the research; an ended research cannot be continued |
| `pause` / `continue` | Not available: an evolve search cannot be paused | Pauses after the step in progress / resumes a paused or interrupted research |

Each command offers what its card offers: evolve has no pause, and Idea Tree research is addressed per session because its routes are. Find run ids with `evolve list` and research ids with `idea list`.

### Output

The convention is the same as `run`:

- On a terminal, text: tables and readable lines on stdout; connection notes and the final status of `watch` on stderr.
- In a pipe or redirect, JSONL: each object exactly as the route returns it, one per line — run records, event records (`{"sequence", "createdAt", "event"}`), and research views (`{"research", "graph"}`). `watch` adds `{"type":"reconnect"}` lines and ends with one `{"type":"result"}` line; a failure is a `{"type":"error"}` line. Nothing else is printed, so `jq` works directly.

```bash
# Searches that are still running
./ScienceDiscovery evolve list | jq -r 'select(.status == "running") | .id'

# Keep a search's events and branch on how it ended
./ScienceDiscovery evolve watch "$RUN" > events.jsonl && echo "search succeeded"

# Save the source of the best candidate
best=$(./ScienceDiscovery evolve get "$RUN" | jq .bestNodeIndex)
hash=$(jq -r "select(.event.type == \"expanded\" and .event.nodeIndex == $best) | .event.codeHash" events.jsonl)
./ScienceDiscovery evolve get "$RUN" --candidate "$hash" --output text > best.py
```

### `watch`

`watch` replays what has already happened, then follows live, and returns when the engine stops running; for a run that has already ended it returns at once. When the connection drops, for example because of a network interruption or a `serve` restart, it reconnects with growing pauses for about three minutes and continues where it stopped. Evolve resumes after the last event sequence it printed, so no event is lost or repeated. An Idea Tree update carries the whole current state, so after a reconnect it shows the present state and skips an update it has already shown. To continue an evolve watch in a new process, pass the last `sequence` you kept to `--after`.

Ctrl-C stops watching, not the engine. Use `stop` for that.

The exit status follows `run` (0 completed, 1 failed, 130 cancelled):

| Exit status | `evolve` ended | `idea` ended |
| --- | --- | --- |
| 0 | `succeeded` | `completed` |
| 130 | `stopped` | `ended` or `paused` |
| 1 | `failed` or `budget_exhausted` | `interrupted` |

`watch` also exits 1 when the run is not found, the token is refused, or the connection cannot be recovered, and 130 on Ctrl-C.

## `extract`

```bash
./ScienceDiscovery extract --to <dir>
```

Extracts the runtime embedded in the single file without starting services. It is mainly useful for debugging, inspecting release contents, or preparing a runtime in advance.

## `version`

```bash
./ScienceDiscovery version
```

Prints the ScienceDiscovery build identifier and embedded runtime versions. See [Binary packaging and releases](../developer-docs/binary-packaging.md) for build-identifier rules.
