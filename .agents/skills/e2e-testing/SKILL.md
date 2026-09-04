---
name: e2e-testing
description: >
  Design, extend, and run ScienceDiscovery E2E user journeys through the
  browser, public HTTP API, CLI, or local product stack. Use when changing
  user-observable behavior, selecting mocked/real journeys, isolating a test
  stack, reporting user outcomes, or attributing an E2E failure. Browser
  journeys use the pinned Playwright environment in test/.
---

# User-perspective E2E testing

Project-local skill for **ScienceDiscovery**. E2E means simulating actual
product use from a user's goal to an observable outcome, not selecting a
particular test framework. Browser journeys use Playwright; public API, CLI,
and local-stack journeys also qualify when they cross the real product entry
point. Package tests, type checks, in-process calls to internal functions, or
assertions that only prove a request/click occurred are not E2E.

Read the shared target/isolation rules for every journey. For browser work,
follow the pinned Playwright, metadata, fixtures, and report rules below. For
non-browser work, follow [API / CLI / local-stack journeys](#api--cli--local-stack-journeys).
`pnpm ci:e2e` and the CI `e2e` layer still run the mocked **browser subset**;
they neither discover nor certify every kind of user-perspective E2E.

The primary unit of coverage is a **user journey**: one recognizable user goal
from entering the product through its observable outcome. Do not split the
main suite into internal-module specs such as `shell.spec.ts`, `python.spec.ts`,
or `environment.spec.ts`. Shell, Python, managed environments, subagents,
permissions, and artifacts should appear naturally as steps inside journeys.

A journey is written as **numbered user steps**, and every run writes a
step-by-step report a human can read without opening the spec. That contract is
mandatory for new work. Browser automation uses [Journey steps and automatic
reports](#journey-steps-and-automatic-reports-mandatory); API/CLI drivers record
equivalent steps and outcomes without requiring page screenshots.

## When to add coverage

When an implementation changes user-observable behavior, its implementer must
add or improve the relevant journey with the feature, unless existing coverage
already verifies the changed contract (identify and rerun it). Do not defer
journey coverage to PR preparation or another role. This includes Run outcomes,
tool execution, queryable versioned state, artifacts, permissions, failure
feedback, cancellation, and recovery, even when no page changes. An independent
tester, when assigned, designs scenarios from the user requirements rather
than copying implementation conclusions.

Choose the interface the user actually uses. API coverage complements but does
not replace browser checks for changed UI behavior. Cover success and the
relevant failure/repeat/cancel/recovery paths in proportion to risk.
Write **E2E: not applicable** only when there is no user-observable product
path affected (for example documentation/comments-only changes), and explain
why. **Backend-only / no new UI is not an exemption.** A missing environment
or journey driver is BLOCKED or a coverage gap, not “not applicable.”

## Target commit and worktree

Keep the repository's main worktree read-only. Obtain the target ref from the
test or review request, fetch that ref only when it is not available locally,
then resolve and record its immutable commit SHA. Do not automatically merge,
rebase, or replace the requested target with another branch. Only when the
requested target is `origin/master`, fetch it immediately before resolving and
testing that fetched SHA.

Use the task's assigned worktree by default. Before a formal run, commit the
candidate and record its immutable SHA; do not alter tracked files while that
SHA is under test. Create a detached, run-specific worktree only when the task
worktree is being rebased, fault injection must mutate it, or parallel runs
cannot otherwise isolate their ports/data:

```bash
git worktree add --detach .worktrees/e2e-<change>-<run-id> <target-sha>
```

Keep the target commit unchanged. Assemble dependencies, services, data,
ports, and evidence only in the assigned or explicitly justified E2E worktree,
using ignored or run-specific paths. Report the requested target ref, resolved
target SHA, worktree, and whether the run used any separate test-only derived
commit.

If validation reveals that code, a spec, or this skill must change, stop
treating the current run as validation of the target. Create and commit a new
candidate under the repository's development rules, then rerun E2E against
that new immutable commit.

## API / CLI / local-stack journeys

1. Start the isolated, committed product with `./scripts/start-stack.sh --mode local`,
   or a documented equivalent product entry point when testing that
   entry itself. Use `--no-build` only for artifacts built from the target SHA.
   Follow [Isolated stack per run](#isolated-stack-per-run) for ports, data,
   service URLs and authentication. Verify the services required by the journey;
   check the Web entry only when the journey uses it.
2. Drive the running product from a separate client through its supported HTTP
   API or documented CLI. A representative goal is: create a Project/Session,
   submit a request, handle any permission prompt, wait for the Run terminal
   state, retrieve the output/artifact, and confirm the Session can continue.
   Assert the documented result and feedback, not a hard-coded incidental tool
   order. Neither importing `createNativeAgent`/`createAgentRun` in-process nor
   starting only a test-constructed server substitutes for the product startup
   path. `/api/health` alone is a preflight, not this complete journey.
3. Store reusable non-browser drivers in `test/api/`, named after the user goal,
   with their exact root-level invocation and required environment documented.
   The existing `run_m1_smoke.sh` and `run_real_smoke.sh` directly instantiate
   the adapter: they remain smoke/integration checks, not E2E by location or
   name. There is currently no generic non-browser E2E command; inspect the
   committed driver or add the missing journey. Do not invent a `pnpm` entry
   point or claim `ci:e2e` ran it. Integrate future drivers into the existing
   test catalog when requested, without silently changing CI layer behavior.
4. Declare the same purpose, steps, environment, external capabilities,
   credentials, mocked/real choice and cost/side effects as E2E-META. Playwright
   tags, fixtures and `check-e2e-meta.mjs` apply to browser specs; a non-browser
   driver must document and enforce its own gates and reporting. Default to a
   journey-owned local model stub registered through the product API. Real
   models/services require explicit opt-in and documented costs. Browser
   network guards do not protect a CLI or backend: keep their configured
   endpoints local and audit all external calls as well.
5. Wait for observable status with bounded polling/stream consumption, not
   fixed sleeps. Record numbered user steps, expected/actual results, SHA,
   startup and driver commands, health, redacted request/response summaries,
   CLI exit status/output, and necessary service logs in `report.md` for PASS,
   FAIL and BLOCKED. Assert product-promised persistent records where relevant;
   internal database reads alone do not replace the user's access path. A
   driver must fail on a failed outcome and report missing prerequisites as
   BLOCKED, never as a successful zero-case run. No fake screenshots required.
6. Clean up only journey-owned records and processes in `finally`, after
   preserving evidence. Keep data and report files in the run's isolated
   directories; never publish credentials or commit generated results.

## Browser: the pinned Playwright, and nothing else

Use only the `@playwright/test` declared by `test/e2e.package.json`, assembled
into the gitignored `.e2e/` environment:

```bash
node test/sync-e2e.mjs --write
cd .e2e
npm install
./node_modules/.bin/playwright install chromium
```

Never use `npx playwright`, a globally installed Playwright, a throwaway npm
project, or system browser drivers. Every npm test/list command runs the
fail-closed `sync-e2e.mjs --check` first. If a committed manifest, lockfile, or
config differs from `.e2e`, synchronize and rerun `npm install`; never bypass
the check. Each worktree gets its own `.e2e/`; only the npm download cache and
the Playwright browser cache may be shared.

If Chromium exits at `sandbox_host_linux.cc` with `Operation not permitted`
inside an execution sandbox, classify it as test infrastructure and request an
approved run outside that sandbox. Do not work around it with extra unsafe
browser flags or a different browser binary.

## Isolated stack per run

Run formal E2E from the task's assigned immutable worktree or the explicitly
justified detached worktree described above, never from the main worktree or
an unrelated development worktree.

One run owns one worktree + SHA, one set of API/Runner/Gateway processes and
ports, one data directory, and one artifact directory. Parallel runs must be
fully isolated or serialized. Start the stack from the worktree root:

```bash
./scripts/start-stack.sh --mode local            # provisions and builds
./scripts/start-stack.sh --mode local --no-build # only if the build matches this SHA
```

Isolation variables (set for `start-stack.sh` and the API alike):

| Variable | Default | Meaning |
|---|---|---|
| `SCIENCE_AGENT_PORT` | `4310` | API/Web port |
| `SCIENCE_AGENT_RUNNER_PORT` | `4311` | where the runner listens |
| `SCIENCE_AGENT_RUNNER_URL` | `http://127.0.0.1:<port>` | **where the API dials** — the API does not read `SCIENCE_AGENT_RUNNER_PORT`, so on a non-default port always set the full URL too |
| `SCIENCE_AGENT_DATA_DIR` | `.sciencediscovery-data` | data root; also holds `envs/` (service venvs) |
| `SCIENCE_AGENT_AUTH_TOKEN` | generated when omitted | Optional server-side override; never assume a literal default |
| `E2E_API_TOKEN` | none | Required browser/API token; use the value printed/generated by this isolated stack |
| `E2E_BASE_URL` | `http://127.0.0.1:4310` | must point at the same API the fixtures use |
| `UV_CACHE_DIR` | uv default (`~/.cache/uv`) | Pin inside the run worktree (for example `$SCIENCE_AGENT_DATA_DIR/uv-cache`). The home cache sits outside the worktree and fails in environments that cannot write `$HOME/.cache`. |

After starting, verify API/Runner and any other service required by the
journey; verify the web entry for browser journeys. Export the stack's token
as `E2E_API_TOKEN`; browser global setup fails before the first scenario when
it is absent. Non-browser clients must use the same stack and authentication.
When a required service,
port, or credential is missing, record the run as **BLOCKED** with the missing
item — never skip silently.

Isolation traps that produce confusing failures:

- **Never share `.sciencediscovery-data/envs` between worktrees** (no symlinks). The service
  venvs are *editable* installs: their `.pth` files point back at the source
  tree of whichever worktree provisioned them, so a shared venv silently runs
  another worktree's code. Provision per worktree; `uv sync` is fast when
  `UV_CACHE_DIR` points at a worktree-local cache.
- **Pin `UV_CACHE_DIR` inside the worktree.** uv's default cache is
  `~/.cache/uv`. Export `UV_CACHE_DIR` to a run-owned path (for example
  `$SCIENCE_AGENT_DATA_DIR/uv-cache`) before `start-stack.sh` / `uv sync`. A
  permission error against the home cache is test infrastructure, not a
  product defect. npm and Playwright browser caches may still be shared as
  above; do not send uv's cache to `$HOME`.
- **Export every isolation variable explicitly.** A worktree under
  `.worktrees/` lives inside the main repository, and the gateway's dotenv
  loading searches parent directories, so the main repo's `.env` (its ports,
  data dir, model config) leaks into the gateway even when the worktree has no
  `.env`. Explicitly exported variables win over dotenv; alternatively copy a
  trimmed `.env` into the worktree as the run's baseline.

## Browser: discover, filter, run

For repository CI scheduling, use the cross-runner catalog from the repository
root before assembling a stack:

```bash
pnpm ci:tags
pnpm ci:list -- --tag layer:e2e --tag llm:stub --tag arch:amd64
pnpm ci:run -- --case e2e.mocked
```

Every catalog case declares `arch:*`, `llm:*`, `npu:*`, and `sandbox:*` plus
layer/container/network tags. Repeated `--tag` clauses mean AND; comma-separated
tags within one clause mean OR; `--exclude` removes matches. Keep `e2e.mocked`,
`e2e.real`, and `e2e.legacy` aligned with the Playwright projects below whenever
their requirements change. Never reclassify an unaudited dependency as safe:
use an `unreviewed` tag or keep the case unsupported until evidence exists.

The catalog chooses a CI-capability group; Playwright still discovers and
filters the individual specs in that group. Use the pinned `.e2e` commands
below for file/title-level discovery.

Run from `.e2e/` after synchronizing and installing the committed environment:

```bash
npm run check:meta                    # validate metadata, tags, quarantine
npm run test:list                     # list only @mocked (safe default)
npm test                              # run only @mocked (same as below)
npm run test:mocked                   # run only @mocked
npm run test:real:list                # discover only @real; makes no live call
npm run test:real                     # RUN live @real (explicit opt-in)
npm run test:mixed:list               # discover @mocked + @real
npm run test:mixed                    # RUN both groups (explicit opt-in)
npm run test:mocked -- foo.spec.ts    # one file, relative to test/
npm run test:mocked -- -g "title"     # semantic title filter
```

The mocked group is credential-free, not stack-free: start the isolated stack
before the default suite. Only explicitly self-contained specs such as the
network guard may run without it.

Grouping is enforced by the Playwright projects in
`test/playwright.config.ts`:

- `mocked` — only specs tagged `@mocked`. It is the sole default project and
  uses a journey-owned local stub model to drive deterministic, user-visible
  product contracts (for example permission feedback, tool process, artifacts,
  and environment state). It must be hermetic, credential-free, stable, and
  repeatable. Its custom `test` fixture installs the HTTP(S)/WebSocket guard
  before hooks or pages. The project also blocks service workers so they
  cannot bypass routing.
- `real` — specs tagged `@real`. The project is defined only when `E2E_REAL=1`
  is set, so no default command can trigger live LLM calls, network access, or
  paid usage. Without the variable, `--project=real` fails with "Project(s)
  'real' not found": that run is BLOCKED, not passed. Keep this group small:
  it is a smoke check that a real user can express the goal naturally and
  reach the outcome, not a duplicate deterministic matrix. Assert stable user
  invariants, never exact model wording or a single incidental tool sequence.
- `legacy` — untagged specs listed in `LEGACY` in
  `test/check-e2e-meta.mjs`. They are quarantined because their external
  behavior has not been audited. Use `npm run test:legacy:list` to inventory;
  run `npm run test:legacy` only with explicit approval and the same caution as
  real tests. During initial adoption, only pre-existing unaudited specs from
  the base branch may enter `LEGACY`; never place a newly written journey there.
  Migrate the list incrementally without making old specs undiscoverable.

`test:real` and `test:mixed` are execution opt-ins, not discovery commands.
Before using either, inspect E2E-META, confirm credentials/endpoints/costs and
record authorization. A skipped real test with a `BLOCKED:` reason remains
BLOCKED in the run report; zero failures does not turn blocked/skipped cases
into PASS.

## E2E-META: every browser test documents itself

Each `test()` carries an `E2E-META` comment directly above it and a matching
`{ tag: "@mocked" }` or `{ tag: "@real" }` option. `node test/check-e2e-meta.mjs`
enforces the fields and tag consistency (legacy files are warned until
migrated; new files must comply). Template:

```ts
/**
 * E2E-META
 * Purpose: <the user-visible behavior this verifies>
 * Steps:
 *   1. <main step>
 *   2. <main step>
 * Environment: <stack, base URL, services, ports, data/fixture preconditions>
 * Type: mocked | real
 * LLM: <none | local stub | provider/model/endpoint and nondeterminism>
 * WebSearch: <none | engine/endpoint and expected queries>
 * PaperSources: <none | PubMed/arXiv/etc. and expected queries/downloads>
 * MCP: <none | server/tools and expected calls>
 * OtherExternal: <none | any other network/process/service behavior>
 * Credentials: <none | exact env vars or seeded configuration>
 * CostSideEffects: <none | fees, rate limits, writes, messages, mutations>
 */
```

Mocked example:

```ts
/**
 * E2E-META
 * Purpose: A hung agent turn times out with a user-visible reason.
 * Steps:
 *   1. Register a silent local stub model over the API.
 *   2. Start a run and wait for the idle timeout.
 *   3. Assert the timeout reason in the session view.
 * Environment: Running stack at E2E_BASE_URL; isolated data; no models.
 * Type: mocked
 * LLM: local silent HTTP stub only; no live model.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — non-local browser requests are aborted.
 * Credentials: none
 * CostSideEffects: no cost; temporary records are deleted in finally.
 */
test("超时原因可追溯", { tag: "@mocked" }, async ({ page }) => {
```

Real example:

```ts
/**
 * E2E-META
 * Purpose: A live model run produces an anchored plan card.
 * Steps:
 *   1. Register the real model via env config; create project/session.
 *   2. Run a planning prompt; assert the card position.
 * Environment: Isolated stack at E2E_BASE_URL; E2E_SCREENSHOTS for output.
 * Type: real
 * LLM: real chat completions via E2E_LLM_BASE_URL; output varies.
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none
 * Credentials: E2E_LLM_BASE_URL / E2E_LLM_MODEL / E2E_LLM_TOKEN.
 * CostSideEffects: billable tokens and provider rate limits; creates isolated records.
 */
test("plan card anchors", { tag: "@real" }, async ({ page }, testInfo) => {
  requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  await requireRealStack(testInfo);
  // Check any seeded model/connector state here and testInfo.skip(true, "BLOCKED: ...")
  // only when that identifiable precondition is absent.
  await page.goto("/");
  // Product assertions after satisfied gates still FAIL normally.
});
```

## Journey steps and automatic reports (mandatory)

Every `test/journey-*.spec.ts` **must** be written as user steps through the
`journey` fixture. This is a requirement, not a suggestion:
`node test/check-e2e-meta.mjs` fails a journey spec that does not request the
`{ journey }` fixture, does not call `journey.scenario(...)`, does not call
`journey.step(...)`, or takes its own `page.screenshot()`.

### The rules

1. **One `journey.step()` = one user step.** Use the steps from the journey's
   design document. Merge adjacent micro-interactions (fill three fields, then
   save) into the step a user would name; never split by internal module and
   never make one step per click.
2. **The step description says what the *user* should see**, in the reader's
   language, not what the code asserts. Someone who has never read the spec
   must be able to follow the report.
3. **Every step's evidence comes from the helper.** It waits for the page to
   settle, screenshots, and files that step's console/network noise. Do not
   hand-roll `page.screenshot("01-...")` as primary evidence.
4. **`journey.scenario({ goal, preconditions })` is required**, at the top of
   the test. It supplies the report's goal and preconditions; without it the
   report falls back to the English E2E-META `Purpose`/`Environment`, which is
   contract text rather than an explanation for a reader.
5. **A report is written for every outcome** — passed, failed, and blocked —
   because the fixture tears the reporter down. Steps that already ran stay in
   the report when a later step fails, and the failing step keeps its own
   screenshot plus an error summary.
6. **Do not weaken an assertion to make a report green.** A journey that
   documents a known product gap stays FAIL and says so in its preconditions.

### What a run produces

`.e2e/journey-reports/<spec>/<test>/` (gitignored) receives:

| File | Content |
|---|---|
| `report.md` | Result, commit SHA under test (and whether the tree was dirty), spec file, group/tags, start/end/duration, scenario goal, preconditions, gate reason when blocked, the step table, and per-step detail |
| `report.html` | The same content, self-contained: inline CSS only, screenshots by relative path, opens from the filesystem with no network |
| `NN-<step>.png` | One screenshot per step, in step order; a step that failed or was blocked is suffixed accordingly |

Per-step "key logs" are browser `console` errors/warnings, page errors, failed
requests, and any response with status ≥ 400 — recorded as method, URL, and
status. Bodies are never captured. Every recorded string passes through
redaction: known credential variables, `Bearer` values, `token=`/`api_key=`
query parameters, the repository root, and the home directory are replaced. Keep
it that way; reports get published.

Both files are also attached to the Playwright HTML report, so a CI run carries
them without a separate copy step.

Set `E2E_JOURNEY_REPORTS` to redirect the output root. Never commit reports,
screenshots, or `.e2e/`.

### Shortest complete example

```ts
import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import { createProjectAndSession, openProjectSession, scriptedModel,
  sendUserMessage, waitForRunTerminal, expandToolStep, cleanupJourney } from "./helpers/journeys.ts";

/**
 * E2E-META
 * ... all eleven fields ...
 */
test("J9 用户可以拿到一次可核对的执行结果", { tag: "@mocked" }, async ({ journey, page }) => {
  journey.scenario({
    goal: "一位研究员要确认产品真的在本机执行了他要求的计算，而不只是在聊天。",
    preconditions: ["隔离栈已启动", "模型由旅程自带的本地 stub 驱动，不访问外部服务"],
  });

  const marker = `J9-${Date.now()}`;
  const stub = await scriptedModel([
    { arguments: { command: `echo ${marker}` }, tool: "run_shell" },
    { text: "The requested check completed." },
  ]);
  const fixture = await createProjectAndSession(page, {
    model: { apiToken: stub.apiToken, baseUrl: stub.baseUrl, model: stub.model, name: `J9 ${Date.now()}` },
    projectName: `J9 ${Date.now()}`,
    sessionTitle: `J9 ${Date.now()}`,
  });

  try {
    await journey.step(
      "进入会话并提出请求",
      "任务发出后运行走到完成态，主按钮回到可再次运行的状态。",
      async () => {
        await openProjectSession(page, fixture);
        const run = await sendUserMessage(page, fixture.session.id, "Check the workspace and report what you find.");
        expect((await waitForRunTerminal(page, fixture.session.id, run.id)).status).toBe("completed");
      },
    );

    await journey.step(
      "展开工具步骤核对输出",
      "工具步骤展开后能看到这次执行的真实输出，说明命令确实跑过。",
      async () => {
        await expect(await expandToolStep(page, { contains: marker })).toContainText(marker);
      },
    );
  } finally {
    await cleanupJourney(page, fixture);
    await stub.stop();
  }
});
```

A `@real` journey follows the same shape; put `requireRealEnv(...)` and
`await requireRealStack(...)` inside the **first** `journey.step`, so a run
without credentials still produces a report whose first step reads
`⛔ 前置未满足` with the gate reason.

### Migration pace for existing specs

Specs quarantined in `LEGACY` may adopt this incrementally; they are not
blocked on it. **A new file has no grace period**: any spec added as
`journey-*.spec.ts` complies on its first commit, and a non-journey spec that
grows into a full user flow should be renamed and converted rather than kept as
an untracked exception.

## Browser mocked rules

- The model is always a spec-owned local stub (`node:http` `createServer` on
  `127.0.0.1`, registered through `/api/models`) or a seeded fake such as the
  hang/slow models. Never read `E2E_LLM_*` in a mocked spec, and never rely on
  a real model configured in the stack's `.env`.
- Import `test` from `test/helpers/e2e.ts`, never directly from
  `@playwright/test`. Its automatic fixture aborts non-local HTTP(S),
  policy-closes non-local WebSockets, and forwards localhost/loopback traffic
  before any `beforeEach`, navigation, or request. `check-e2e-meta.mjs`
  enforces this import for every `Type: mocked` file, including fixme tests
  when later enabled.
- Keep `test/e2e-network-guard.spec.ts` passing as the request-level proof for
  blocked HTTPS/WebSocket and allowed local HTTP/WebSocket behavior.
- Backend egress cannot be intercepted from the browser; it stays local
  because the only model the spec registers is its own stub. When a mocked
  spec must prove a call happened, assert on the stub (request counters,
  captured bodies), not on timing.
- Mocked specs must pass repeatedly on a clean stack with no credentials.

## Browser real rules

- Real specs are explicit opt-in (`E2E_REAL=1`), tagged `@real`, and declare
  their external behavior and cost in E2E-META.
- At the start of **each real test body**, before `beforeEach`-equivalent
  navigation, API setup, LLM, search, paper-source, or MCP actions, call
  `requireRealEnv(testInfo, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN")`
  and `await requireRealStack(testInfo)`. Do not put the gate only at file
  scope. `check-e2e-meta.mjs` enforces both calls per real test body and their
  order relative to the first external action.
- If a real test genuinely needs no standard LLM credentials, call
  `allowRealEnvException(testInfo, "specific reviewed reason")`; the stack
  gate remains mandatory and the exception appears in test annotations.
- For seeded runtime state (for example, model registry or PubMed connector),
  call `testInfo.skip(true, "BLOCKED: ...")` with a specific reason before first use only
  when that identifiable precondition is absent. Once gates pass, product
  assertion failures must remain FAIL. Report all gate skips as BLOCKED, never
  as passes.
- Expect nondeterminism: assert user-visible invariants, not exact model
  output; use generous observable-condition waits, not fixed sleeps.
- Record what the run actually consumed (model, endpoints, connectors) and
  keep traces/screenshots so results can be reviewed without re-spending.

## Writing browser specs

- Organize files and `describe` blocks by user goal, not by implementation
  module. A journey may use shell, Python, an environment, a subagent, and
  artifact versioning in one coherent flow. Small negative/cancel/recovery
  cases may sit beside the journey they qualify. Name main-flow files after
  the goal (`journey-first-run.spec.ts`, `journey-deliver-result.spec.ts`),
  never after an internal tool (`shell.spec.ts`, `python.spec.ts`).
- Use `test/helpers/journeys.ts` for common user actions: model registration
  and selection, Project/Session setup, natural-language submission, Run
  terminal-state waiting, permission handling, timeline/tool-process reading,
  environment revision lookup, and opening the environment or artifact
  surfaces. Use `scriptedModel(mainSteps, subagentSteps?)` for deterministic
  tool/text sequences; it routes general-purpose subagent requests by their
  preset system marker. Use `expandToolStep(page, { contains })` with a
  journey marker instead of making `run_shell` or `run_python` the only
  locator. `artifactTree(page)` deliberately exposes the declared catalog,
  `@` candidates, and the opt-in physical workspace tree as separate views.
  The helpers return records, locators, and visible text; the spec still owns
  goal-specific assertions.
- Use the `journey` fixture from `test/helpers/e2e.ts` (implemented in
  `test/helpers/journey-report.ts`) to structure the test as user steps and
  produce its report. See [Journey steps and automatic
  reports](#journey-steps-and-automatic-reports-mandatory) for the full
  contract and a copyable skeleton.

- Prefer semantic locators (`getByRole`, `getByLabel`, `getByText`); when only
  a CSS hook works, that is also an accessibility signal worth noting.
- Wait on observable conditions (toast visible, button state, request
  finished); never sleep-and-hope. Assert user-visible outcomes, not merely
  that a request or click happened.
- Create test data with unique names (`Date.now()` suffix) and clean up in
  `finally` where practical; leftover data must stay in the run's own data
  directory.
- Long-term regression specs live in `test/`; throwaway diagnostic specs stay
  in the E2E worktree and are never committed.

## Browser screenshots, evidence, artifacts

- **Journey specs take no screenshots of their own.** `journey.step()` names
  them in step order, waits for the page to settle, and files them with the
  step they belong to. Add evidence by adding or resplitting a step, never by
  calling `page.screenshot()` — `check-e2e-meta.mjs` rejects that.
- Non-journey specs that still need an ad-hoc shot write to `screenshots/`
  relative to the Playwright cwd (i.e. `.e2e/screenshots/`), or to
  `E2E_SCREENSHOTS` when the spec supports it, named in step order.
- Shoot key success and failure states only after the target text/state is
  stable; avoid skeletons, animation remnants, and clipped controls. Journey
  screenshots already pass Playwright `animations: "disabled"` (and
  `caret: "hide"`) from `journey.step()`. Ad-hoc `page.screenshot()` calls
  must set the same `animations: "disabled"` option; omitting it leaves CSS
  transition ghosts in otherwise stable shots. Eyeball every screenshot after
  the run; retake any that does not match its caption — a screenshot that
  contradicts its step description is a report defect.
- Failures keep the automatic failure screenshot and trace
  (`trace: retain-on-failure`); reports land in `playwright-report/` and
  `test-results/` (including `results.json`) next to the config in use. Journey
  reports are additionally attached to each test in the Playwright HTML report.
- A run report references evidence by relative path inside the run's artifact
  directory and states: SHA under test, worktree, ports, config baseline,
  start and test commands, health status, per-case expected/actual, and
  failure attribution. Report discovered, executed, passed, failed, and
  skipped/fixme counts separately; discovered or skipped tests are not passes.
- Never commit `.e2e/` (which contains `journey-reports/`),
  `test/node_modules`, `test/playwright-report/`, `test/test-results/`,
  screenshots, traces, or logs — all gitignored. Committed files are the specs,
  `test/e2e.package.json` + `test/e2e.package-lock.json`,
  `test/playwright.config.ts`, `test/helpers/` (including
  `helpers/journey-report.ts`), `test/sync-e2e.mjs`, and
  `test/check-e2e-meta.mjs`.
- To hand a report to a reviewer, copy `report.md`, `report.html`, and that
  directory's `.png` files out as a unit — the HTML references the images by
  relative name, so the folder must stay together.

## Failure attribution

Prefer negative and fault injections that do not modify tracked files. Keep
the target worktree read-only. If tracked changes are unavoidable, use a
separate worktree derived from the target and create a test-only commit or an
exact index/patch snapshot before injection. Restore from that snapshot and
report the derived commit when present; never pollute the target candidate.

| Type | Judgment |
|---|---|
| Product defect | UI/API/Gateway/Runner/orchestration breaks the user goal or gives no reasonable feedback |
| External environment | A third-party dependency failed and the product prompted or degraded correctly |
| Test defect | Selector, wait, timeout, fixture, or assertion is wrong; the product behaves |
| Test infrastructure | Worktree/port/data clash, wrong service, build ≠ SHA, dependency assembly or discovery error |

A timeout is a tripwire, not a conclusion: confirm whether the run was issued,
the service responded, and the UI/API/CLI gave feedback. Every verdict needs at least
one piece of evidence (network log, console, service log, product message,
screenshot, trace); timeouts need two points along that chain. An external
failure the product swallows silently is still a product defect. Fix test or
infra problems and rerun; record `BLOCKED` when the cause cannot be separated.

## Cleanup

Archive evidence first, then stop the stack, free the ports, and remove run
data and `.e2e/` from the assigned worktree. Do not remove the task worktree;
its lifecycle belongs to the task owner. Remove a separate detached E2E
worktree only when this run created it for one of the justified isolation
reasons above. The main worktree must remain untouched.
