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

// Half of this CI is configured on the CodeArts console, and
// .ci/codearts-console.reference.md is the repository's mirror of it. Nothing
// here can read the console, but it can read what the workflows expect of it:
// a build task the workflows call, or a parameter they pass, that the mirror
// does not mention is a piece of configuration nobody outside the console
// knows about.

import assert from "node:assert/strict";
import { access, readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";
import test from "node:test";

const repositoryRoot = resolve(import.meta.dirname, "..");
const workflowDirectory = join(repositoryRoot, ".codearts", "workflow");
const mirrorFile = join(repositoryRoot, ".ci", "codearts-console.reference.md");

async function workflows() {
  const names = (await readdir(workflowDirectory)).filter((name) => name.endsWith(".yml"));
  assert.ok(names.length > 0, "no workflow to check the mirror against");
  return Promise.all(names.map(async (name) => ({
    name, source: await readFile(join(workflowDirectory, name), "utf8"),
  })));
}

// What the platform writes into a step itself. Everything else under `with:`
// is a parameter somebody declared on a build task.
const PLATFORM_KEYS = new Set(["jobId", "artifactIdentifier"]);

/**
 * The parameter names a build-task step passes, which are exactly the ones the
 * task has to declare. Only the keys directly under a cloudBuild step's
 * `with:` count: the records inside the `ENVS` block scalar are indented
 * deeper and belong to the script, not to the console.
 */
function taskParameters(source) {
  const found = new Set();
  let inStep = false;
  let keyIndent = null;
  for (const line of source.split("\n")) {
    if (/^\s*- name: /.test(line)) {
      inStep = false;
      keyIndent = null;
    }
    if (/uses: official_devcloud_cloudBuild\s*$/.test(line)) {
      inStep = true;
      continue;
    }
    if (!inStep) continue;
    const entry = line.match(/^(\s*)([A-Za-z_][A-Za-z0-9_]*):/);
    if (keyIndent === null) {
      if (entry && entry[2] === "with") keyIndent = entry[1].length + 2;
      continue;
    }
    if (!entry) continue;
    if (entry[1].length < keyIndent) {
      inStep = false;
      keyIndent = null;
    } else if (entry[1].length === keyIndent
      && !entry[2].startsWith("_") && !PLATFORM_KEYS.has(entry[2])) {
      found.add(entry[2]);
    }
  }
  return found;
}

test("every build task a workflow calls is described in the console mirror", async () => {
  const mirror = await readFile(mirrorFile, "utf8");
  const undocumented = [];
  for (const { name, source } of await workflows()) {
    for (const [, id] of source.matchAll(/jobId: ([0-9a-f]{32})/g)) {
      if (!mirror.includes(id)) undocumented.push(`${name} calls ${id}`);
    }
  }
  assert.deepEqual([...new Set(undocumented)], []);
});

test("every build-task parameter a workflow passes is described in the console mirror", async () => {
  const mirror = await readFile(mirrorFile, "utf8");
  const undocumented = [];
  for (const { name, source } of await workflows()) {
    for (const parameter of taskParameters(source)) {
      // The mirror lists parameters in a table cell of its own, so requiring
      // the backticked name keeps a passing mention in prose from counting.
      if (!mirror.includes(`\`${parameter}\``)) undocumented.push(`${name} passes ${parameter}`);
    }
  }
  assert.deepEqual([...new Set(undocumented)], []);
});

test("the parameter scan reads a build-task step and not the records it carries", async () => {
  const [{ source }] = (await workflows())
    .filter(({ name }) => name === "codearts-auto-merge-pipeline.yml");
  const parameters = taskParameters(source);
  assert.ok(parameters.has("RUNNER_IMAGE") && parameters.has("ENVS"),
    "the step's own parameters must be found");
  assert.ok(!parameters.has("CODEARTS_MERGE_ID") && !parameters.has("GITCODE_TOKEN"),
    "an ENVS record is not a console parameter");
});

test("the console mirror points at files that exist", async () => {
  const mirror = await readFile(mirrorFile, "utf8");
  const links = [...mirror.matchAll(/\]\((?!https?:)([^)]+)\)/g)].map(([, target]) => target);
  assert.ok(links.length >= 3, "the mirror must link the shell and both image recipes");
  for (const link of links) {
    await access(join(repositoryRoot, ".ci", link));
  }
  // The shell is the one piece of console configuration whose exact text
  // matters, so the mirror has to send a reader to it rather than describe it.
  assert.ok(links.includes("codearts-runner-shell.reference.sh"));
});
