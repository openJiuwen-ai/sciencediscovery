# Quick Start

This tutorial starts with a ready-to-run ScienceDiscovery executable, then configures a model and submits a first task.

> See the root [README](../../../README.md) for product scope and risk boundaries, the [deployment guide](../how-to/deployment.md) for complete deployment procedures, and the [configuration reference](../reference/configuration.md) for parameters and quotas.

## 1. Prepare the environment

- Linux on `x86_64` or `aarch64`.
- `bwrap` (Bubblewrap) for sandboxed command execution.
- A ScienceDiscovery executable matching the host architecture.
- At least one model-provider API key.

Bubblewrap must be provided by the host:

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# Or: sudo dnf install -y bubblewrap # Fedora / RHEL / openEuler
```

## 2. Start ScienceDiscovery

The following commands assume the `ScienceDiscovery` executable is in the current directory:

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

`serve` starts the gateway, runner, and API/Web UI and binds them to the local machine by default. Once startup completes, `serve` prints the access token for this installation; open <http://127.0.0.1:4310> and sign in with it. The Web UI opens its Connection settings automatically whenever the token it holds is rejected. Ctrl-C stops all child services.

In a second terminal, verify the API:

```bash
curl --fail http://127.0.0.1:4310/api/health
```

The top-level `status` is `ok` after a normal startup and `degraded` when the Runner is unavailable. See [REST API reference](../reference/rest-api.md#health) for field details.

See the [deployment guide](../how-to/deployment.md) for the complete deployment.

## 3. Configure a task model

Under **System configuration → Global defaults**, configure the provider base URL, model ID, and API token for the task model. See [Configuration reference](../reference/configuration.md) for supported environment variables and files.

## 4. Run a first scientific task

1. Create a Project and Session.
2. Enter a focused scientific question, such as “Summarize the current research objective and propose the next analysis steps.”
3. To analyze local material, upload a CSV or PDF that you are authorized to use and describe the analysis objective.
4. Review and approve the permission card shown for the first code execution or external-data access.
5. Inspect tool calls and execution results in the message timeline, and inspect generated files in the Artifact area.

Responses, tool calls, and generated artifacts depend on the configured model, enabled connectors, and supplied material; they are not fixed-output promises.

## 5. Next steps

- Deployment and process operations: [Deployment guide](../how-to/deployment.md)
- Environment variables, ports, quotas, and storage paths: [Configuration reference](../reference/configuration.md)
- Day-to-day runtime behavior: [Runtime behavior reference](../reference/runtime-behavior.md)
- Tool parameters: [Built-in tools reference](../reference/builtin-tools.md)
- System principles: [Overall runtime architecture](../explanation/architecture.md)
