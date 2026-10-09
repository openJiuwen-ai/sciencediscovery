# Contributing to ScienceDiscovery

Thanks for your interest in contributing. This document covers the development setup, the test commands, and the end-to-end environment. For what the project is and how to run it, start with the [README](README.md).

## Prerequisites

Everything listed under [README → Requirements](README.md#requirements): Linux x86_64/aarch64 or macOS x64/arm64, Node.js 22.19+, pnpm 11.1.2, Python 3, uv 0.9+, and Git. Linux additionally needs Bubblewrap 0.6+ (0.8+ recommended); macOS uses the built-in `/usr/bin/sandbox-exec` Seatbelt launcher.

Run the stack once before running the full check suite — the API agent-path tests spawn the gateway and need its Python environment:

```bash
./scripts/start-stack.sh --mode local   # provisions .sciencediscovery-data/envs/{gateway,paper}
```

Alternatively, provide a standalone `services/gateway/.venv`.

The agent loop runs on [JiuwenSwarm](https://gitcode.com/openJiuwen/jiuwenswarm); set it up once before working on
anything agent-path related — a chat turn, tools, permissions, skills, or context assembly:

```bash
scripts/jiuwenswarm.sh setup                          # once: clone the pinned tag, install it, create the instance
./scripts/start-stack.sh --mode local --jiuwenswarm    # starts JiuwenSwarm if needed, then the stack
```

See [Local mode](docs/en/getting-started/deployment.md#local-mode-host-processes) for requirements, every environment
variable, and troubleshooting, and [JiuwenSwarm migration: status and hand-over](docs/en/reference/jiuwenswarm-migration-status.md)
for what is verified and what is still open.

## Development commands

```bash
pnpm test:shared  # the one plan CI runs: freeze it from source tags, then run all of it
pnpm test:list    # freeze and print that plan without running a single test body
pnpm test:run --category e2e --model mock   # any query over the tag dimensions
pnpm test:policy  # what each CI profile selects, as the dimensions themselves
pnpm check        # typecheck, paper tests, build, and package unit tests
pnpm test         # build + recursive package unit tests
pnpm smoke        # build + @sciencediscovery/api unit tests only
pnpm paper:setup  # locked PDF parser venv (project-local; app runtime uses .sciencediscovery-data/envs/paper)
pnpm paper:test   # PDF extraction tests
pnpm dev          # API watch (after build; does not start runner/gateway by itself)
pnpm --filter @sciencediscovery/web dev   # UI hot reload on :5173 (proxies API :4310)
```

Test sources are not part of the product build. `tsconfig.base.json` excludes
`**/*.test.ts` and `**/*.test.tsx`, so no package compiles a test into `dist/`
and the Docker image needs nothing from `test/`. They are still type-checked:
the root `tsconfig.tests.json` owns exactly those files, and `pnpm typecheck`
runs it after the per-package pass. A package's own `pnpm test` therefore runs
the sources, `node --import tsx --test "src/**/*.test.ts"`, and the quotes have
to stay — Node's test runner does that matching itself, and a pattern the shell
ate would leave the command passing with nothing run.

## Agent-loop smoke tests

Targeted adapter/integration smokes, not wired into `pnpm smoke`; run from the
repository root. These do not test the product startup and public client path,
so they are not E2E:

```bash
./test/api/run_m1_smoke.sh       # Node adapter (hermetic)
./test/api/run_real_smoke.sh     # live model → tool callbacks
```

Against a running JiuwenSwarm stack, `test/contract/jw-only/live.mjs` checks
what only that backend does — conversation continuity, todo planning, context
compression, history-restart:

```bash
./scripts/start-stack.sh --mode local --jiuwenswarm
node test/contract/jw-only/live.mjs
```

Browser E2E against JiuwenSwarm: `CI_E2E_BACKEND=jiuwenswarm .ci/run-e2e.sh mocked` (JiuwenSwarm must already be
running).

## User-perspective E2E

E2E simulates how a user actually uses the product, from a recognizable goal
through its observable outcome. Browser, public HTTP API, CLI, and local-stack
journeys can all qualify. A type check, package test, direct call to an internal
function, or assertion that a request was merely sent cannot replace that
journey.

When changing user-observable behavior, add or improve the relevant journey
with the implementation; if an existing journey covers the changed contract,
identify and rerun it. Do not leave coverage to PR preparation. Run outcomes,
tool execution, queryable versioned state, artifacts, permissions and failure
feedback count even without a new page. Select success, failure, repeat,
cancellation and recovery scenarios according to the risk. Only changes with
no affected user-observable product path (such as documentation-only edits)
may report **E2E: not applicable**, with a reason. “Backend-only / no UI” is
not such a reason; unavailable prerequisites are BLOCKED, not an exemption.

### Browser journeys (Playwright)

Requires an isolated running stack on `:4410` (or `E2E_BASE_URL`) and its
generated access token exported as `E2E_API_TOKEN`. That port, and the data
directory below `.e2e-data/`, are deliberately not the ones an instance you run
for yourself uses (`:4310`, `.sciencediscovery-data`): a test run gets its own,
so it can never drive — or be asked to empty — your own instance. Specs live in `test/`; the
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
checked by `test/check-e2e-meta.mjs`. New browser E2E files are organized by complete
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

### API / CLI / local-stack journeys

Start the real product from the assigned worktree at the committed SHA, using
run-specific data, ports and service URLs:

```bash
./scripts/start-stack.sh --mode local
# Only when this SHA has already been built:
./scripts/start-stack.sh --mode local --no-build
```

These are alternative startup commands, not two stacks to launch together.
In a separate client terminal, set `E2E_BASE_URL` to this API and
`E2E_API_TOKEN` to its generated token. Verify API/Runner and other required
service health first. Follow the E2E skill's isolation table; do not reuse
another run's data or ports. An equivalent documented product entry point is
allowed when testing that entry, but directly constructing an internal server
or Agent in the test process is not equivalent.

Drive the supported HTTP API or documented CLI as a user would: for example,
create a Project/Session, submit a request, handle permission feedback, wait
for its Run to finish, retrieve the resulting artifact or queryable state,
and check the Session remains usable. Health alone or a successful submission
without the final outcome is not sufficient. UI changes still need browser
coverage; an API journey is not a substitute for layout/interaction assertions.

Keep reusable non-browser journey drivers in `test/api/`, with goal-based
names and an exact invocation documented beside the driver. Inspect the
chosen script before running it: this directory also contains the in-process
smokes above, and there is no universal non-browser E2E runner today. Add the
missing journey when needed rather than renaming a smoke or claiming the
browser CI command covers it.

Default to a journey-owned local stub model registered through the API;
real models/services require explicit opt-in and declared credentials/costs.
The browser's network guard does not intercept backend or CLI traffic.
Non-browser drivers declare the same E2E-META information and enforce their
own precondition gates. Write numbered user steps and a `report.md` containing
SHA, startup/driver commands, environment, expected/actual outcomes, verdict
(PASS/FAIL/BLOCKED), redacted API responses or CLI output/exit codes, and
failure evidence. Preserve reports for all outcomes; no page screenshots are
required for a non-browser journey. Clean up only this run's records/processes
after saving evidence. See the [E2E skill](.agents/skills/e2e-testing/SKILL.md#api--cli--local-stack-journeys)
for the full contract.

Integration/E2E tests under `test/` are **not** part of `pnpm check`.

## CI layers

There is one plan and three layer entry points that slice it. `pnpm test:shared`
runs the whole plan; each layer runs the group CI schedules as its own job, and
the three groups together are exactly that plan:

```bash
pnpm test:shared   # all of it, in one process

pnpm ci:ut    # category:ut
pnpm ci:st    # category:st
pnpm ci:e2e   # category:e2e: starts its own isolated stack, runs the browser journeys
```

Which cases a command runs is decided by the tags each test declares in its own
source, read through the single selector in
[test/support/tagged/profiles.mjs](test/support/tagged/profiles.mjs). Nothing
about the machine takes part in that decision: no credential, device, installed
service or `CI_*` variable can add a case or remove one. A run then has to
execute every planned case — `selected == 0`, a missing prerequisite, a skip,
or `executed != planned` all fail it, so a layer cannot go green by running
less.

Live-model, NPU, legacy-quarantine and macOS work is deliberately not in that
plan. It is tagged, collected and deselected, and keeps its own opt-in entry
points. [test/support/tagged/MIGRATION.md](test/support/tagged/MIGRATION.md) is
the ledger: what the shared plan covers, what is outside it, and why.

The CI `e2e` layer is the mocked browser subset, not the definition of all
user-perspective E2E. Record separately executed API/CLI/stack journeys in the
E2E conclusion with their actual commands; these are not automatically
discovered by `pnpm ci:e2e`. `ci:st` remains the hermetic adapter smoke layer.

Each writes `run.log` and a machine-readable summary below `CI_RESULTS_DIR`,
and gives the run a scratch data directory below `CI_RUNTIME_DIR`. Both default
to paths that exist only inside the `.ci` toolchain image, so outside that image
point them somewhere writable:

```bash
CI_RESULTS_DIR=.tmp/ci-results CI_RUNTIME_DIR=.tmp/ci-runtime pnpm ci:st
```

Beside that, each slice writes its frozen plan and its accounting to
`<CI_RESULTS_DIR>/<layer>/tagged/` — `plan.json` (every selected identity, its
source hash, tags and target, and the profile that selected them), `preflight.json` (what the host was asked for
and what it had) and `summary.json` (`planned`, `executed`, `passed`, `failed`,
`skipped`, and each problem by identity). `pnpm test:shared` leaves the same
files in `.test-runs/<slice>/`. `CI_RESULTS_DIR=.test-runs node
.ci/tagged-summary.mjs` reads either layout back into one table, and is what
fails a CI job when a layer ran less than it planned. Read
`summary.json` rather than an exit code: a layer's own script can return zero
and still have executed fewer cases than it froze.

Coverage comes from the same run, never from a second one. `--coverage` makes a
layer record it while it executes the plan — `pnpm ci:ut -- --coverage` writes
it to `<CI_RESULTS_DIR>/ut/tagged/coverage/`, `ci:st` likewise — and
`pnpm coverage:report -- --layer ut=<dir> --layer st=<dir>` merges the layers
into `coverage/` without running anything. CI's Coverage job does exactly that
with the UT and ST jobs' uploads; see
[.ci/README.md](.ci/README.md#coverage-reporting).

Live and hardware layers (`ci:st:real`, `ci:e2e:real`, `ci:st:npu`,
`ci:e2e:legacy`) fail closed behind their `CI_ALLOW_*` variables and are never
part of a default command. See [.ci/README.md](.ci/README.md) for the toolchain
image, the per-layer Docker commands, and the tag catalog used to select cases
(`pnpm ci:tags`, `pnpm ci:list`, `pnpm ci:run`).

### The sandbox capability

UT is one layer. A test that drives a real bubblewrap sandbox declares
`sandbox:bubblewrap`, and the plan turns that tag into a preflight: a host that
cannot create the user namespaces bubblewrap needs fails the whole run instead
of quietly running the rest.

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok
```

On Ubuntu 24.04 a failure here is usually the AppArmor restriction on
unprivileged user namespaces:

```bash
sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0
```

Every CI job that needs the sandbox clears it the same way before using it.

When you add a unit test it inherits the tags of the file it lives in. Two
rules keep that honest: a test may not depend on a capability it does not
declare, and an isolation assertion may not be weakened so a test can run
without the sandbox — isolation and the sandbox's `/workspace` view are the
point of those tests.

`services/runner/src/macos-seatbelt.test.ts` carries `os:macos`, so a Linux
plan does not contain it at all — it no longer skips itself at run time. To
exercise Seatbelt, run `pnpm --filter @sciencediscovery/runner test` natively on
macOS.

`.ci/ci-contract.mjs` is the guard behind `pnpm ci:catalog:check`. It fails when
a package's test file sits outside the shared runner's collection patterns and
so would be run by no layer at all, when a package has a test script but no test
file, when a layer runs something that is not a slice of the shared plan, or
when an entry point drifts off that slice. `pnpm ci:selftest` runs that guard's
own regression tests, and the UT layer runs it.

### What the pipeline covers

**GitHub Actions is the only CI, and it is the gate.** It runs on the pull
request and decides whether a change is ready. gitcode.com is a read-only
mirror: nothing runs there.

| Job | Runs |
| --- | --- |
| UT | `pnpm ci:ut` — the `category:ut` slice, including the tests that drive a real bubblewrap sandbox |
| ST | `pnpm ci:st` — the `category:st` slice |
| E2E (mocked) | `pnpm ci:e2e` — the `category:e2e` slice on an isolated stack |
| Binary release | both architectures, each built and smoke-gated on its own runner |
| Docker image | a cold `docker compose build`, then the deployment contract against the running container |

`nightly.yml` (18:00 UTC) and `release.yml` (version tag) call `ci.yml` through
`workflow_call`, so they run exactly the table above; they add only a version
stamp and, for a release, the publishing step. They are not a second and third
definition of the gate.

The pipeline does not run the opt-in live layers — `ci:st:real`, `ci:e2e:real`,
`ci:st:npu`, `ci:e2e:legacy` — which need credentials, live endpoints or an
Ascend device. Run those deliberately, on a machine that has what they need.

## Repositories

GitCode and GitHub host **separate repositories**, and GitHub syncs to GitCode
periodically. They are not two remotes of one history: the same change lands
under a different SHA on each host.

| Host | Repository | Role |
| --- | --- | --- |
| github.com | `openJiuwen-ai/sciencediscovery` | where changes are proposed and reviewed |
| gitcode.com | `openJiuwen/sciencediscovery` | synced mirror |

This direction is the reverse of what it was: changes used to be proposed on
GitCode and mirrored to GitHub, and GitCode ran a CodeArts pipeline on the
merge request. Neither is true now — the mirror has no pipeline, and older
merge requests and any documentation that has not caught up describe the old
arrangement. Read a pairing from the direction in this table, not from which
number is lower.

Two consequences. A commit id is only meaningful alongside the host it came
from — `refactor: move domain capabilities into packages` is `c151f58` on
GitCode and `625d7e0` on GitHub, and neither resolves on the other. And a GitHub
remote can look diverged when the trees are identical, so compare trees
(`git diff --stat`) rather than SHAs before concluding that work is missing.

## Opening a pull request

**Run all three layers locally first.** GitHub Actions runs them again on the
pull request, so this is not the only check any more — it is the one that costs
a reviewer nothing. A change pushed unexercised spends eleven minutes of CI and
somebody's attention discovering what the local run would have said:

```bash
pnpm ci:ut
pnpm ci:st
pnpm ci:e2e
```

`pnpm test:shared` is those three in one process, on the same plan. Either way,
report the numbers each slice's `summary.json` gives — `planned`, `executed`,
`passed` — not "tests pass".

Which tests a CI profile takes is stated once, as dimensions rather than as a
selector string, in
[test/support/tagged/profiles.mjs](test/support/tagged/profiles.mjs).
`pnpm test:policy` prints them, each as the command that would ask the same
question by hand:

```text
pr:
  pnpm test:list --category ut --category st --category e2e --os linux --arch amd64 \
    --npu none --model none --model mock --judge none --status reviewed
  selector: (category:ut or category:st or category:e2e) and os:linux and …
  run it:   pnpm test:run --profile pr
```

`--profile pr|daily|release` picks one and `pr` is the default. The three
pipelines each name theirs: a pull request takes `pr`, `nightly.yml` takes
`daily`, and `release.yml` takes `release`, which is *defined as* `daily` — a
version tag is held to the nightly standard, not the merge one. All three
select the same set today; they diverge the moment a live-model or `judge:llm`
row lands, at which point the nightly and the tag need that row's credentials
or their plan fails its preflight.

CI names it as an argument (`pnpm ci:ut -- --profile release`) rather than an
environment variable, so the same commit and the same command always mean the
same plan and a tagged run's failure reproduces by copying the command.

`pnpm test:run` / `pnpm test:list` take one `--<group> <value>` per tag
dimension (`--category`, `--os`, `--arch`, `--npu`, `--model`, `--judge`,
`--status`, `--sandbox`) when you want something the shared plan excludes on
purpose — the live-model journeys, the legacy quarantine, a macOS target.
Repeating a group is OR within it, different groups are AND, and the flags come
from the tag schema rather than a hand-written list. That is a developer query,
not a CI entry point: CI uses `--slice`, which can only ever name a subset of
the shared plan.

In addition to those existing CI gates, report a user-perspective E2E
conclusion for affected product paths, including API/CLI/stack journeys when
appropriate. A green browser subset does not certify untested non-browser
behavior. Include the tested SHA, interface, scenario/expected/actual table,
commands and passed/failed/blocked/skipped counts. Only a change with no
affected user-observable product path may say **E2E: not applicable** and give
the reason; that statement does not turn an unrun CI layer into a pass.

`ci:ut` and `ci:e2e` need a working sandbox. Check before blaming a change:

```bash
bwrap --ro-bind / / --dev /dev true && echo sandbox ok
```

On Ubuntu 24.04 a failure here is usually the AppArmor restriction on
unprivileged user namespaces, cleared with
`sudo sysctl --write kernel.apparmor_restrict_unprivileged_userns=0`. Inside a
container it is normally unfixable for a process using that same host kernel;
a full-system VM can instead provide an independent guest kernel.

Then branch from an up-to-date `main`, **push the branch to your own GitHub
fork**, and open the pull request against `openJiuwen-ai/sciencediscovery`.
Never push task branches to an upstream repository on either host; never push
to `main`. Rebase rather than merge when `main` moves, so the diff stays
readable — and rebase onto the host's own `main`, since a branch based on one
host's history does not belong on the other.

Each contributor forks the upstream repo under their own GitHub login and keeps
that fork updated. Do not hard-code anyone's login; resolve it from
`gh api user --jq .login`. Note that `origin` here is GitCode, so it is not the
personal fork and not the host the pull request goes to.

```bash
git fetch github && git checkout -b <type>/<short-topic> github/main
git push -u github-fork <branch>
gh pr create --repo openJiuwen-ai/sciencediscovery \
  --head <github-login>:<branch> --base main \
  --title "<type>: <what changed>" --body-file <file>
```

Apply exactly one `release:*` label so the release note can group the change;
[.github/release.yml](.github/release.yml) lists the categories and
[the create-github-pr skill](.agents/skills/create-github-pr/SKILL.md) covers
choosing one and what to do without the access to apply it.

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

Module boundaries, the agent backend, and connector internals are documented under [docs/](docs/) in English and Chinese. Start with [docs/README.md](docs/README.md).

Before submitting documentation changes, run:

```bash
pnpm docs:check
```

The same command runs in the host UT tier. It checks heading progression,
blank-line and fenced-code structure, image alternative text, and the existence
of repository-local link and image targets. External URLs are deliberately not
requested by the gate, so an unavailable third-party site cannot make an
otherwise unrelated pull request fail.
