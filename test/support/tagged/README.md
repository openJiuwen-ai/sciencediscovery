# Deterministic, source-tagged tests

A test's metadata is its own source, and one frozen plan is what a developer
and CI both run. `pnpm test:shared` is that command; `pnpm ci:ut`, `pnpm ci:st`
and `pnpm ci:e2e` are slices of the same selector, so the merge gate cannot run
a different set from the one on a laptop. [MIGRATION.md](MIGRATION.md) records
which of the repository's existing cases are in that plan and why each of the
rest — live model, NPU, legacy quarantine, macOS, live Neo4j — is not.

Live-model, NPU and legacy work is **not** in the shared suite: it is tagged,
collected and then deselected, and it keeps its own explicitly opt-in entry
points. Selection cannot reach it by accident, and no environment variable can
make it appear in or disappear from a shared run.

No `.case.yaml` or `.suite.yaml` is introduced. `schema.json` is one shared,
closed tag vocabulary, not a registry of tests. Generated catalog/plan/result JSON
files are run artifacts and must not be committed as another source of metadata.

`pnpm test` keeps its own scope — build, the binary scripts, and each workspace
package's own `node --test` — and is unchanged by this. It is a package-level
loop, not the gate.

## Contract

A test's tags live with its declaration. Profiles are fixed queries in
`profiles.mjs`. Selection never reads the current OS, credentials, devices, live
services, or `CI_E2E_BACKEND`. A target matrix must be explicit.

The process is: collect declarations, validate tags, freeze a plan, check its
requirements, execute its exact identities, reconcile every result.

Zero selected instances, unavailable prerequisites, collection drift, focused
`.only` tests, runtime skip/xfail/todo, unplanned subtests, missing/duplicate
results, failing teardown, and a mismatching execution target all fail the run.
An exit code of zero alone is not sufficient. Results left by a previous run are
removed before starting a worker, so an early `exit(0)` cannot reuse stale PASS
records.

Identity reconciliation uses the testcase ID plus the concrete OS, architecture,
and executor, not just an aggregate count. Retry plugins are not enabled; repeated
pytest phases cannot be collapsed into an apparently clean pass.

## Tags

| Group | Values | Meaning |
| --- | --- | --- |
| `category` | `ut`, `st`, `e2e` | One test layer. |
| `os` | `linux`, `macos`, `windows` | Supported platforms; one or more. |
| `arch` | `amd64`, `arm64` | Supported architectures; one or more. |
| `npu` | `none`, `required` | `none` means **not required**, not forbidden. |
| `model` | `none`, `mock`, `real` | Model used by the system under test. |
| `executor` | `independent`, `native`, `jiuwenswarm` | Supported product backends, or independence. |
| `judge` | `none`, `llm` | Whether the test uses an LLM assertion. |

Three further groups are optional, and are what keeps this repository's plan
honest:

| Group | Values | Meaning |
| --- | --- | --- |
| `status` | `reviewed`, `external`, `legacy`, `unreviewed` | Only `reviewed` is in the shared suite. `external` needs a live third-party service, `legacy` is the unaudited quarantine, `unreviewed` is not yet fit to run. |
| `tier` | `host`, `guest` | Required on every `category:ut` test: `guest` needs a kernel that grants the user namespaces bubblewrap creates, `host` does not. A UT test without one fails the run. |
| `sandbox` | `none`, `bubblewrap`, `seatbelt` | The execution sandbox the test itself drives. A plan holding `sandbox:bubblewrap` fails preflight on a host where `bwrap` cannot start. |

Every collected test must resolve every required group. A closer declaration can override
a whole group inherited from its suite/module; it cannot silently union conflicting
single-valued values. Unknown tags, duplicate groups/values, and missing groups
are errors. `independent` is exclusive of other executor values.

Platform/executor support is expanded into concrete planned instances before a
query is evaluated. Thus a test supporting Linux and macOS can match `not os:linux`
on its macOS instance. An executor-independent test runs once per OS/architecture,
not twice just because both product executors appear in the target matrix.

## Node declarations

The Node 22 path uses a small declaration adapter because the current minimum
runtime cannot be assumed to provide the desired native structured tags. Actual
execution, hooks, failure handling, and reporting use `node:test`.

A repository test imports `compat.mjs`, not `node.mjs`: it returns the tagged
adapter during a shared run and plain `node:test` under a package's own
`pnpm test`, so one declaration serves both.

