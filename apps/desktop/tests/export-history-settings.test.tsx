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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import React from "react";

import type { ExportHistoryRow } from "../src/app/export-bridge.js";
import { TEXT } from "../src/text.js";
import { ExportHistorySettings } from "../src/views/settings/system/ExportHistory.js";

import { act, create } from "./support/dom-renderer.js";

const rows: ExportHistoryRow[] = [
  {
    bytes: 2_048,
    directory: "C:\\Users\\me\\Downloads",
    exists: true,
    filename: "晶体结构分析.sdresearch",
    id: "task-1",
    projectId: "project-1",
    savedAt: "2026-11-16T01:00:00.000Z",
    sessionId: "session-1",
    sessionTitle: "晶体结构分析",
    token: "token-1",
  },
  {
    bytes: 1_024,
    directory: "D:\\Research",
    exists: false,
    filename: "量子点.sdresearch",
    id: "task-2",
    projectId: "project-2",
    savedAt: "2026-11-15T09:00:00.000Z",
    sessionId: "session-2",
    sessionTitle: "量子点",
    token: "token-2",
  },
];

const projects = [
  { id: "project-1", name: "项目一" },
  { id: "project-2", name: "项目二" },
] as never;

async function mount(bridge: unknown) {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  globals.window = { sdShell: { exportHistory: bridge } };
  const renderer = await act(async () => create(React.createElement(ExportHistorySettings, { projects })));
  // Let the list read settle inside act().
  await act(async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); });
  return {
    renderer,
    restore: () => { globals.window = previous; },
    texts: () => JSON.stringify(renderer.toJSON()),
  };
}

test("the settings pane lists the shell's history and says so when a filter matches nothing", async () => {
  const bridge = {
    list: async () => rows,
    reveal: async () => ({ missing: false, ok: true }),
    forget: async () => ({ ok: true }),
  };
  const mounted = await mount(bridge);
  try {
    const text = mounted.texts();
    assert.match(text, /晶体结构分析\.sdresearch/);
    assert.match(text, /量子点\.sdresearch/);
    // The filter input is the search box; typing a word nothing matches is not
    // "export history is only available in the desktop app".
    const search = mounted.renderer.root.findAllByType("input")[0]!;
    await act(async () => search.props.onChange({ target: { value: "找不到的名字" } }));
    const filtered = mounted.texts();
    assert.match(filtered, new RegExp(TEXT.exportHistory.noMatch));
    assert.doesNotMatch(filtered, new RegExp(TEXT.exportHistory.unavailable));
  } finally {
    mounted.restore();
  }
});

test("outside the shell the pane says the feature is desktop-only", async () => {
  const mounted = await mount(undefined);
  try {
    assert.match(mounted.texts(), new RegExp(TEXT.exportHistory.unavailable));
  } finally {
    mounted.restore();
  }
});
