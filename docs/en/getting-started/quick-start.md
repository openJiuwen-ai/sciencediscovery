# Quick Start

This tutorial uses a prepackaged Linux executable, then configures a model and submits a first task.
If you use macOS, prefer a source-built binary, or need Docker, follow the [deployment guide](deployment.md)
first and return here at [Configure a task model](#3-configure-a-task-model) once the service is running.

> See the root [README](../../../README.md) for product scope and risk boundaries, the [deployment guide](deployment.md) for complete deployment procedures, and the [configuration reference](../reference/configuration.md) for parameters and quotas.

## 1. Install a prepackaged binary

For the shortest Linux path, prepare:

- Linux on `x86_64` or `aarch64`.
- `bwrap` (Bubblewrap) for sandboxed command execution.
- A ScienceDiscovery executable for your Linux architecture, available from the
  [Releases page](https://github.com/openJiuwen-ai/sciencediscovery/releases).
- At least one external model API Key.

Bubblewrap must be available on your system:

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# Or: sudo dnf install -y bubblewrap # Fedora / RHEL / openEuler
```

For another operating system or deployment method, use the [deployment guide](deployment.md) instead.
After its service is running, continue with [Configure a task model](#3-configure-a-task-model).

## 2. Start ScienceDiscovery

The following commands assume the `ScienceDiscovery` executable is in the current directory:

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

`serve` starts the gateway, runner, and API/Web UI and binds them to the local machine by default. Once startup completes, `serve` prints the `Open to sign in` URL and the local service access token; open that sign-in URL in a browser to authenticate and save the local service access token automatically. (If opening <http://127.0.0.1:4310> directly, the Web UI presents a clear Connection onboarding guide where you can paste the token from the startup output and save.) Keep the sign-in URL private. The Web UI opens its Connection settings automatically whenever the token it holds is rejected. Ctrl-C stops all child services.

In a second terminal, verify the API:

```bash
curl --fail http://127.0.0.1:4310/api/health
```

The top-level `status` is `ok` after a normal startup and `degraded` when the Runner is unavailable. See [REST API reference](../reference/rest-api.md#health) for field details.

Binary packaging, source mode, and Docker are separate deployment paths. Their
prerequisites and complete commands are in the [deployment guide](deployment.md). For a
rejected local service access token, a `degraded` health status, Bubblewrap, or logs in
binary and local mode, use its [first-run troubleshooting](deployment.md#first-run-troubleshooting-for-binary-and-local-mode).

## 3. Configure a task model

Under **System configuration → Global defaults**, configure the provider base URL, model ID, and external model API Key for the task model. This is separate from the local service access token. See [Configuration reference](../reference/configuration.md) for supported environment variables and files.

## 4. Run a first scientific task

1. Create a Project and Session.
2. Enter a focused scientific question, such as “Summarize the current research objective and propose the next analysis steps.”
3. To analyze local material, upload a CSV or PDF that you are authorized to use and describe the analysis objective.
4. Review and approve the permission card shown for the first code execution or external-data access.
5. Inspect tool calls and execution results in the message timeline, and inspect generated files in the Artifact area.

Responses, tool calls, and generated artifacts depend on the configured model, enabled connectors, and supplied material; they are not fixed-output promises.

## 5. Next steps

- Deployment and process operations: [Deployment guide](deployment.md)
- Environment variables, ports, quotas, and storage paths: [Configuration reference](../reference/configuration.md)
- Day-to-day runtime behavior: [Runtime behavior reference](../reference/runtime-behavior.md)
- Tool parameters: [Built-in tools reference](../reference/builtin-tools.md)
- System principles: [Overall runtime architecture](../developer-docs/architecture.md)
