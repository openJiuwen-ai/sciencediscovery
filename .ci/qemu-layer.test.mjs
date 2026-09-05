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

/**
 * The guest runs tests and nothing else, which only holds while it refuses to
 * start on a workspace its host did not prepare. These cases pin that refusal:
 * without it the guest would quietly fall back to installing and building
 * under emulation, which is the cost the split removed.
 */

import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { copyFile, mkdir, mkdtemp, readFile, rm } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { test } from "node:test";

const ciDirectory = dirname(fileURLToPath(import.meta.url));
const script = join(ciDirectory, "run-qemu-layer.sh");
// Repository-local, like the other script tests: a fixture that reaches for
// the system temporary directory escapes the checkout CI cleans up.
const testRoot = resolve(ciDirectory, "..", ".tmp", "ci-script-tests");
// The host half needs an x86_64 Linux host before it reaches the handover
// check; elsewhere it refuses earlier and for a different reason.
const hostRunsGuests = process.platform === "linux" && process.arch === "x64";

function runScript(scriptPath, argument, environment = {}) {
  const result = spawnSync("bash", [scriptPath, ...(argument === undefined ? [] : [argument])], {
    encoding: "utf8",
    env: { ...process.env, ...environment },
  });
  return { output: `${result.stdout}${result.stderr}`, status: result.status };
}

/** A repository skeleton holding only what the host half inspects. */
async function skeleton(t, present) {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "qemu-layer-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, ".ci"), { recursive: true });
  await copyFile(script, join(root, ".ci", "run-qemu-layer.sh"));
  for (const path of present) await mkdir(join(root, path), { recursive: true });
  return root;
}

test("the host half names both layers it can run", () => {
  const { output, status } = runScript(script);
  assert.equal(status, 2);
  assert.match(output, /Usage: \.ci\/run-qemu-layer\.sh ut-guest\|e2e/);
});

test("an unknown layer is refused", () => {
  const { output, status } = runScript(script, "st");
  assert.equal(status, 2);
  assert.match(output, /'st' is not a layer this guest runs/);
});

test("the UT guest tier refuses a workspace its host did not build", { skip: !hostRunsGuests }, async (t) => {
  const root = await skeleton(t, ["node_modules"]);
  const { output, status } = runScript(join(root, ".ci", "run-qemu-layer.sh"), "ut-guest", {
    CI_RESULTS_DIR: join(root, "results"),
  });
  assert.equal(status, 1);
  assert.match(output, /services\/runner\/dist is missing; install and build on this host before running the ut-guest guest/);
});

test("the E2E guest refuses a workspace whose host did not prepare .e2e", { skip: !hostRunsGuests }, async (t) => {
  const root = await skeleton(t, ["node_modules", "apps/web/dist"]);
  const { output, status } = runScript(join(root, ".ci", "run-qemu-layer.sh"), "e2e", {
    CI_RESULTS_DIR: join(root, "results"),
  });
  assert.equal(status, 1);
  assert.match(output, /\.e2e\/node_modules is missing; install and build on this host before running the e2e guest/);
});

test("the guest disables pnpm's dependency check with the setting pnpm actually reads", async () => {
  const guest = await readFile(join(ciDirectory, "qemu-guest-layer.sh"), "utf8");
  // pnpm 11 defaults verify-deps-before-run to "install" and reads the
  // override from `pnpm_config_`, not `npm_config_`; it also skips the check
  // only for a falsy value, so "false" would still run it. Getting either
  // detail wrong makes the guest reinstall the workspace it was handed.
  assert.match(guest, /^\s*export pnpm_config_verify_deps_before_run=$/m);
  // Node has no default per-test timeout and only names a subtest once it
  // finishes, so a stuck test stops the log with nothing attached and drains
  // the guest's whole budget.
  assert.match(guest, /--test-timeout=/);
  assert.doesNotMatch(guest, /(?<![a-z])npm_config_verify_deps_before_run/);
});

const workflowText = () => readFile(
  resolve(ciDirectory, "..", ".codearts", "workflow", "codearts-pipeline.yml"),
  "utf8",
);

function workflowJob(workflow, name) {
  const match = new RegExp(`\\n      ${name}:\\n([\\s\\S]*?)(?=\\n      [a-z0-9_]+:\\n|\\n    pre:\\n)`).exec(workflow);
  assert.ok(match, `job ${name} is missing from the workflow`);
  return match[1];
}