```javascript
import assert from 'node:assert/strict';
import { createTest } from './relative/path/to/tagged/compat.mjs';

const { test, describe, before, after } = createTest(import.meta.url, {
  tags: ['category:ut', 'os:linux', 'os:macos', 'arch:amd64', 'arch:arm64',
    'npu:none', 'model:none', 'executor:independent', 'judge:none',
    'status:reviewed', 'tier:host'],
});

describe('normalization', () => {
  test('normalizes a value', () => {
    assert.equal('ABC'.toLowerCase(), 'abc');
  });
});
```

Use inline test/describe callbacks and static names/tags. Literal constant arrays
and static `for...of` registration are supported. Setup belongs in test bodies or
hooks, not module initialization. `.only`, environment-dependent registration and
class static blocks are rejected. Runtime test registration is closed once
collection finishes. Dynamically generated `t.test()` subtests must be rewritten
as static declarations before migration; they are not silently omitted.

The source-contract audit uses the repository's existing TypeScript development
dependency. It is not a sandbox for malicious imports. Imported product modules
may initialize code; they must not contact live services or register tests during
collection. Pin dependency versions when comparing framework-expanded identities.

Direct `node --test` on a file that imports `node.mjs` intentionally fails with a
usage error rather than reporting a misleading zero-test success. A file that
imports `compat.mjs` runs normally there, on plain `node:test`, which is how each
package keeps its own `pnpm test`. The one thing that path does with the tags is
decline to register a file whose `os`/`arch` name another machine — it has no
plan and no target, so there is nothing for it to run. The shared plan is
unaffected: it reads the tags and never the host, so the same file is in a macOS
plan and out of a Linux one wherever either is created.
TypeScript source execution can use an explicit `--import tsx` after installing
the repository's existing dependencies.

## Python declarations

The pytest plugin uses a native marker, with normal module/class/function
inheritance and native parameter expansion:

```python
import pytest

pytestmark = pytest.mark.science_tags(
    category='ut', os=('linux', 'macos'), arch=('amd64', 'arm64'),
    npu='none', model='none', executor='independent', judge='none',
    status='reviewed', tier='host',
)

@pytest.mark.parametrize('value', [1, 2], ids=['first', 'second'])
def test_positive(value):
    assert value > 0
```

Marks and parameter tables must be literal. Custom decorators that can erase or
replace test declarations, environment-dependent registration, dynamic collection
hooks, and marker-based `-m`/`-k`/last-failed filtering outside the frozen selector
are rejected. Unselected items are **deselected before execution**, not skipped at
runtime. Selected items must pass setup, call, and teardown. `pytest.skip()`,
`pytest.xfail()` and skip/xfail marks cannot make a selected plan green.

The coordinator disables implicit third-party plugin autoload and environment
`PYTEST_ADDOPTS`; it does not silently adapt the selected set to a local plugin
installation. Additional needed plugins must be reviewed and integrated explicitly.

## Playwright declarations

A browser journey carries the same vocabulary in Playwright's own tag syntax —
`@group:value` — declared on the file's outer `describe`, since Playwright tags
are inherited by every test inside it:

```typescript
test.describe("journey-example.spec", { tag: ["@category:e2e", "@os:linux", "@arch:amd64",
  "@npu:none", "@model:mock", "@executor:independent", "@judge:none",
  "@status:reviewed", "@sandbox:bubblewrap"] }, () => {
  test("a user reaches the result", { tag: "@mocked" }, async ({ page }) => { /* … */ });
});
```

Playwright tags accumulate rather than override, so a file that mixes groups —
one live-model journey beside a quarantined one — declares the differing group
per test instead of on the describe. Tags that are not `group:value` (`@mocked`,
`@real`) are ignored by the collector and still select the Playwright project.
A journey reported as skipped, including a `test.fixme`, fails a run that
planned it; give it the tag that says why it cannot run instead.

## Commands

The shared suite is one command, and it is the same one CI runs:

```bash
pnpm test:shared              # freeze the plan, then run all of it
pnpm test:list                # freeze and print the plan only; runs no test body
```

`--slice ut|st|e2e|ut-host|ut-guest` narrows the same selector to the group a
CI job schedules; their union is `pnpm test:shared` exactly. `--output DIR`
chooses where the plan and evidence land (`.test-runs/<slice>/` by default,
`<CI_RESULTS_DIR>/<layer>/tagged/` under CI). `pnpm test:shared` prepares what
its slice needs first — the workspace build, the four service virtualenvs and
the pinned Chromium — so no separate setup step can disagree with it.
[MIGRATION.md](MIGRATION.md) records which existing cases the plan covers and
why each of the rest is outside it.

