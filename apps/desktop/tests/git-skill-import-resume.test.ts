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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { ApiRequestError } from "../src/api/client.js";
import {
  currentGitSkillImportJob,
  dismissGitSkillImportJob,
  GIT_SKILL_IMPORT_JOB_KEY,
  resumeGitSkillImport,
  startGitSkillImportInBackground,
} from "../src/app/git-skill-import-job.js";
import type { GitSkillImportJob } from "../src/api/types.js";
import { StubClient } from "./api-stub.js";

// This file runs in its own process, so these are the first reads of the job
// store: a remembered id here is what a renderer sees right after a reload.
const stored = new Map<string, string>();
Object.defineProperty(globalThis, "sessionStorage", {
  configurable: true,
  value: {
    getItem: (key: string) => stored.get(key) ?? null,
    removeItem: (key: string) => { stored.delete(key); },
    setItem: (key: string, value: string) => { stored.set(key, value); },
  },
});

const finished = (id: string, created: string[]): GitSkillImportJob => ({
  done: created.length,
  failures: [],
  id,
  imported: created.map((skillId) => ({ created: true, id: skillId })),
  startedAt: "2026-11-20T00:00:00.000Z",
  status: "done",
  total: created.length,
});

const running = (id: string, done: number): GitSkillImportJob => ({
  done,
  failures: [],
  id,
  imported: [],
  startedAt: "2026-11-20T00:00:00.000Z",
  status: "running",
  total: 2,
});

/** Wait until the condition holds, or report that it never did. Polling is on
 *  a one-second interval, so a fixed sleep would make this test slow or flaky. */
async function until(predicate: () => boolean, timeoutMs = 2_500): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate() && Date.now() < deadline) {
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  return predicate();
}

test("a reloaded window resumes the import and finishes its enable step", async () => {
  stored.set(GIT_SKILL_IMPORT_JOB_KEY, "job-resumed");
  const stub = new StubClient()
    .reply(finished("job-resumed", ["fresh"]))
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({});
  try {
    await resumeGitSkillImport(stub.asClient());
    assert.deepEqual(stub.calls.map((call) => call.path), [
      "/api/skills/import-git/jobs/job-resumed",
      "/api/jiuwenswarm/skills",
      "/api/jiuwenswarm/skills-by-id/fresh",
    ]);
  } finally {
    // Ends the finished-notice timer that would otherwise hold the process.
    dismissGitSkillImportJob();
  }
});

test("a job the API no longer knows is forgotten", async () => {
  stored.set(GIT_SKILL_IMPORT_JOB_KEY, "job-gone");
  const stub = new StubClient().fail(new ApiRequestError("Git Skill import job not found", 404));
  await resumeGitSkillImport(stub.asClient());
  assert.equal(stored.has(GIT_SKILL_IMPORT_JOB_KEY), false);
});

test("a failed resume leaves an import that started meanwhile running", async () => {
  stored.set(GIT_SKILL_IMPORT_JOB_KEY, "job-remembered");
  let rejectResume!: (reason: unknown) => void;
  const pendingResume = new Promise<never>((_, reject) => { rejectResume = reject; });
  const stub = new StubClient()
    .reply(pendingResume)
    .reply(running("job-foreground", 0))
    .reply(running("job-foreground", 1))
    .reply(finished("job-foreground", ["fresh"]))
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({});
  try {
    const resuming = resumeGitSkillImport(stub.asClient());
    // A foreground start wins the store while the remembered job's read is
    // still in flight.
    await startGitSkillImportInBackground(stub.asClient(), {
      items: [{ subdirectory: "fresh" }],
      repositoryUrl: "https://github.com/example/skills",
    });
    rejectResume(new ApiRequestError("the API is unreachable", 503));
    await resuming;

    const reads = () => stub.calls.filter((call) => call.path === "/api/skills/import-git/jobs/job-foreground").length;
    assert.equal(await until(() => reads() >= 1), true, "the running job is still polled after the resume failed");
    assert.equal(currentGitSkillImportJob()?.status, "running");
    // The next poll ends the job, so the store is left settled for the suite.
    assert.equal(await until(() => currentGitSkillImportJob()?.status === "done"), true);
  } finally {
    dismissGitSkillImportJob();
  }
});