test("no workflow step spends the pipeline quota", async () => {
  const workflow = await workflowText();
  // CodeArts bills pipelines and build tasks separately, and the pipeline's
  // quota is the one that ran out. A step that runs shell, clones, or uploads
  // on a pipeline executor puts the whole run back on that quota.
  for (const forbidden of ["official_shell_plugin", "official_git_clone", "upload-obs"]) {
    assert.doesNotMatch(workflow, new RegExp(`uses: ${forbidden}`), `${forbidden} spends the pipeline quota`);
  }
  const uses = [...workflow.matchAll(/uses: (\S+)/g)].map((match) => match[1]);
  assert.ok(uses.length > 0);
  for (const value of uses) {
    assert.ok(
      ["official_devcloud_cloudBuild", "official_devcloud_subPipeline"].includes(value),
      `unexpected step kind ${value}`,
    );
  }
});

test("the emulated stack gets a health budget its services can meet", async () => {
  const stack = await readFile(resolve(ciDirectory, "..", "scripts", "start-stack.sh"), "utf8");
  // wait_healthy polls every 0.2s, and its per-mode defaults (50 and 300
  // attempts) are 10s and 60s -- native-speed figures. The failure is not
  // confined to the one sidecar that misses it: wait_healthy returning 1 trips
  // set -e, cleanup kills every started process, and the caller sees only
  // "the stack never became healthy".
  assert.match(stack, /SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS \* 5/);
  const guest = await readFile(join(ciDirectory, "qemu-guest-layer.sh"), "utf8");
  const perService = Number(/SCIENCE_DISCOVERY_HEALTH_TIMEOUT_SECONDS=(\d+)/.exec(guest)?.[1]);
  const wholeStack = Number(/CI_E2E_STACK_TIMEOUT_SECONDS=(\d+)/.exec(guest)?.[1]);
  assert.ok(Number.isFinite(perService), "the guest does not widen the per-service health budget");
  assert.ok(Number.isFinite(wholeStack), "the guest does not bound the whole stack");
  // runner, memory-graph, evolve and the API are waited on in turn, so the
  // budget only means anything if every one of them can spend it in full.
  assert.ok(
    perService * 4 < wholeStack,
    `${perService}s per service does not fit four services inside ${wholeStack}s`,
  );
});

test("the guest reports why an unhealthy stack never came up", async () => {
  const guest = await readFile(join(ciDirectory, "qemu-guest-layer.sh"), "utf8");
  // run-e2e.sh starts the stack in the background and only reports that it
  // never became healthy. stack.log holds the reason and lives inside a guest
  // that is discarded on power off, so it has to reach the serial log.
  assert.match(guest, /stack\.log/);
  const verify = await readFile(join(ciDirectory, "codearts-verify.sh"), "utf8");
  assert.match(verify, /record_verdict 0/);
});

test("only the verification job can turn the run red", async () => {
  const workflow = await workflowText();
  const verify = workflowJob(workflow, "verify_results");
  assert.match(verify, /SH_FILE_PATH: \.ci\/codearts-verify\.sh/);
  // Every layer's build task returns success so its OBS action can upload the
  // log, so the layer jobs are green whatever happened. The gate must key on
  // the job that reads the recorded exit codes back, and the result table must
  // read them too rather than trusting a job status.
  for (const layer of ["ut", "ut_guest", "st", "e2e", "binary", "binary_aarch64"]) {
    assert.match(verify, new RegExp(`\\n        - ${layer}\\n`), `verify_results must wait for ${layer}`);
  }
  assert.match(workflow, /completed\('verify_results', 'code_check'\)/);
  // The layer jobs run on a build task whose shell returns success so the OBS
  // action can still upload; a judge sharing that task can never be red, which
  // is how a run with two failed layers was published as successful.
  const jobIdOf = (body) => /jobId: (\S+)/.exec(body)?.[1];
  const verifyJobId = jobIdOf(verify);
  assert.ok(verifyJobId, "verify_results has no build task");
  for (const layer of ["ut", "ut_guest", "st", "e2e", "binary"]) {
    assert.notEqual(
      jobIdOf(workflowJob(workflow, layer)),
      verifyJobId,
      `verify_results must not share ${layer}'s build task, which cannot fail`,
    );
  }
  assert.doesNotMatch(workflow, /CI_STATUS_/);
  const result = await readFile(join(ciDirectory, "codearts-pr-result.sh"), "utf8");
  assert.match(result, /codearts_layer_status/);
  assert.doesNotMatch(result, /jobs\./);
});

