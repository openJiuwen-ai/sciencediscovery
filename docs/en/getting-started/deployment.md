# Install ScienceDiscovery

Windows uses the desktop installer. Once it finishes you just open the app: no browser and no local service access token to paste.

On Linux you download the prepackaged single-file build, start it from a terminal, and open the interface in a browser.

The screenshots below show the Windows installer and the first-launch wizard in Chinese; the controls are in the same places in other languages.

## Prerequisites

### Windows

- Windows x64;
- about 2.6 GB of free space for the installation;
- 5 GB or more for the data directory, which prepares the Python runtime on first launch;
- at least one model provider API key.

### Linux

- glibc-based Linux on x86_64 or aarch64; musl-based distributions such as Alpine Linux cannot run this build;
- the bundled Node.js runtime requires glibc 2.28+ and a compatible libstdc++;
- Bubblewrap 0.6+, 0.8+ recommended, with unprivileged user namespaces enabled (Debian 11 ships 0.4.1, which is too old);
- network access on first launch to prepare the runtime dependencies;
- at least one model provider API key.

## First-launch setup on Windows

The first launch runs a three-screen setup wizard. You only go through it once.

### Choose the research workspace

Artifacts, intermediate results and the runtime environment all live in this directory. The default is
`C:\Users\<your user name>\AppData\Local\ScienceDiscovery`, and the wizard shows the free space on that drive;
it needs at least 5 GB. Once **Directory is writable** is confirmed, select **Next**.

![Choose the research workspace](../../images/install/win-07-workspace.png)

### Wait while the environment is prepared

The first launch prepares the Python runtime and its dependencies inside the data directory, which can take
a few minutes up to a quarter of an hour depending on disk speed and antivirus software. You can minimize
the window; the first preparation is not interrupted.

![Preparing the work environment](../../images/install/win-08-preparing.png)

### Choose a model provider

Pick a preset provider under **Provider type** (DeepSeek, Moonshot Kimi, Zhipu GLM, Z.AI, MiniMax, Alibaba Cloud
Model Studio, OpenAI, Anthropic, Google Gemini, SiliconFlow, OpenRouter, Ollama, and others). To use a
self-hosted or relay service, choose **Custom (enter the address manually)** and fill in **API protocol**,
**Base URL**, **API key** and **Model name**. **Refresh list** fetches the available models again.

Then select **Test and continue**.

![Choose a model provider](../../images/install/win-09-provider.png)

![A custom provider](../../images/install/win-10-provider-custom.png)

### Connection succeeds

On success the wizard shows **Connection succeeded** with the round-trip time. Select **Start using** to open
the main window. If the test fails, check the API key, base URL and model name, then select **Test again**.

![Connection succeeded](../../images/install/win-11-connected.png)

![Main window](../../images/install/win-12-home.png)

## Install and start on Linux

### Install Bubblewrap

```bash
sudo apt-get install -y bubblewrap   # Debian / Ubuntu
# Or
sudo dnf install -y bubblewrap       # Fedora / RHEL / openEuler
```

### Download the build

