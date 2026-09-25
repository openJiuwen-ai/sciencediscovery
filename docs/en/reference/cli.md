# CLI Reference

This page records the command-line behavior of the ScienceDiscovery single-file launcher and local source mode. For installation procedures, see the [deployment guide](../getting-started/deployment.md).

## Commands

```text
ScienceDiscovery serve [options]       Start the Web UI, control API, and sandbox runner
ScienceDiscovery run [input] [options] Run an Agent task against an already running serve
ScienceDiscovery extract --to <dir>    Extract the embedded runtime without starting services
ScienceDiscovery version               Print the build and embedded Node / CPython / micromamba versions
ScienceDiscovery help                  Show help
```

Local source mode has no `ScienceDiscovery` single-file launcher. Its CLI client entry point is:

```bash
node services/launcher/dist/main.js run ...
```

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

When used from a pipe or script, JSONL output is the default. A non-interactive process cannot answer permission cards, so the appropriate automatic-approval option must be set explicitly or the run is refused.

For exact options in the current build, use:

```bash
./ScienceDiscovery run --help
```

### Local source mode

Use:

```bash
node services/launcher/dist/main.js run ...
```

against the service started by `start-stack.sh`. Address and data-directory rules are the same as single-file mode.

### Docker

There is normally no reason to run `run` inside the container. A host-side client can connect to the published port and use the bind-mounted data directory or an explicit token.

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
