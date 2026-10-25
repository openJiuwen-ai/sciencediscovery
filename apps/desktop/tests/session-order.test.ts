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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { byRecency, resumeOnBoot, resumeSession } from "../src/app/session-order.js";

const older = { id: "older", projectId: "p1", updatedAt: "2026-01-01T09:00:00.000Z" };
const newer = { id: "newer", projectId: "p2", updatedAt: "2026-01-02T09:00:00.000Z" };
const same = { id: "same", projectId: "p1", updatedAt: "2026-01-02T09:00:00.000Z" };

test("the list puts the most recently used Session first", () => {
  assert.deepEqual(byRecency([older, newer]).map((session) => session.id), ["newer", "older"]);
  // Equal timestamps keep the server's order rather than a made-up one.
  assert.deepEqual(byRecency([same, newer]).map((session) => session.id), ["same", "newer"]);
  assert.deepEqual(byRecency([]), []);
  // The argument is not reordered in place: the caller's list is the server's.
  const listed = [older, newer];
  byRecency(listed);
  assert.deepEqual(listed.map((session) => session.id), ["older", "newer"]);
});

test("boot opens the newest Session instead of leaving a draft beside it", () => {
  // The first message from a draft would create a second Session next to the
  // one already on screen; resuming makes the composer and the list agree.
  assert.equal(resumeSession(undefined, [older, newer])?.id, "newer");
  assert.equal(resumeSession(undefined, []), undefined);
  // Nothing is opened over a Session the user (or an earlier boot) already
  // chose.
  assert.equal(resumeSession("older", [older, newer]), undefined);
});

test("boot opens the resumed Session in the Project it belongs to", () => {
  // The listing is every Project's Sessions. Opening one without adopting its
  // Project would leave 新增会话 and uploads pointing at whichever Project the
  // server listed first.
  const done: string[] = [];
  const opened = { current: false };
  resumeOnBoot({
    adoptProject: (projectId) => done.push(`project ${projectId}`),
    listed: [older, newer],
    open: undefined,
    opened,
    openSession: (id) => done.push(`session ${id}`),
  });
  assert.deepEqual(done, ["project p2", "session newer"]);
  assert.equal(opened.current, true);
});

test("a failed listing is not an empty one, so boot tries again", () => {
  // `refreshSessionLists` returns undefined when the server could not be read.
  // Treating that as "nothing to resume" would leave the draft beside a listed
  // Session — the bug this PR exists to fix — for the rest of the run.
  const done: string[] = [];
  const opened = { current: false };
  resumeOnBoot({
    adoptProject: () => done.push("project"),
    listed: undefined,
    open: undefined,
    opened,
    openSession: () => done.push("session"),
  });
  assert.deepEqual(done, []);
  assert.equal(opened.current, false);
});

test("boot does not replace a Session that is already open", () => {
  // A later bootstrap run — the setup wizard finishing, say — must not yank the
  // user out of the Session they chose.
  const done: string[] = [];
  const opened = { current: false };
  resumeOnBoot({
    adoptProject: (projectId) => done.push(`project ${projectId}`),
    listed: [older, newer],
    open: "older",
    opened,
    openSession: (id) => done.push(`session ${id}`),
  });
  assert.deepEqual(done, []);
  assert.equal(opened.current, true, "the listing still counted as acted on");
});
