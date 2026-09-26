# Quick Start

This path has one goal: get you to a first inspectable ScienceDiscovery task as quickly as possible.

When you finish, you should be able to:

- open ScienceDiscovery;
- configure a working task model;
- make the Agent actually run a Python calculation;
- inspect the Markdown artifact it delivers in the workspace.

## 1. Start ScienceDiscovery on your system

### Linux: use the prepackaged binary

For Linux on x86_64 or aarch64, this is the shortest path.

You need:

- an API key for a supported model provider;
- Bubblewrap for isolated code execution.

Install Bubblewrap first:

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# Or: sudo dnf install -y bubblewrap # Fedora / RHEL / openEuler
```

Then download the ScienceDiscovery executable for your architecture from the [Releases page](https://github.com/openJiuwen-ai/sciencediscovery/releases) and rename it to `ScienceDiscovery`.

From the directory containing the file, run:

```bash
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

### macOS: use local source mode

Both macOS x64 and arm64 are supported. There is currently no prepackaged single-file macOS binary, so use local source mode. The sandbox uses the built-in Seatbelt mechanism; Bubblewrap is not required.

Make sure the machine has:

- Node.js 22.19+;
- pnpm 11.1.2;
- Python 3;
- uv 0.9+;
- Git;
- curl;
- an API key for a supported model provider.

Then run:

```bash
git clone https://github.com/openJiuwen-ai/sciencediscovery.git
cd sciencediscovery
git checkout feat/jiuwenswarm

scripts/jiuwenswarm.sh setup
./scripts/start-stack.sh --mode local
```

The first run installs and builds the required components, so it needs network access and takes longer than later starts.

After the project has already been built, later starts can use:

```bash
./scripts/start-stack.sh --mode local --no-build
```

### After startup

On both Linux and macOS, a successful startup prints an `Open to sign in` URL in the terminal. Open it in your browser to enter ScienceDiscovery.

Keep the startup terminal running. Closing it or pressing Ctrl-C stops the service.

If no sign-in URL appears, the browser cannot connect, or startup reports an error, see [first-run troubleshooting](deployment.md#first-run-troubleshooting-for-binary-and-local-mode).

> For Docker, air-gapped environments, Linux source builds, and complete deployment details, see the [deployment guide](deployment.md).

## 2. Configure a model

Open **System settings → Model registry**:

1. choose a preset provider or add one manually;
2. enter the provider details and API key;
3. select **Save & connect**;
4. confirm the connection test passes and choose a **Global default task model**.

The key here is your model provider API key. If the connection test fails, first check the API key, provider URL, model ID, and network connection.

## 3. Run your first scientific task

Create a Project and Session, then paste the complete task below into the message box:

```text
Complete a minimal data-analysis task and deliver the result as an inspectable scientific artifact.

Data:
temperature_c,yield_g
20,41
22,45
24,49
26,52
28,54
30,53
32,49
34,43

Requirements:
1. Save the data as temperature_yield.csv.
2. You must actually run Python for the calculations; do not estimate the numbers only in the reply.
3. Calculate the mean yield, the temperature with the highest yield, and the Pearson correlation between temperature_c and yield_g.
4. Briefly interpret the result and note that this small dataset alone cannot establish causality.
5. Write the complete analysis to first-analysis.md and declare it as an artifact.
6. In the final reply, explicitly name the artifact file.
```

If the first code execution asks for permission, review and approve the action, then let the task continue.

The goal is not a sophisticated scientific conclusion. It is to verify the smallest useful ScienceDiscovery loop: **understand the task → run a tool → create files → deliver an artifact**.

## 4. Confirm that it worked

Your first run is successful when all four are true:

- [ ] the task has finished and no longer appears as running;
- [ ] the timeline shows an actual code execution;
- [ ] `first-analysis.md` appears in the workspace;
- [ ] opening the artifact shows values produced by the calculation and a short interpretation.

Different models may phrase the report differently. That is expected; what matters here is that the tool actually ran and the artifact was created.

## 5. Where to go next

- To understand what ScienceDiscovery can do, see [Core capabilities](../README.md#core-capabilities).
- To follow complete real research examples, see [Domain guides](../README.md#domain-guides).
- For a concrete optimization walkthrough, see [Use PUCT to optimize a text compression algorithm](../domains/evolve-a-solution.md).
- To use Docker, build from source, or troubleshoot startup, see the [deployment guide](deployment.md).
