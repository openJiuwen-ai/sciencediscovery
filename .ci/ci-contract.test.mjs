// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, rm, symlink, writeFile } from "node:fs/promises";
import { dirname, isAbsolute, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";


import {
  assertCiContract,
  catalogProblems,
  defaultRepositoryRoot,
  utContractProblems,
  workspaceProjects,
} from "./ci-contract.mjs";
import * as catalog from "./test-catalog.mjs";
import { prepareRealE2EResults } from "./prepare-real-e2e-results.mjs";
import { resultsLabel } from "../test/support/tagged/shared.mjs";

// Repository-local, like the other script tests, so a fixture never lands
// outside the checkout CI cleans up.
const testRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", ".tmp", "ci-script-tests");

for (const runtimeKind of ["relative", "absolute"]) {
  test(`E2E exports one absolute data directory for ${runtimeKind} runtime paths`, async (t) => {
    await mkdir(testRoot, { recursive: true });
    const root = await mkdtemp(join(testRoot, "e2e runtime "));
    t.after(() => rm(root, { force: true, recursive: true }));
    for (const directory of [".ci", ".e2e/node_modules", "scripts", "test", "bin"]) {
      await mkdir(join(root, directory), { recursive: true });
    }
    await writeFile(join(root, ".ci/run-e2e.sh"), await readFile(join(defaultRepositoryRoot, ".ci/run-e2e.sh")));
    await writeFile(join(root, ".e2e/package.json"), "{}");
    await writeFile(join(root, "test/check-e2e-meta.mjs"), "// No browser or metadata collection in this fixture.\n");
    const executable = (file, body) => writeFile(join(root, file), `#!/usr/bin/env bash\nset -eu\n${body}\n`, { mode: 0o755 });
    // Exercise the real entry script, replacing only services and external tools.
    // The stack writes a marker before npm changes cwd, just as the shell fixture does.
    await executable("scripts/start-stack.sh", `
mkdir -p "$SCIENCE_DISCOVERY_DATA_DIR"
printf started > "$SCIENCE_DISCOVERY_DATA_DIR/started.txt"
printf '%s' "$SCIENCE_DISCOVERY_DATA_DIR" > "$PROBE_STACK"
exec sleep 30`);
    await executable("bin/curl", 'test -f "$PROBE_STACK"');
    await executable("bin/ss", "exit 0");
    await executable("bin/npm", `
test "$1" = --prefix
cd "$2"
node -e 'const fs = require("node:fs"), path = require("node:path");
fs.writeFileSync(process.env.PROBE_BROWSER, JSON.stringify({
  cwd: process.cwd(), data: process.env.SCIENCE_DISCOVERY_DATA_DIR,
  reports: process.env.E2E_JOURNEY_REPORTS,
  marker: fs.existsSync(path.resolve(process.env.SCIENCE_DISCOVERY_DATA_DIR, "started.txt"))
}));'`);
    const runtime = runtimeKind === "relative" ? ".tmp/runtime with spaces" : join(root, ".tmp/absolute runtime");
    const result = spawnSync("bash", [join(root, ".ci/run-e2e.sh"), "mocked"], {
      cwd: root,
      env: {
        ...process.env, PATH: `${join(root, "bin")}:${process.env.PATH}`,
        CI_E2E_BACKEND: "legacy", CI_E2E_FIXTURE: "standard", CI_E2E_PREPARED: "1", CI_E2E_PREPARE_ONLY: "0",
        CI_E2E_BROWSERS_DIR: "", CI_E2E_STACK_TIMEOUT_SECONDS: "5",
        CI_RUNTIME_DIR: runtime, CI_RESULTS_DIR: ".tmp/results with spaces",
        PROBE_STACK: join(root, "stack-data.txt"), PROBE_BROWSER: join(root, "browser-data.json"),
      },
      encoding: "utf8", timeout: 15_000,
    });
    assert.equal(result.status, 0, `${result.error ?? ""}\n${result.stdout}\n${result.stderr}`);
    const browser = JSON.parse(await readFile(join(root, "browser-data.json"), "utf8"));
    assert.equal(browser.cwd, join(root, ".e2e"));
    assert.ok(isAbsolute(browser.data), "Playwright must not receive a relative data directory");
    assert.equal(browser.data, resolve(root, runtime, "data"));
    assert.equal(await readFile(join(root, "stack-data.txt"), "utf8"), browser.data);
    assert.equal(browser.marker, true, "Playwright must see the marker written by the stack");
    assert.equal(browser.reports, join(root, ".tmp/results with spaces/e2e-legacy/journey-reports"));
  });
}

/** A structured clone of the real catalog that a test can then break. */
function mutableCatalog() {
  return {
    layers: structuredClone(catalog.layers),
    tagDimensions: structuredClone(catalog.tagDimensions),
    testCases: structuredClone(catalog.testCases),
    jiuwenSwarmWrapper: [...catalog.jiuwenSwarmWrapper],
  };
}

function utCase(copy, id) {
  const found = copy.testCases.find((testCase) => testCase.id === id);
  assert.ok(found, `${id} is missing from the catalog`);
  return found;
}

/** A workspace whose one package's tests sit where the caller puts them. */
async function workspaceFixture(t, testFiles) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "ci-contract-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await writeFile(join(root, "pnpm-workspace.yaml"), "packages:\n  - services/*\n");
  await writeFile(join(root, "package.json"), JSON.stringify({
    scripts: {
      "ci:e2e": "node test/support/tagged/shared.mjs run --slice e2e",
      "ci:st": "node .ci/run-layer.mjs st",
      "ci:ut": "node .ci/run-layer.mjs ut",
    },
  }));
  await mkdir(join(root, "services", "runner"), { recursive: true });
  await writeFile(join(root, "services", "runner", "package.json"),
    JSON.stringify({ name: "@sciencediscovery/runner", scripts: { test: "node --test" } }));
  for (const name of testFiles) await writeFile(join(root, "services", "runner", name), "// a test\n");
  return root;
}


test("the checked-in catalog satisfies the whole CI contract", async () => {
  await assertCiContract();
});

test("UT is one layer case and it runs the UT slice", () => {
  const utCases = catalog.testCases.filter((testCase) => testCase.tags.includes("layer:ut"));
  assert.deepEqual(utCases.map((testCase) => testCase.id), ["ut.all"]);
  assert.deepEqual(utCases[0].command, ["pnpm", "ci:ut"]);
  // Agent turns in the UT slice run on JiuwenSwarm; the wrapper starts it and selects nothing.
  assert.deepEqual(catalog.layers.ut,
    [["bash", ["scripts/with-jiuwenswarm.sh", "node", "test/support/tagged/shared.mjs", "run", "--slice", "ut"]]]);
});

test("a layer:ut case that runs something other than ci:ut is rejected", async () => {
  const copy = mutableCatalog();
  utCase(copy, "ut.all").command = ["pnpm", "ci:ut:host"];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /ut\.all: a layer:ut case must run pnpm ci:ut/);
});

test("an unknown tag value in the scheduler catalog is rejected", () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.all");
  target.tags = target.tags.map((tag) => (tag === "layer:ut" ? "layer:unclassified" : tag));
  assert.match(catalogProblems(copy).join("\n"), /ut\.all: unknown tag layer:unclassified/);
});

test("a case missing a required dimension is rejected", () => {
  const copy = mutableCatalog();
  const target = utCase(copy, "ut.all");
  target.tags = target.tags.filter((tag) => !tag.startsWith("sandbox:"));
  assert.match(catalogProblems(copy).join("\n"), /ut\.all: expected exactly one sandbox:\* tag, found 0/);
});

test("a layer that runs something other than a slice of the shared plan is rejected", async () => {
  const copy = mutableCatalog();
  copy.layers.ut = [["pnpm", ["--recursive", "test"]]];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /layer ut runs pnpm --recursive test, which is not a slice of the shared plan/);
});

test("the JiuwenSwarm wrapper may start the backend but may not replace the shared runner", async () => {
  const copy = mutableCatalog();
  copy.layers.ut = [["bash", ["scripts/with-jiuwenswarm.sh", "pnpm", "--recursive", "test"]]];
  const problems = await utContractProblems(copy);
  assert.match(problems.join("\n"), /layer ut runs bash scripts\/with-jiuwenswarm\.sh pnpm --recursive test, which is not a slice of the shared plan/);
  copy.layers.ut = [["bash", ["scripts/some-other-wrapper.sh", "node", "test/support/tagged/shared.mjs", "run", "--slice", "ut"]]];
  assert.match((await utContractProblems(copy)).join("\n"), /some-other-wrapper\.sh .* is not a slice of the shared plan/);
});

test("a package test file outside the collection scope is rejected", async (t) => {
  // `services/runner/src/**/*.test.ts` is collected; a sibling directory is not.
  const root = await workspaceFixture(t, ["stray.test.mjs"]);
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /services\/runner\/stray\.test\.mjs is outside the shared runner's collection scope/);
});

test("a package with a test script and no test file is rejected", async (t) => {
  const root = await workspaceFixture(t, []);
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /@sciencediscovery\/runner has a test script but no test file/);
});

test("a second UT entry point is rejected", async (t) => {
  const root = await workspaceFixture(t, []);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.scripts["ci:ut:macos"] = "pnpm build && node --test services/runner/dist/macos-seatbelt.test.js";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /script ci:ut:macos is a second UT entry point/);
});

test("an entry point that drifts off the shared runner is rejected", async (t) => {
  const root = await workspaceFixture(t, []);
  const manifest = JSON.parse(await readFile(join(root, "package.json"), "utf8"));
  manifest.scripts["ci:e2e"] = "bash .ci/run-e2e.sh";
  await writeFile(join(root, "package.json"), JSON.stringify(manifest));
  const problems = await utContractProblems(catalog, root);
  assert.match(problems.join("\n"), /script ci:e2e must run node test\/support\/tagged\/shared\.mjs run --slice e2e/);
});

test("an entry point's arguments reach the shared runner, also behind the JiuwenSwarm wrapper", () => {
  const forwarded = ["--", "--profile", "daily", "--coverage"];
  const [ut] = catalog.layers.ut;
  // The wrapper starts the backend; the planner's flags still have to arrive,
  // or a nightly would quietly run the merge-gate profile without coverage.
  assert.deepEqual(catalog.stepArguments(ut, forwarded).slice(-4), forwarded);
  assert.deepEqual(catalog.stepArguments(["node", ["test/support/tagged/shared.mjs", "run", "--slice", "st"]], forwarded).slice(-4), forwarded);
  // A step that is not the planner gets none of them.
  assert.deepEqual(catalog.stepArguments(["pnpm", ["install", "--frozen-lockfile"]], forwarded), ["install", "--frozen-lockfile"]);
});

/**
 * The actions/upload-artifact steps of a workflow: each step's name, the paths
 * it uploads and excludes, and whether it asks for hidden files. Read as text,
 * since the steps are regular and nothing here parses YAML.
 */
function artifactUploads(workflow) {
  return workflow.split(/\n(?= *- )/).filter((step) => /uses: actions\/upload-artifact@/.test(step)).map((step) => {
    const lines = step.split("\n");
    const at = lines.findIndex((line) => /^\s*path:/.test(line));
    const inline = lines[at].replace(/^\s*path:\s*/, "").trim();
    const block = [];
    for (const line of lines.slice(at + 1)) {
      if (!line.trim() || line.search(/\S/) <= lines[at].search(/\S/)) break;
      block.push(line.trim());
    }
    const listed = inline === "|" ? block : [inline];
    return {
      name: step.match(/- name:\s*(.+)/)?.[1] ?? "(unnamed)",
      artifact: step.match(/^\s+name:\s*(.+)$/m)?.[1],
      always: /^\s*if:\s*always\(\)\s*$/m.test(step),
      retention: Number(step.match(/^\s*retention-days:\s*(\d+)/m)?.[1]),
      missing: step.match(/^\s*if-no-files-found:\s*(\S+)/m)?.[1],
      paths: listed.filter((path) => !path.startsWith("!")),
      excluded: listed.filter((path) => path.startsWith("!")).map((path) => path.slice(1)),
      hidden: /^\s*include-hidden-files:\s*true\s*$/m.test(step),
    };
  });
}

/** The text of each job of a workflow, by job id. */
function workflowJobs(workflow) {
  const body = workflow.slice(workflow.search(/^jobs:\s*$/m));
  return Object.fromEntries(body.split(/\n(?= {2}[\w-]+:\s*$)/m).slice(1).map((job) => [job.match(/^ {2}([\w-]+):/)[1], job]));
}

const throughDotDirectory = (upload) =>
  upload.paths.some((path) => path.split("/").some((segment) => segment.startsWith(".")));

test("every artifact upload from a dot-directory includes hidden files", async () => {
  // upload-artifact@v4 leaves out whatever is named with a leading dot, the
  // given path included: `path: .ci-results` uploads nothing and only warns.
  const directory = join(defaultRepositoryRoot, ".github", "workflows");
  const uploads = [];
  for (const file of (await readdir(directory)).filter((name) => name.endsWith(".yml"))) {
    for (const upload of artifactUploads(await readFile(join(directory, file), "utf8"))) uploads.push({ file, ...upload });
  }
  const fromDotDirectories = uploads.filter(throughDotDirectory);
  assert.deepEqual(fromDotDirectories.filter((upload) => !upload.hidden).map((upload) => `${upload.file}: ${upload.name}`), []);
  // Not vacuous: the layers' results are among the uploads it checked.
  for (const name of ["Upload UT results", "Upload ST results", "Upload E2E results"]) {
    assert.ok(fromDotDirectories.some((upload) => upload.name === name), `${name} was not found`);
  }
  // And it catches the step as it was.
  const [before] = artifactUploads(
    "      - name: Upload E2E results\n        uses: actions/upload-artifact@v4\n        with:\n          name: e2e-results\n          path: .ci-results\n          if-no-files-found: warn\n",
  );
  assert.ok(throughDotDirectory(before) && !before.hidden);
});

test("each layer uploads the coverage its run wrote, whichever profile ran it", async () => {
  // Nightly runs the gate with `profile: daily`. The runner used to put that
  // run under `daily-ut/`, the fixed `ut/` upload found nothing, and the
  // Coverage job failed on artifacts that were never uploaded. Every profile
  // now writes to the slice's own directory and records itself in plan.json.
  const ci = await readFile(join(defaultRepositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const jobs = workflowJobs(ci);
  for (const layer of ["ut", "st"]) {
    const uploads = artifactUploads(jobs[layer]);
    const coverage = uploads.find((upload) => upload.name === `Upload ${layer.toUpperCase()} coverage data`);
    const results = uploads.find((upload) => upload.name === `Upload ${layer.toUpperCase()} results`);
    assert.ok(coverage && results, `${layer}: upload steps not found`);
    const written = `.ci-results/${resultsLabel(layer)}/tagged/coverage`;
    assert.deepEqual(coverage.paths, [written]);
    // The results artifact leaves out the same directory, which the coverage artifact carries.
    assert.deepEqual(results.excluded, [written]);
  }
  // The directory does not depend on the profile: the runner takes none.
  assert.equal(resultsLabel.length, 1);
});

const scoreUploadPath = ".tmp/real-e2e-results";

test("real E2E uploads only staged scores and keeps complete evidence separately", async () => {
  const directory = join(defaultRepositoryRoot, ".github", "workflows");
  let checked = 0;
  for (const file of (await readdir(directory)).filter((name) => /\.ya?ml$/.test(name))) {
    const jobs = workflowJobs(await readFile(join(directory, file), "utf8"));
    for (const [jobId, job] of Object.entries(jobs)) {
      const uploads = artifactUploads(job);
      const scores = uploads.filter((upload) => upload.artifact === "real-e2e-results");
      const evidence = uploads.filter((upload) => upload.artifact === "real-e2e-evidence");
      if (!scores.length && !evidence.length) continue;
      const label = `${file}: ${jobId}`;
      assert.equal(scores.length, 1, `${label}: one score upload required`);
      assert.equal(evidence.length, 1, `${label}: one diagnostic upload required`);
      assert.deepEqual(scores[0].paths, [scoreUploadPath]);
      assert.deepEqual(evidence[0].paths, [".ci-results"]);
      for (const upload of [...scores, ...evidence]) {
        assert.equal(upload.always, true, `${label}: upload even when tests fail`);
        assert.equal(upload.hidden, true, `${label}: hidden result directories must be included`);
        assert.equal(upload.retention, 7);
        assert.equal(upload.missing, "warn");
        assert.deepEqual(upload.excluded, []);
      }
      assert.match(job, /- name: Stage real E2E scores\n\s+if: always\(\)\n\s+run: node \.ci\/prepare-real-e2e-results\.mjs/);
      assert.ok(job.indexOf("run: node .ci/prepare-real-e2e-results.mjs") < job.indexOf("name: real-e2e-results"));
      checked++;
    }
  }
  assert.ok(checked > 0, "no real E2E uploads checked");
});

test("mocked E2E keeps the complete HTML and results upload", async () => {
  const ci = await readFile(join(defaultRepositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const upload = artifactUploads(workflowJobs(ci).e2e).find((item) => item.artifact === "e2e-results");
  assert.ok(upload);
  assert.deepEqual(upload.paths, [".ci-results"]);
  assert.deepEqual(upload.excluded, []);
  assert.equal(upload.hidden, true);
  assert.equal(upload.always, true);
  assert.equal(upload.missing, "warn");
  assert.equal(upload.retention, 14);
});

async function filesBelow(root, relative = "") {
  const files = [];
  for (const entry of await readdir(join(root, relative), { withFileTypes: true })) {
    const path = relative ? `${relative}/${entry.name}` : entry.name;
    if (entry.isDirectory()) files.push(...await filesBelow(root, path));
    else if (entry.isFile()) files.push(path);
  }
  return files.sort();
}

test("the real E2E packaging fixture excludes diagnostics from scores without removing evidence", async (t) => {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "real-e2e-artifacts-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const allowed = [
    "benchmark-metrics.json",
    "real-research/e2e/test-results/benchmark-case/benchmark-metrics.json",
    "real-team/e2e/.hidden-case/team-metrics.json",
    "evolve/e2e/test-results/evolve-case/evolve-metrics.json",
    "e2e-real/tagged/plan.json",
    "e2e-real/tagged/summary.json",
    "e2e-real/tagged/preflight.json",
  ].sort();
  const diagnostics = [
    "real-research/e2e/test-results/benchmark-case/trace.zip",
    "real-research/e2e/playwright-report/data/trace.zip",
    "real-research/e2e/playwright-report/index.html",
    "real-research/e2e/test-results/child-trajectories.json",
    "real-team/e2e/test-results/team-children.json",
    "real-team/stack.log", "e2e-real/run.log", "e2e-real/.hidden-log",
    "real-research/prompt.txt", "real-research/model-output.json", "real-research/.env",
    "real-research/not-benchmark-metrics.json", "real-team/team-metrics.json.backup",
    "evolve/.evolve-metrics.json", "real-team/Team-metrics.json", "e2e-real/tagged/catalog.json",
    "e2e-real/tagged/nested/plan.json", "e2e-real/tagged/summary.json.log",
    "other/tagged/plan.json", "summary.json", "preflight.json",
    "misnamed-directory/benchmark-metrics.json/trace.zip",
  ];
  const privateFields = {prompt: "PRIVATE_FIXTURE prompt", delivery: {artifacts: [{text: "PRIVATE_FIXTURE output"}]},
    tool_errors: [{content: "PRIVATE_FIXTURE error"}], configuration: {token: "PRIVATE_FIXTURE credential"},
    turns: [{prompt: "PRIVATE_FIXTURE follow-up"}], run: {messages: ["PRIVATE_FIXTURE message"]}};
  const metadata = {schema_version: 1, integration_status: "passed", started_at: "2026-10-06T21:00:00Z",
    finished_at: "2026-10-06T21:01:00Z", generation_duration_ms: 60_000};
  const projected = new Map([
    ["benchmark-metrics.json", {...metadata, case_id: 58, evaluation: {status: "partial", gating: false,
      race: {status: "completed", overall_score: 0.72}, fact: {status: "completed", citation_accuracy: 80,
        verification_coverage: 75, effective_citations: 4}}}],
    ["real-research/e2e/test-results/benchmark-case/benchmark-metrics.json", {...metadata, case_id: "da-13-3", evaluation: {status: "passed", score: 87}}],
    ["real-team/e2e/.hidden-case/team-metrics.json", {...metadata, case: "TC-E2E-01", integration: "passed", evaluation: {status: "completed", total_score: 92, gating: false}}],
    ["evolve/e2e/test-results/evolve-case/evolve-metrics.json", {...metadata, case: "PUCT-COMPRESS",
      evaluation: {status: "completed", score: 0.61, baseline_gate_score: 0.55, best_gate_score: 0.63},
      llm_evaluation: {status: "error", total_score: null, gating: false}}],
    ["e2e-real/tagged/plan.json", {version: 1, profile: "daily", revision: "a".repeat(40), entries: [{id: "case-a"}]}],
    ["e2e-real/tagged/summary.json", {status: "FAIL", planDigest: "b".repeat(64), planned: 1, executed: 1, passed: 0, failed: 1, skipped: 0,
      results: [{key: "case-a@linux/amd64", outcome: "FAIL", actualTarget: {os: "linux", arch: "amd64"}}]}],
    ["e2e-real/tagged/preflight.json", {ok: true, planDigest: "b".repeat(64), problems: []}],
  ]);
  const contents = new Map(diagnostics.map(path => [path,
    path.endsWith("trace.zip") ? Buffer.from([0x50, 0x4b, 0x03, 0x04, 1, 2, 3]) : Buffer.from(JSON.stringify({fixture: path}))]));
  for (const [path, publicData] of projected) {
    const raw = structuredClone(publicData);
    if (path.endsWith("metrics.json")) {
      Object.assign(raw, privateFields);
      raw.evaluation.reason = "PRIVATE_FIXTURE judge output";
      raw.evaluation.judge_calls = [{response: "PRIVATE_FIXTURE response"}];
      if (raw.evaluation.race) raw.evaluation.race.report = "PRIVATE_FIXTURE article";
      if (raw.llm_evaluation) raw.llm_evaluation.error = "PRIVATE_FIXTURE credential in error";
    } else if (path.endsWith("summary.json")) {
      raw.problems = ["PRIVATE_FIXTURE runtime error"];
      raw.results[0].errors = ["PRIVATE_FIXTURE assertion output"];
    }
    contents.set(path, Buffer.from(JSON.stringify(raw)));
  }
  for (const [path, bytes] of contents) {
    await mkdir(dirname(join(root, ".ci-results", path)), { recursive: true });
    await writeFile(join(root, ".ci-results", path), bytes);
  }
  // A symlink with an allowed name must not copy a log or credential file.
  await mkdir(join(root, ".ci-results", "linked"));
  await symlink("../real-research/.env", join(root, ".ci-results", "linked", "team-metrics.json"));
  await symlink("../real-research", join(root, ".ci-results", "linked", "directory"));
  // Reruns cannot retain stale files from a previous staging operation.
  await mkdir(join(root, scoreUploadPath), { recursive: true });
  await writeFile(join(root, scoreUploadPath, "trace.zip"), "old diagnostic");
  const run = spawnSync(process.execPath, [join(defaultRepositoryRoot, ".ci", "prepare-real-e2e-results.mjs")], { cwd: root, encoding: "utf8" });
  assert.equal(run.status, 0, run.stderr);
  assert.match(run.stdout, /Staged 7 real E2E score\/plan files/);
  const ci = await readFile(join(defaultRepositoryRoot, ".github", "workflows", "ci.yml"), "utf8");
  const uploads = artifactUploads(workflowJobs(ci)["real-e2e"]);
  const scoreDirectory = join(root, uploads.find(upload => upload.artifact === "real-e2e-results").paths[0]);
  const evidenceDirectory = join(root, uploads.find(upload => upload.artifact === "real-e2e-evidence").paths[0]);
  assert.deepEqual(await filesBelow(scoreDirectory), allowed);
  assert.deepEqual(await filesBelow(evidenceDirectory), [...contents.keys()].sort());
  for (const path of allowed) {
    const text = await readFile(join(scoreDirectory, path), "utf8");
    assert.deepEqual(JSON.parse(text), projected.get(path));
    assert.doesNotMatch(text, /PRIVATE_FIXTURE/);
  }
  for (const [path, bytes] of contents) assert.deepEqual(await readFile(join(evidenceDirectory, path)), bytes);
});

test("missing or diagnostic-only real E2E results leave an empty score directory", async (t) => {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "real-e2e-empty-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  assert.deepEqual(await prepareRealE2EResults(root), []);
  assert.deepEqual(await filesBelow(join(root, scoreUploadPath)), []);
  await mkdir(join(root, ".ci-results"));
  await writeFile(join(root, ".ci-results", "trace.zip"), "diagnostic");
  assert.deepEqual(await prepareRealE2EResults(root), []);
  assert.deepEqual(await filesBelow(join(root, scoreUploadPath)), []);
  assert.equal(await readFile(join(root, ".ci-results", "trace.zip"), "utf8"), "diagnostic");
  // Incomplete writes remain diagnostic evidence, not malformed public scores.
  await writeFile(join(root, ".ci-results", "team-metrics.json"), "PRIVATE_FIXTURE truncated JSON");
  const run = spawnSync(process.execPath, [join(defaultRepositoryRoot, ".ci", "prepare-real-e2e-results.mjs")], {cwd: root, encoding: "utf8"});
  assert.equal(run.status, 0);
  assert.match(run.stderr, /Skipping an invalid real E2E score/);
  assert.doesNotMatch(run.stderr + run.stdout, /PRIVATE_FIXTURE/);
  assert.deepEqual(await filesBelow(join(root, scoreUploadPath)), []);
});
