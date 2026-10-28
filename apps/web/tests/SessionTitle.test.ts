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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { UNTITLED_SESSION_TITLE } from "@sciencediscovery/schema";

import { sessionDisplayTitle } from "../src/session-title.js";

const sessions = [
  { createdAt: "2026-10-01T09:00:00.000Z", updatedAt: "2026-10-02T11:00:00.000Z", id: "second", title: UNTITLED_SESSION_TITLE },
  { createdAt: "2026-10-01T08:00:00.000Z", updatedAt: "2026-10-02T10:00:00.000Z", id: "first", title: UNTITLED_SESSION_TITLE },
  { createdAt: "2026-10-01T10:00:00.000Z", updatedAt: "2026-10-02T12:00:00.000Z", id: "named", title: "Protein analysis" },
];

test("labels unnamed Sessions by descending activity without changing stored titles or input order", () => {
  const before = structuredClone(sessions);
  assert.equal(sessionDisplayTitle(sessions[0]!, sessions, "Untitled session"), "Untitled session 1");
  assert.equal(sessionDisplayTitle(sessions[1]!, sessions, "Untitled session"), "Untitled session 2");
  assert.equal(sessionDisplayTitle(sessions[2]!, sessions, "Untitled session"), "Protein analysis");
  assert.equal(sessions[0]!.title, UNTITLED_SESSION_TITLE);
  assert.deepEqual(sessions, before);
});

test("keeps the original label when a Project has one unnamed Session", () => {
  const session = { updatedAt: "2026-10-01T08:00:00.000Z", id: "only", title: UNTITLED_SESSION_TITLE };
  assert.equal(sessionDisplayTitle(session, [session], "未命名会话"), "未命名会话");
});

test("active and archived views retain the same Project-wide ordinals", () => {
  const archived = { ...sessions[0]!, id: "archived", archivedAt: "2026-10-02T11:30:00.000Z" };
  const all = [sessions[1]!, archived];
  assert.equal(sessionDisplayTitle(sessions[1]!, all, "未命名会话"), "未命名会话 2");
  assert.equal(sessionDisplayTitle(archived, all, "未命名会话"), "未命名会话 1");
});

test("activity changes reassign display ordinals and equal timestamps use a deterministic id tie-break", () => {
  const first = { ...sessions[1]!, updatedAt: sessions[0]!.updatedAt };
  assert.equal(sessionDisplayTitle(first, [sessions[0]!, first], "Untitled session"), "Untitled session 1");
  const newer = { ...sessions[0]!, updatedAt: "2026-10-03T08:00:00.000Z" };
  assert.equal(sessionDisplayTitle(first, [newer, first], "Untitled session"), "Untitled session 2");
});
