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

import { UNTITLED_SESSION_TITLE } from "@sciencediscovery/schema";

import { sessionDisplayTitle } from "../src/session-title.js";

const sessions = [
  { createdAt: "2026-10-01T09:00:00.000Z", id: "second", title: UNTITLED_SESSION_TITLE },
  { createdAt: "2026-10-01T08:00:00.000Z", id: "first", title: UNTITLED_SESSION_TITLE },
  { createdAt: "2026-10-01T10:00:00.000Z", id: "named", title: "Protein analysis" },
];

test("labels multiple unnamed Sessions by stable creation order without changing stored titles", () => {
  assert.equal(sessionDisplayTitle(sessions[0]!, sessions, "Untitled session"), "Untitled session 2");
  assert.equal(sessionDisplayTitle(sessions[1]!, sessions, "Untitled session"), "Untitled session 1");
  assert.equal(sessionDisplayTitle(sessions[2]!, sessions, "Untitled session"), "Protein analysis");
  assert.equal(sessions[0]!.title, UNTITLED_SESSION_TITLE);
});

test("keeps the original label when a Project has one unnamed Session", () => {
  const session = { createdAt: "2026-10-01T08:00:00.000Z", id: "only", title: UNTITLED_SESSION_TITLE };
  assert.equal(sessionDisplayTitle(session, [session], "未命名会话"), "未命名会话");
});