Download the file matching your architecture from the [Releases page](https://github.com/openJiuwen-ai/sciencediscovery/releases):

```text
ScienceDiscovery-<version>-linux-x86_64
ScienceDiscovery-<version>-linux-aarch64
```

Keep it on a local disk in your home directory, not on a network share or inside an archive.

### Start the service

In the directory that holds the download:

```bash
mv ScienceDiscovery-*-linux-"$(uname -m)" ScienceDiscovery
chmod +x ./ScienceDiscovery
./ScienceDiscovery serve
```

The first `serve` prepares some runtime dependencies and therefore needs network access; later launches reuse
the prepared environment. For offline hosts, prepare the data directory on a connected machine first, or point
the package sources at a mirror you can reach — see the [configuration reference](../reference/configuration.md).

### Open the interface

Open <http://127.0.0.1:4310>. If prompted, paste the local service access token from
`<data-dir>/secrets/auth-token` (default `.sciencediscovery-data/secrets/auth-token`) into the connection page and
save it. If `SCIENCE_AGENT_AUTH_TOKEN` is set, use that configured value. The printed `Open to sign in` URL is an
optional shortcut; startup logs are not required.

If ScienceDiscovery runs on a remote host, forward the port over SSH instead of exposing the service publicly:

```bash
ssh -N -L 4310:127.0.0.1:4310 <user>@<remote-host>
```

Then open <http://127.0.0.1:4310> in your local browser.

### Common commands

```text
ScienceDiscovery serve [options]        Start the web UI, control API and sandbox runner
ScienceDiscovery run [input] [options]  Submit an agent task to a running serve
ScienceDiscovery extract --to <dir>     Unpack the bundled runtime without starting it
ScienceDiscovery version                Print the release and bundled runtime versions
ScienceDiscovery help                   Show all commands and options
```

The most used startup options:

| Option | Effect |
| --- | --- |
| `--data-dir <path>` | Data directory |
| `--host <address>` | Web/API listen address |
| `--port <port>` | Web/API port |
| `--env-file <path>` | Read environment variables from a file |
| `--skip-sandbox-check` | Start the UI even when the sandbox is unavailable; code execution is then disabled |

The service listens on the loopback interface only. If you must expose it, configure a dedicated auth token first
and keep the network trusted.

## Troubleshooting

### The installer asks for administrator rights

Only **Install for all users** needs elevation. Choose **Install for me only** to install with a normal user account.

### The installer stays on its loading window

That is the package verifying and unpacking itself and usually takes seconds. If it never advances, copy the
installer to a local disk (not a network share or inside an archive) and run it again.

### The first launch prepares the environment for a long time

The first launch downloads and unpacks the Python runtime and the scientific packages. Real-time scanning by
antivirus software makes this much slower; add the install and data directories to its exclusions. Later
starts take a few seconds.

### The model connection test fails

Check, in order: that the API key is valid, that the **Base URL** includes the right path (often ending in `/v1`),
that the **model name** matches the provider's own name, and that this machine can reach the service. For a proxy,
see [Configure a network proxy](../advanced-setup/configure-network-proxy.md).

### Change the workspace directory

Open **System settings** in the app, change the data directory, and restart as prompted. Reinstalling also lets
you pick a different install location.

### Uninstall

Open **Settings → Apps → Installed apps**, find ScienceDiscovery and uninstall it. Uninstalling leaves your
chosen workspace directory in place; delete it manually if you no longer need it.

### Linux reports a missing `bwrap`

Install Bubblewrap as described above, then check:

```bash
bwrap --version
```

### Linux code execution fails with `could not build a sandbox`

Check the sandbox conditions before changing any system setting:

```bash
sysctl kernel.unprivileged_userns_clone
sysctl kernel.apparmor_restrict_unprivileged_userns
```

Some kernels do not expose one of these keys, which is normal. If `kernel.unprivileged_userns_clone` exists and is
`0`, unprivileged user namespaces are disabled; enable them and retry, or ask the system administrator.
If the AppArmor key is `1` and the error is a permission failure, confirm AppArmor is active with `sudo aa-status`,
then follow the [Ubuntu AppArmor note](https://discourse.ubuntu.com/t/understanding-apparmor-user-namespace-restriction/58007)
to give bwrap a profile. The mechanism is described in
[sandbox execution](../developer-docs/sandbox-execution.md).

Code execution can still fail while `/health` returns `ok`; in that case trust the sandbox error in the startup log.

### Linux: the browser says the token is invalid

Read the current token from `<data-dir>/secrets/auth-token`, or use the `SCIENCE_AGENT_AUTH_TOKEN` value, and paste
it into the connection page. Make sure it is the **local service access token**, not a model API key.

## Where to go next

With the installation done, follow the [end-to-end walkthrough](quick-start.md) to take one complete task through
statistics, external evidence, review and tracing.
