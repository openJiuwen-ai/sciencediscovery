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

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import type { SkillCatalog } from "@sciencediscovery/specialist";

import { getGitSkillImportJob, startGitSkillImportJob } from "./skill-import-jobs.js";

const COMMIT = "0123456789abcdef0123456789abcdef01234567";

function fakeCatalog(
  importPackage: (subdirectory: string) => Promise<{ id: string }>,
  ids: () => string[] = () => [],
): SkillCatalog {
  return {
    ids,
    importFromGit: async (input: { subdirectory?: string }) => importPackage(input.subdirectory ?? "."),
    prepareGitImport: async () => ({ commit: COMMIT }),
  } as unknown as SkillCatalog;
}

async function waitForJob(id: string) {
  for (let attempt = 0; attempt < 200; attempt += 1) {
    const job = getGitSkillImportJob(id);
    if (job && job.status !== "queued" && job.status !== "running") return job;
    await new Promise((done) => setTimeout(done, 5));
  }
  throw new Error("the import job did not finish");
}

test("a background import reports every package and keeps going after a failure", async () => {
  const catalog = fakeCatalog(
    async (subdirectory) => {
      if (subdirectory === "skills/bad") throw new Error("broken package");
      return { id: subdirectory.split("/").pop()! };
    },
    () => ["a"],
  );
  const started = startGitSkillImportJob(catalog, {
    commit: COMMIT,
    items: [
      { subdirectory: "skills/a" },
      { subdirectory: "skills/bad" },
      { subdirectory: "skills/b" },
    ],
    repositoryUrl: "https://example.invalid/org/skills.git",
  });
  assert.equal(started.status, "queued");
  assert.equal(started.total, 3);

  const finished = await waitForJob(started.id);
  assert.equal(finished.status, "done");
  assert.equal(finished.done, 3);
  assert.deepEqual(finished.imported, [
    { created: false, id: "a" },
    { created: true, id: "b" },
  ]);
  assert.deepEqual(finished.failures.map((failure) => failure.subdirectory), ["skills/bad"]);
  assert.equal(finished.finishedAt === undefined, false);
});

test("a second background import is refused while the first is running", async () => {
  let release: (() => void) | undefined;
  const prepared = new Promise<void>((done) => { release = done; });
  const catalog = {
    ids: () => [],
    importFromGit: async () => ({ id: "a" }),
    prepareGitImport: async () => {
      await prepared;
      return { commit: COMMIT };
    },
  } as unknown as SkillCatalog;

  const first = startGitSkillImportJob(catalog, {
    commit: COMMIT,
    items: [{ subdirectory: "skills/a" }],
    repositoryUrl: "https://example.invalid/org/skills.git",
  });
  assert.throws(
    () => startGitSkillImportJob(catalog, {
      commit: COMMIT,
      items: [{ subdirectory: "skills/b" }],
      repositoryUrl: "https://example.invalid/org/skills.git",
    }),
    /already running/,
  );
  release?.();
  await waitForJob(first.id);
});