test("both guest layers install and build before handing the workspace over", async () => {
  const layer = await readFile(join(ciDirectory, "codearts-layer.sh"), "utf8");
  for (const [fn, guest] of [["run_ut_guest", "ut-guest"], ["run_e2e", "e2e"]]) {
    const body = new RegExp(`${fn}\\(\\) \\{([\\s\\S]*?)\\n\\}`).exec(layer);
    assert.ok(body, `${fn} is missing from the layer entry point`);
    const install = body[1].indexOf("pnpm install --frozen-lockfile");
    const build = body[1].indexOf("pnpm build");
    const run = body[1].indexOf(`run-qemu-layer.sh ${guest}`);
    assert.ok(install >= 0 && build > install && run > build, `${fn} must install and build before the guest`);
  }
  const workflow = await workflowText();
  for (const [job, argument] of [["ut_guest", "ut-guest"], ["e2e", "e2e"]]) {
    const body = workflowJob(workflow, job);
    assert.match(body, /SH_FILE_PATH: \.ci\/codearts-layer\.sh/);
    assert.match(body, new RegExp(`ARGS: \\|-\\n\\s+${argument}\\n`));
  }
});

test("the UT guest payload leaves the external dependency tree behind", async () => {
  const runner = await readFile(script, "utf8");
  const utGuest = /ut-guest\)([\s\S]*?);;/.exec(runner);
  assert.ok(utGuest, "the ut-guest branch is missing");
  assert.match(utGuest[1], /--dependencies workspace/);
  const e2e = /\n  e2e\)([\s\S]*?);;/.exec(runner);
  assert.ok(e2e, "the e2e branch is missing");
  // The stack that guest starts runs the real services, which do have
  // external dependencies.
  assert.match(e2e[1], /--dependencies full/);
});

test("each guest layer stops its guest before CodeArts stops the job", async () => {
  const layer = await readFile(join(ciDirectory, "codearts-layer.sh"), "utf8");
  const workflow = await workflowText();
  for (const [fn, job] of [["run_ut_guest", "ut_guest"], ["run_e2e", "e2e"]]) {
    const body = new RegExp(`${fn}\\(\\) \\{([\\s\\S]*?)\\n\\}`).exec(layer);
    assert.ok(body, `${fn} is missing from the layer entry point`);
    const guestSeconds = Number(/QEMU_TIMEOUT_SECONDS:-(\d+)/.exec(body[1])?.[1]);
    const jobMinutes = Number(/\n\s+timeout: (\d+)\n/.exec(workflowJob(workflow, job))?.[1]);
    assert.ok(Number.isFinite(guestSeconds), `${fn} does not bound its guest`);
    assert.ok(Number.isFinite(jobMinutes), `${job} has no job timeout`);
    // A guest that CodeArts kills records no exit code, uploads no log and
    // never reaches its result step, which leaves the merge request reporting
    // a pipeline that is still running.
    assert.ok(
      guestSeconds < jobMinutes * 60,
      `${fn} gives its guest ${guestSeconds}s inside a ${jobMinutes}-minute job`,
    );
  }
});

test("the packer refuses to build a payload without a dependency tree", async (t) => {
  await mkdir(testRoot, { recursive: true });
  const root = await mkdtemp(join(testRoot, "pack-workspace-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, ".ci"), { recursive: true });
  await copyFile(join(ciDirectory, "pack-workspace.sh"), join(root, ".ci", "pack-workspace.sh"));
  const { output, status } = runScript(join(root, ".ci", "pack-workspace.sh"), undefined, {});
  assert.equal(status, 2);
  assert.match(output, /--output is required/);

  const withOutput = spawnSync("bash", [join(root, ".ci", "pack-workspace.sh"), "--output", resolve(root, "payload.tar.gz")], {
    encoding: "utf8",
    env: process.env,
  });
  assert.equal(withOutput.status, 1);
  assert.match(`${withOutput.stdout}${withOutput.stderr}`, /node_modules is missing; install before packing the workspace/);
});