The harness has its own regression suite, which needs an interpreter with
pytest (`SCIENCE_TEST_PYTHON`; without it, `python3`):

```bash
SCIENCE_TEST_PYTHON=services/paper/.venv/bin/python pnpm test:tagged:selftest
```

`pnpm test:tagged:list` / `pnpm test:tagged:run` drive the same engine over an
explicit `--path` scope and an explicit `--select` expression. They are for
working on the harness itself and for the examples below; the repository's
suites are selected by `pnpm test:shared`, never by a hand-written scope.

```bash
pnpm test:tagged:list \
  --path test/support/tagged/examples/node.example.mjs \
  --path test/support/tagged/examples/python_example.py \
  --select 'category:ut and (model:none or model:mock) and judge:none' \
  --os linux --arch amd64 --executor independent \
  --output .test-runs/tagged-plan

# Execute the saved plan, with no new selection or automatic host-based rewriting.
pnpm test:tagged:run --plan .test-runs/tagged-plan/plan.json
```

Use `--os macos --arch arm64` when deliberately creating a macOS/ARM plan. Creating
that plan on Linux is valid; **executing** it on Linux fails preflight. This is an
explicit caller choice, never automatic filtering against the current machine.

Each selected file is hashed. Saved plans are hashed and checked again before
execution; re-collection must preserve the selected identities and source hashes.
The revision is recorded from Git, or explicitly with `--revision` for fixtures.
This initial patch does not attest to unchanged imported product code, dependency
installations, or a complete clean checkout; formal CI integration must additionally
pin/verify those inputs. Runtime artifacts are written under `.test-runs/` by
default. An explicit `--output` can be used to retain the plan, preflight result,
raw framework evidence, worker logs, and `summary.json`.

## LLM assertion tool

A semantic assertion is a function used alongside ordinary assertions, not a
mode that turns other assertions off. The actual criteria remain in test code:

```javascript
import { llmAssert } from './relative/path/to/tagged/llm-assert.mjs';

// Inside a test tagged judge:llm:
assert.equal(calculatedMean, expectedMean); // Objective checks stay programmatic.
await llmAssert({
  actual: report,
  criteria: ['Clearly identifies the delivered artifact',
    'Explains the analysis without unsupported claims'],
});
```

Python has the corresponding `from science_llm import llm_assert` helper.
There is no `hybrid` mode. `model:mock` + `judge:llm` still requires judge credentials
and the explicit real-call opt-in; it must not slip into a no-external-call gate.

No test in this repository is `judge:llm` today, so the shared selector excludes
the group entirely and no shared run can make a judge call. The helper and its
preflight are here so that a reviewed judge case can be added without the
selector or the gate having to change first.

Set `CI_ALLOW_REAL=1`, `E2E_JUDGE_BASE_URL`, `E2E_JUDGE_MODEL`, and
`E2E_JUDGE_TOKEN`. The subject model uses the independent `E2E_LLM_*` variables.
Credentials are not stored in tags or plans. The first transport is Chat
Completions-compatible. Malformed, missing, duplicate, non-boolean or negative
verdicts, HTTP failures, and timeouts fail the assertion. No automatic retry,
fallback, or evidence truncation is performed. Redirects are rejected. Known
credential values are redacted from archived reasons; raw prompts/answers are not
archived by default. A `judge:llm` test that never invokes the helper fails.

A model's qualitative judgment is not proof of numerical correctness. Keep
objective values and structural invariants checked with ordinary assertions.

## Integration boundary

Node, pytest and Playwright are collected and executed. The Node suites, the
four Python service suites, the mocked browser journeys and the two static
command checks are all in the one plan, and
[MIGRATION.md](MIGRATION.md) is the ledger of what that covers.

Everything in the plan is `executor:independent`. Schema and planning
understand `native` and `jiuwenswarm`, but the execution coordinator **fails
closed** on those product executors until real lifecycle/identity adapters are
connected; it does not copy a requested label into an alleged verified backend.
NPU capability must likewise be verified by an adapter — an environment
variable alone is not sufficient, which is why `npu:required` work stays on its
own opt-in layer.

The examples under `examples/` deliberately use non-default filenames so the
repository's own collection scopes do not pick them up.

Per-package `pnpm test` still works and still runs `node --test` directly:
[compat.mjs](compat.mjs) returns the native `node:test` module when a tagged
collection is not in progress, so a declaration carries its tags for the shared
plan without losing the ordinary loop of running one package's tests.

This staged boundary is intentional: an executable, tested foundation is useful,
but silently replacing all existing coverage with only the migrated subset is not.
