# Contributing to ScienceDiscovery

Thanks for your interest in contributing. This document covers the development setup, the test commands, and the end-to-end environment. For what the project is and how to run it, start with the [README](README.md).

## Prerequisites

Everything listed under [README → Requirements](README.md#requirements): Linux x86_64/aarch64 or macOS x64/arm64, Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, and Git. Linux additionally needs Bubblewrap 0.6+ (0.8+ recommended); macOS uses the built-in `/usr/bin/sandbox-exec` Seatbelt launcher.

Run the stack once before running the full check suite — the API agent-path tests spawn the gateway and need its Python environment:

```bash
./scripts/start-stack.sh --mode local   # provisions .sciencediscovery-data/envs/{gateway,paper}
```

Alternatively, provide a standalone `services/gateway/.venv`.

## Development commands

```bash
pnpm check        # typecheck, paper tests, build, and package unit tests
pnpm test         # build + recursive package unit tests
pnpm smoke        # build + @sciencediscovery/api unit tests only
pnpm paper:setup  # locked PDF parser venv (project-local; app runtime uses .sciencediscovery-data/envs/paper)
pnpm paper:test   # PDF extraction tests
pnpm dev          # API watch (after build; does not start runner/gateway by itself)
pnpm --filter @sciencediscovery/web dev   # UI hot reload on :5173 (proxies API :4310)
```

## Agent-loop smoke tests

Targeted smokes, not wired into `pnpm smoke`; run from the repository root:

```bash
./test/api/run_m1_smoke.sh       # Node adapter (hermetic)
./test/api/run_real_smoke.sh     # adapter → gateway → live model → real tool
```

## Browser e2e (Playwright)

Requires an isolated running stack on `:4310` (or `E2E_BASE_URL`) and its
generated access token exported as `E2E_API_TOKEN`. Specs live in `test/`; the
local environment is **`.e2e/`** (fully gitignored: deps, reports,
screenshots). Committed bootstrap files under `test/` recreate it:

```bash
# first time (or after cloning)
node test/sync-e2e.mjs --write
cd .e2e && npm install # also links test/node_modules → .e2e/node_modules
./node_modules/.bin/playwright install chromium
npm test
```

Every npm test/list command first checks that `.e2e` exactly matches the
committed manifest, lockfile, and config. A stale copy fails with `BLOCKED`
before Playwright discovery; run `node test/sync-e2e.mjs --write` from the
repository root and repeat `npm install` in `.e2e`.

Specs are split into tagged Playwright projects. `mocked` contains only
explicitly tagged journeys driven by local stub models, needs no external
credentials, and is what `npm test` runs by default. (`E2E_API_TOKEN` still
authenticates the local stack.) `real` is a small set of natural-language user
smokes that call live LLMs or external services; the project only exists when
`E2E_REAL=1` is set. Untagged legacy specs are quarantined in a separate
explicit opt-in project:

```bash
cd .e2e
npm run test:mocked      # stable stubbed group
npm run test:real        # live group; explicit opt-in with declared credentials
npm run test:real:list   # safe discovery of the live group; does not run it
npm run test:mixed       # mocked + live groups; explicit opt-in
npm run test:list        # default mocked-only discovery check
npm run test:legacy:list # inventory quarantined, unaudited specs
npm run check:meta       # validates the per-test E2E-META comment blocks
```

Every migrated test carries an `E2E-META` comment (purpose, steps, environment,
mocked/real type, each external capability, credentials, cost/side effects)
checked by `test/check-e2e-meta.mjs`. New E2E files are organized by complete
user journey, not shell/Python/environment/internal modules, and reuse
`test/helpers/journeys.ts` for common user actions.

Journey specs (`test/journey-*.spec.ts`) are additionally written as numbered
**user steps** through the `journey` fixture:

```ts
await journey.step("打开工作台", "首页显示品牌与上手入口。", async () => { /* act + assert */ });
```

Each run writes `report.md` and a self-contained `report.html` — scenario goal,
preconditions, a step table, a per-step screenshot, and that step's key logs —
into the gitignored `.e2e/journey-reports/<spec>/<test>/`, for passing, failing,
and blocked runs alike. `check-e2e-meta.mjs` enforces the fixture, the scenario
declaration, and the absence of ad-hoc `page.screenshot()` in journey specs.

See [.agents/skills/e2e-testing/SKILL.md](.agents/skills/e2e-testing/SKILL.md)
for the full conventions, including the copyable journey skeleton, the automatic
HTTP/WebSocket guard, isolation, failure attribution, and
discovered/executed/skipped reporting.

Integration/e2e tests under `test/` are **not** part of `pnpm check`.

## CI layers

CI groups the commands above into three layer entry points. Reproducing a
pipeline failure locally means running the same one:

```bash
pnpm ci:ut    # both UT tiers: static checks, package tests, Python suites
pnpm ci:st    # build, then the hermetic agent-loop smoke
pnpm ci:e2e   # starts its own isolated stack and runs the @mocked journeys
```

Each writes `run.log` and a machine-readable summary below `CI_RESULTS_DIR`,
and gives the run a scratch data directory below `CI_RUNTIME_DIR`. Both default
to paths that exist only inside the `.ci` toolchain image, so outside that image
point them somewhere writable:

```bash
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:st
```

Live and hardware layers (`ci:st:real`, `ci:e2e:real`, `ci:st:npu`,
`ci:e2e:legacy`) fail closed behind their `CI_ALLOW_*` variables and are never
part of a default command. See [.ci/README.md](.ci/README.md) for the toolchain
image, the per-layer Docker commands, and the tag catalog used to select cases
(`pnpm ci:tags`, `pnpm ci:list`, `pnpm ci:run`).

### The two UT tiers

UT is split into exactly two tiers, and every UT case belongs to one of them:

```bash
pnpm ci:ut:host    # no sandbox: static checks, the Python suites, and every
                   # workspace package except the sandbox ones
pnpm ci:ut:guest   # the sandbox packages, which execute a real bubblewrap
```

`pnpm ci:ut` is the aggregate for a host that can run both, and is derived as
the host tier followed by the guest tier — it is not a third definition.

When you add a unit test, it inherits the tier of the package or suite it lives
in. Two rules keep the split honest:

- A host-tier test may not depend on a guest capability. If it needs
  bubblewrap or user namespaces, it belongs to a guest-tier package.
- A guest-tier assertion may not be weakened so the test can move to the host
  tier. Isolation and the sandbox's `/workspace` view are the point of those
  tests.

`.ci/test-catalog.mjs` lists the guest-tier packages; everything else is the
host tier by construction. `pnpm ci:catalog:check` fails when a package with
tests ends up in both tiers or in neither, when the aggregate stops equalling
the two tiers, when the guest tier grows an install or build step, or when a
`ci:ut:*` entry point appears outside the two tiers. `pnpm ci:selftest` runs
that guard's own regression tests, and the host tier runs it.

On macOS there is no guest tier: `services/runner/src/macos-seatbelt.test.ts`
lives in the guest tier's package and skips itself off macOS, so run
`pnpm --filter @sciencediscovery/runner test` natively to exercise Seatbelt.

### What each pipeline covers

Two test-layer pipelines run, and **neither runs everything**. GitCode
merge-request CI is CodeArts-only; this repository intentionally has no
`.gitcode/workflows/` Actions pipeline.

| Pipeline | UT | ST | E2E | Release binaries |
| --- | --- | --- | --- | --- |
| GitHub Actions — `.github/workflows/ci.yml` | full `ci:ut` | yes | yes | x86_64 + aarch64, smoke-gated |
| CodeArts debug — `.codearts/workflow/` targeting `ci/verify-pr-ci` | `ci:ut:host` + experimental `ci:ut:guest` in QEMU TCG | yes | — | x86_64 + aarch64 packages; smoke is host-dependent |

The CodeArts row above is a temporary `ci/verify-pr-ci`-only debug pipeline,
not a release gate for `main`. Its x86_64 and aarch64 jobs each call
`scripts/package-binary-release.sh` and verifies `SHA256SUMS`. The x86_64 job
runs directly on the hosted x64 runner and uploads its files to a run-specific
OBS path. The aarch64 job invokes the separately configured ARM CodeArts Build
task: the pipeline passes only `.ci/package-binary-codearts.sh`, line-oriented
environment records, and line-oriented arguments, while
the Build task's reusable bootstrap fetches both the target branch and MR ref,
rebases its system `COMMIT_ID` onto the current target, and calls
`.ci/codearts-build-dispatch.sh`. The integration SHA verifies the code being
built, while the original source SHA keeps artifact names and OBS paths
stable. The pasted bootstrap deliberately contains no backslashes because the
graphical Build shell action compiles its command as Groovy before invoking
Bash. It records
the real command status and full output even on failure so the following Build
step can upload available artifacts plus `run.log` and `exit-code` to the
run-specific aarch64 OBS path. A dependent pipeline job probes the binary,
`SHA256SUMS`, `VERSION`, `run.log`, and `exit-code`, then validates the recorded
exit code and checksum format, so an empty or misconfigured Build task cannot
produce a false successful result. Both paths probe bubblewrap before
packaging; if the runner cannot create user namespaces, they pass
`--skip-smoke` and log that the artifact is packaging-only rather than
claiming that the release smoke gate passed. Both Linux packaging paths fetch
the pinned micromamba conda package from the Tsinghua TUNA conda-forge mirror,
verify the package SHA256, extract `bin/micromamba`, and then verify the
executable against the existing release-binary SHA256. The mirror is limited
to this debug pipeline; normal runtime provisioning keeps its upstream URL.

CodeArts's `default` pool has the same shape. The job is a pod on a CCE
Kubernetes cluster (EulerOS 2.0 SP10, kernel 4.18, 16 CPUs, 31 GiB) running as
the unprivileged user `octopus` with Docker's default capability bounding set
and an active seccomp filter, so `unshare` and bubblewrap are refused outright;
`sudo` is not setuid, so nothing can be installed with `dnf` either. The
checked-in workflow runs `ci:ut:host` and the hermetic `ci:st` layer directly.
On this debug branch, a separate hosted x64 job experimentally runs the
existing `ci:ut:guest` entry point inside an Ubuntu VM under QEMU's
software-only TCG accelerator. The VM supplies an independent kernel whose
user namespaces work even though the outer CodeArts container denies them;
`/dev/kvm` is not requested. Its checksum-pinned qcow2 is pre-provisioned by
the separate `ci/codearts-resources` workflow, so a formal run injects the
current checkout and starts Runner UT without repeating apt, Node, pnpm, uv,
or bubblewrap installation. This is much slower than a native worker and does
not add E2E coverage. A self-hosted Linux resource pool that passes the real
bubblewrap probe remains the preferred long-term sandbox runner.

The parent CodeArts workflow also invokes the externally registered reusable
code-check child. That child runs SCA, anti-poison, static-analysis, and
blacklist CloudBuild tasks whose complete commands remain in CodeArts; it does
not write PR labels or comments. On merge-request runs, the parent reads each
child task's result JSON and renders its own `PASSED` or `FAILED` status and
detail link, alongside UT, ST, and both debug binary jobs, before publishing
the final PR label. Manual runs always execute UT/ST and both debug binary jobs
without modifying a PR; they run the PR-oriented child only when a `PR_ID` is
supplied.

## Repositories

GitCode and GitHub host **separate repositories**, and GitCode syncs to GitHub
periodically. They are not two remotes of one history: the same change lands
under a different SHA on each host.

| Host | Repository | Role |
| --- | --- | --- |
| gitcode.com | `openJiuwen/sciencediscovery` | where changes are proposed and reviewed |
| github.com | `openJiuwen-ai/sciencediscovery` | synced mirror |

Two consequences. A commit id is only meaningful alongside the host it came
from — `refactor: move domain capabilities into packages` is `c151f58` on
GitCode and `625d7e0` on GitHub, and neither resolves on the other. And a GitHub
remote can look diverged when the trees are identical, so compare trees
(`git diff --stat`) rather than SHAs before concluding that work is missing.

## Opening a merge request

**Run all three layers locally first.** No pipeline runs the full set, so review
otherwise starts from a change nothing has exercised:

```bash
pnpm ci:ut     # not ci:ut:host — the sandbox tests run only here and on GitHub
pnpm ci:st
pnpm ci:e2e
```

`ci:ut` and `ci:e2e` need a working sandbox. Check before blaming a change:

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok
```

On Ubuntu 24.04 a failure here is usually the AppArmor restriction on
unprivileged user namespaces, cleared with
`sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0`. Inside a
container it is normally unfixable for a process using that same host kernel;
a full-system VM can instead provide an independent guest kernel.

Then branch from an up-to-date `main`, push the branch, and open the merge
request on GitCode. Never push to `main`; rebase rather than merge when it
moves, so the diff stays readable.

```bash
git fetch origin && git checkout -b <type>/<short-topic> origin/main
git push -u origin <branch>
gitcode pr create -R openJiuwen/sciencediscovery \
  --head <branch> --base main --title "<type>: <what changed>" --body-file <file>
```

State in the body what was verified, with the numbers each layer reported.
"Tests pass" is not reviewable. If the change cannot pass a layer, say which and
why — do not weaken an assertion to get a green run.

Check `git status` before committing: no `.tmp/`, no local editor or tooling
config, no private notes.

## License headers

Every source file starts with the Apache-2.0 header below, written in that
file's comment syntax:

```text
Copyright (C) 2026-2026 Huawei Technologies Co., Ltd

Licensed under the Apache License, Version 2.0 (the "License");
you may not use this file except in compliance with the License.
You may obtain a copy of the License at

http://www.apache.org/licenses/LICENSE-2.0

Unless required by applicable law or agreed to in writing, software
distributed under the License is distributed on an "AS IS" BASIS,
WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
See the License for the specific language governing permissions and
limitations under the License.
```

Comment markers, matching what is already in the tree:

| Files | Marker | Reference |
| --- | --- | --- |
| `.ts`, `.tsx`, `.js`, `.mjs` | `//` on every line | [apps/web/src/session-activity.ts](apps/web/src/session-activity.ts) |
| `.py`, `.sh`, `.yml`, `.toml`, `Dockerfile` | `#` on every line | [.ci/run-e2e.sh](.ci/run-e2e.sh) |
| `.css` | `/*` block with ` * ` continuation lines | [apps/web/src/styles/conversation.css](apps/web/src/styles/conversation.css) |
| `.html` | one `<!-- -->` block | [apps/web/index.html](apps/web/index.html) |

The header is the first thing in the file, except where the format demands
something earlier — a shebang (`#!/usr/bin/env bash`) or a doctype
(`<!doctype html>`) — in which case it follows on the next line. Blank lines
inside the header stay commented (`//` or `#` with nothing after it), and one
uncommented blank line separates the header from the code.

### Exceptions

These do not carry a header:

- **Documentation and plain text** — `.md`, `.txt`, `LICENSE`, `CODEOWNERS`.
- **Formats with no comment syntax** — `.json` (including `package.json` and
  `tsconfig*.json`), `.python-version`, and similar. Do not invent a `//`
  comment to work around strict JSON.
- **Files generated in full by a script** — lockfiles such as `pnpm-lock.yaml`,
  and any artifact a generator writes end to end. Put the header in the
  generator instead, and have it emit one only when the output format supports
  comments. A file that is merely scaffolded and then edited by hand is not
  generated: it needs the header.
- **Binary assets** — images, fonts, PDFs.

## Architecture and docs

Module boundaries, the agent backend, and connector internals are documented under [docs/](docs/) (Chinese). Start with [docs/README.md](docs/README.md).
