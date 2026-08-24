# ScienceDiscovery CI test image

This directory defines a source-free CI toolchain image and the repository
entry points for unit tests (UT), hermetic system tests (ST), and browser E2E.
The image contains Node.js 22.19, pnpm 11.1.2, Python 3.12, uv, bubblewrap,
build tools, and Playwright's Chromium system libraries. Product source and
test dependencies are supplied only by the checkout mounted at `/src`.

## Existing tests and CI mapping

| CI layer | Repository commands used | Scope |
|---|---|---|
| UT | `pnpm check`, then `pnpm memory-graph:test` | TypeScript type checks/builds and package tests, binary script tests, paper/gateway Python tests, and memory-graph pytest |
| ST | `test/api/run_m1_smoke.sh` after `pnpm build` | Hermetic Node-native agent loop through a local scripted OpenAI-compatible endpoint and a real workspace tool round trip |
| E2E | `.e2e` `npm run test:mocked` | Tagged `@mocked` Playwright journeys against an isolated API/Runner/Gateway stack |

The repository has no test layer literally named `ST`. This mapping uses the
current hermetic integration/smoke entry point as ST. In particular,
`test/gateway/run_m0_smoke.sh` does not exist on this revision and is not an
invented CI dependency. Live-model smoke tests and `@real` E2E are excluded
from every default command.

## Test tags and CI selection

`.ci/test-catalog.mjs` classifies every repository CI test family as a stable
case. It is metadata over the existing commands above, not a second test
suite. Tests inherit the environment envelope of their case; when one child
needs a stricter capability, split it into a separate case instead of weakening
the tag. Each case has tags for all required environment dimensions:

- `arch:amd64|arm64`
- `llm:none|stub|real|unreviewed`
- `npu:none|required|unreviewed`
- `sandbox:none|bubblewrap|host|unreviewed`
- `layer:ut|st|e2e`, `container:*`, and runtime `network:*`

List the vocabulary or cases without executing tests:

```bash
pnpm ci:tags
pnpm ci:tags -- --json
pnpm ci:list
pnpm ci:list -- --tag layer:e2e --tag llm:stub --tag arch:amd64
pnpm ci:list -- --tag llm:none,llm:stub --exclude npu:required
pnpm ci:list -- --tag arch:arm64 --json
```

Repeated `--tag` clauses are AND conditions. Commas inside one clause are OR,
and every `--exclude` removes a match. `--case <id>` selects exact case IDs and
can be combined with tags. JSON output is intended for CI matrix generation.

Run the selected existing entry points with the same filters:

```bash
pnpm ci:run -- --tag layer:st --tag llm:stub --tag arch:amd64
pnpm ci:run -- --case e2e.mocked
```

`ci:run` requires at least one positive `--tag` or `--case`, verifies the
native architecture, and preflights every selected case before starting any
of them. Live cases additionally require `CI_ALLOW_REAL=1` and their documented
credential variables. Legacy E2E requires `CI_ALLOW_LEGACY=1`. The NPU smoke
requires `CI_ALLOW_NPU=1` and an explicit `SCIENCE_AGENT_NPU_PYTHON` from the
dedicated NPU environment; it fails closed in this generic image. Its catalog
entry explains the host requirement. `pnpm ci:catalog:check`
validates that every case has exactly one value for each single-valued tag
dimension and only known tags.

The selector exposes UT as `ut.core` and `ut.runner`: the former contains
static checks and tests that do not need a real sandbox, while the latter owns
Runner tests that execute bubblewrap. The unchanged `pnpm ci:ut` command is the
convenient aggregate for workers that can run both.

## Build

Build the current host architecture. Using `.ci` as the build context makes it
impossible for the Dockerfile to copy the product checkout into a layer.

```bash
docker build --file .ci/Dockerfile --tag sciencediscovery-ci:test .ci
```

Build both supported Linux architectures and publish a manifest:

```bash
docker buildx build \
  --platform linux/amd64,linux/arm64 \
  --file .ci/Dockerfile \
  --tag <registry>/sciencediscovery-ci:<tag> \
  --push \
  .ci
```

For a local, non-pushed multi-architecture artifact, replace `--push` with
`--output type=oci,dest=sciencediscovery-ci.oci`. Docker cannot `--load` a
multi-platform manifest into its classic local image store.

## Source and result mounts

The repository has no submodules, so a plain checkout is enough. Mount a real
checkout rather than a linked Git worktree: a worktree's `.git` file points at
the main repository and is not portable into the container.

