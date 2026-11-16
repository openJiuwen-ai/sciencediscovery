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
import { renderToStaticMarkup } from "react-dom/server";

import type { ExportHistoryRow } from "../src/app/export-bridge.js";
import { TEXT } from "../src/text.js";
import { ExportHistoryList, exportSavedAt, exportSize } from "../src/views/ExportHistoryList.js";

import { act, create } from "./support/dom-renderer.js";

function row(over: Partial<ExportHistoryRow> = {}): ExportHistoryRow {
  return {
    bytes: 2_048,
    directory: "C:\\Users\\me\\Downloads",
    exists: true,
    filename: "晶体结构分析_20260101_0900.sdresearch",
    id: "task-1",
    savedAt: "2026-11-16T01:00:00.000Z",
    sessionTitle: "晶体结构分析",
    token: "token-1",
    ...over,
  };
}

test("a saved row shows the package, its size, time, session and folder", () => {
  const markup = renderToStaticMarkup(React.createElement(ExportHistoryList, {
    locale: "zh-CN",
    onForget: () => {},
    onReveal: () => {},
    rows: [row()],
  }));
  assert.match(markup, /晶体结构分析_20260101_0900\.sdresearch/);
  assert.match(markup, /2\.0 KB/);
  assert.match(markup, /晶体结构分析/);
  assert.match(markup, /Downloads/);
  assert.match(markup, new RegExp(TEXT.exportHistory.reveal));
  assert.match(markup, new RegExp(TEXT.exportHistory.forget));
  assert.doesNotMatch(markup, new RegExp(TEXT.exportHistory.missing));
});

test("a row whose file is gone says so and offers only removal", () => {
  const markup = renderToStaticMarkup(React.createElement(ExportHistoryList, {
    locale: "zh-CN",
    onForget: () => {},
    onReveal: () => {},
    rows: [row({ exists: false })],
  }));
  assert.match(markup, new RegExp(TEXT.exportHistory.missing));
  assert.match(markup, /is-missing/);
  // No reveal control for a file nobody can reveal.
  assert.doesNotMatch(markup, new RegExp(TEXT.exportHistory.reveal));
});

test("both actions reach their callbacks with the row they belong to", async () => {
  const revealed: string[] = [];
  const forgotten: string[] = [];
  const renderer = await act(async () => create(React.createElement(ExportHistoryList, {
    locale: "zh-CN",
    onForget: (entry: ExportHistoryRow) => forgotten.push(entry.id),
    onReveal: (entry: ExportHistoryRow) => revealed.push(entry.token),
    rows: [row(), row({ exists: false, filename: "gone.sdresearch", id: "task-2", token: "token-2" })],
  })));
  const buttons = renderer.root.findAllByType("button");
  assert.equal(buttons.length, 3);
  await act(async () => buttons[0]!.props.onClick());
  await act(async () => buttons[1]!.props.onClick());
  await act(async () => buttons[2]!.props.onClick());
  assert.deepEqual(revealed, ["token-1"]);
  assert.deepEqual(forgotten, ["task-1", "task-2"]);
  await act(async () => renderer.unmount());
});

test("size and time format the way the row claims", () => {
  assert.equal(exportSize(0), "0 B");
  assert.equal(exportSize(1_024), "1.0 KB");
  assert.equal(exportSize(1024 * 1024 * 3.5), "3.5 MB");
  assert.equal(exportSize(512), "512 B");
  assert.match(exportSavedAt("2026-11-16T01:00:00.000Z", "en-US"), /2026/);
  assert.equal(exportSavedAt("not a date", "en-US"), "not a date");
});