All commands use the same mounts. `<host-results>` should be a new or empty
directory for the run, and it must already exist and be owned by the invoking
identity: Docker creates a missing bind-mount source as root, and the container
then cannot write its reports.

Mount the checkout at `/src`, which is also the image's `WORKDIR`. Do not mount
it at `/workspace`: the Runner's bubblewrap sandbox mounts the Session
workspace over that exact path, so a checkout there is shadowed inside the
sandbox. Five Runner tests fail that way — the two `scientific-execution`
subcases lose their fake managed interpreter and exit 127, and the three NPU
Broker cases see their `/workspace`-prefixed arguments re-anchored into
doubled paths.

```text
-v <repo>:/src
-v <host-results>:/ci-results
```

The container installs into the mounted checkout, so `node_modules` ends up
bound to the container's pnpm store. The next host command then aborts with
`ERR_PNPM_ABORTED_REMOVE_MODULES_DIR_NO_TTY`, because pnpm wants to purge the
modules directory and refuses to do so without a TTY. Rebind it with
`CI=1 pnpm install --frozen-lockfile` before working on the host again, or give
the container a checkout of its own.

Run with the checkout owner's numeric identity so generated dependencies,
build output, and reports remain writable on the host and permission-sensitive
tests do not acquire root's bypass privileges:

```text
--user "$(id -u):$(id -g)"
```

The image also defaults to its unprivileged `node` user (UID/GID 1000), but the
explicit flag is portable to Linux agents whose checkout owner uses another
numeric identity.

Runner tests and mocked journeys execute bubblewrap inside Docker. Use the same
non-privileged sandbox allowances as the product's checked-in Compose file:

```text
--security-opt seccomp=unconfined
--security-opt apparmor=unconfined
--security-opt systempaths=unconfined
```

Do not add `--privileged` or mount the Docker socket. A host that denies
unprivileged user namespaces still blocks the real sandbox; see
[Known limits](#known-limits).

Optional cache volumes speed up repeated dependency and browser installs:

```text
--mount type=volume,source=sciencediscovery-ci-cache,target=/ci-cache
```

That volume is not only a cache: `CI_RUNTIME_DIR` defaults below it, so it also
holds the E2E stack's `data/envs`. Those service environments are *editable*
installs whose `.pth` files record the absolute source path, so a volume
populated from one checkout location is unusable from another. After changing
the mount path, drop `/ci-cache/sciencediscovery-e2e` and
`/ci-cache/sciencediscovery-tests` (or the whole volume); otherwise the stack
starts and the service dies with `ModuleNotFoundError`, and the E2E layer
reports BLOCKED because it never became healthy.

## One command per layer

From the repository root, substitute absolute host paths for `<repo>` and
`<host-results>`.

UT:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test pnpm ci:ut
```

ST:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test pnpm ci:st
```

E2E (mocked only):

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  --env E2E_COMMIT_SHA="$(git rev-parse HEAD)" \
  --security-opt seccomp=unconfined \
  --security-opt apparmor=unconfined \
  --security-opt systempaths=unconfined \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test pnpm ci:e2e
```

The selector can replace the final command on capability-driven workers. For
example, this runs only hermetic ST cases compatible with amd64 and no NPU:

```bash
docker run --rm \
  --user "$(id -u):$(id -g)" \
  -v <repo>:/src \
  -v <host-results>:/ci-results \
  sciencediscovery-ci:test \
  pnpm ci:run -- --tag layer:st --tag llm:stub --tag arch:amd64 --exclude npu:required
```

Set `CI_RESULTS_DIR` only when the result mount uses a different in-container
path. The default E2E invocation chooses internal loopback ports, generates an ephemeral
local API token, builds and starts its own stack, installs the pinned Chromium,
and always stops the stack while collecting reports. It never reads
`E2E_LLM_*` and cannot select the `real` Playwright project.

`E2E_COMMIT_SHA` gives journey reports an immutable revision even when the
mounted checkout is a linked worktree whose external Git metadata is not
visible in the container. A regular clone can still resolve its own SHA, but
passing the value explicitly keeps the command identical across both layouts.

The first E2E run downloads the Chromium revision pinned by
`test/e2e.package-lock.json`. The entry never invokes managed-environment
setup and defaults `SCIENTIFIC_ENVS=0`, so the mocked job does not access conda
channels. J3 therefore reports its managed-Python precondition as BLOCKED,
never as a pass. A separate, explicitly network-enabled job may set
`E2E_SCIENTIFIC_ENVS=1` and reuse a pre-seeded `CI_RUNTIME_DIR`; that setup is
outside the generic default command.

## Results

The host directory mounted at `/ci-results` receives:

```text
ut/
  run.log
  summary.json
st/
  run.log
  summary.json
e2e/
  run.log
  stack.log
  summary.txt
  playwright-report/
  test-results/                  # results.json, failure screenshots/traces
  journey-reports/               # report.md/html and step screenshots
selection/
  run.log                         # selected case commands and combined output
  summary.json                    # selection, tags, result paths and outcomes
```

`run-layer.mjs` stops at the first failing UT/ST command and records every
attempted command, exit code, and duration. It gives each run a unique
`SCIENCE_AGENT_DATA_DIR` below `CI_RUNTIME_DIR` (default
`/ci-cache/sciencediscovery-tests`) and removes it afterward, so tests cannot
leave generated logs or bootstrap tokens in the source mount. The E2E entry propagates
Playwright's exit code after copying reports, including failure evidence.

The default mocked suite currently has one known product failure: J4 expects
both the main Agent and subagent declared artifacts in the Project catalog,
but only the main artifact appears (F5). CI must keep that assertion and report
the E2E layer as failed until the product is fixed.

## Known limits

The default image is intentionally hermetic with respect to models and external
services. The following checks need capabilities that a generic repository CI
container cannot safely or reliably provide.

| Test or capability | Missing generic-container capability | Recommended execution |
|---|---|---|
| `test/api/run_real_smoke.sh` | Live model endpoint, credential, outbound network, billable/rate-limited calls | Separate secret-bearing job with `CI_ALLOW_REAL=1` and `SCIENCE_AGENT_LLM_BASE_URL`, `SCIENCE_AGENT_LLM_MODEL`, `SCIENCE_AGENT_LLM_API_TOKEN`; select `st.agent-loop-real` |
| `npm --prefix .e2e run test:real` and `journey-real-request.spec.ts` | Live OpenAI-compatible endpoint and `E2E_LLM_*`; the real project is deliberately absent by default | Dedicated job with `CI_ALLOW_REAL=1` and the three `E2E_LLM_*` variables; select `e2e.real`, never add it to `pnpm ci:e2e` |
| Real NPU workloads such as `services/runner/workloads/npu-smoke-test.py` | Vendor device nodes, drivers, runtime libraries, model/data assets, and usually a native aarch64/NPU host | Hardware-specific runner with explicit device mounts and its own acceptance record |
| Full bubblewrap execution when the host denies unprivileged user namespaces | Docker flags cannot override a host kernel/AppArmor policy that rejects user namespace creation | Run on a Linux worker with user namespaces enabled; record UT/E2E as BLOCKED if the bwrap preflight fails |
| Host-only sandbox fallback/full-profile validation | A container cannot reproduce every host `/proc/sys`, AppArmor, LXC, and distribution-specific bwrap combination | Keep the existing stubbed capability/unit tests in UT; run real preflight/fallback checks on representative native hosts |
| Playwright or sandbox runs for the other CPU architecture under QEMU | Browser sandboxing and timing under emulation are not representative and may not be supported by the downloaded browser | Build the two-platform manifest with buildx, but execute amd64 and arm64 jobs on native workers |
| Docker Desktop on macOS/Windows | The product runner requires Linux user/mount namespaces and bubblewrap | Use a native Linux CI worker or VM |
| J3 in the default mocked job | J3 intentionally does not install the base or access conda channels; the generic E2E command sets `SCIENTIFIC_ENVS=0` so startup cannot turn a user journey into environment provisioning | In a separate, explicitly network-enabled job, set `E2E_SCIENTIFIC_ENVS=1` and reuse a pre-seeded `CI_RUNTIME_DIR`; keep that opt-in out of the default command |

The tag catalog keeps unsupported generic-container capabilities discoverable
instead of silently dropping them. For example,
`pnpm ci:list -- --tag npu:required` lists `st.npu-smoke` with its limitation.
On a dedicated amd64 or arm64 NPU environment, set `CI_ALLOW_NPU=1` and point
`SCIENCE_AGENT_NPU_PYTHON` at the MindSpore-enabled interpreter before running
that selection. The generic image has neither dependency and remains blocked.

The hermetic `test/api/run_m1_smoke.sh` is supported and is the ST entry. A
missing historical/example command such as `test/gateway/run_m0_smoke.sh` is
not classified as unsupported; it simply is not part of this revision.
