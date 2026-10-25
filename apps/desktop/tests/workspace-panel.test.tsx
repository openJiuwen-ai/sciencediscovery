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
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../src/app/panel-width.js";
import type { PanelResize } from "../src/app/use-panel-width.js";
import type { PreviewSlot, TabState, WorkspaceActions } from "../src/app/use-workspace.js";
import { HOME_TAB_ID, initialTabState, placeDocument } from "../src/app/preview-tabs.js";
import { WorkspacePanel } from "../src/views/WorkspacePanel.js";

/** The panel only reads these; the rest of the interface is not reached by a
 *  static render. */
const actions = {
  addPanelTab: () => {},
  closeTab: () => false,
  openArtifact: async () => {},
  openFile: async () => {},
  selectPanelTab: () => {},
} as unknown as WorkspaceActions;

/** The splitter's callbacks belong to the shell, which is not under test here;
 *  only the width it is told about reaches the markup. */
const resize: PanelResize = { nudge: () => {}, start: () => {}, width: 720 };

function render(tabs: TabState, over: Partial<Parameters<typeof WorkspacePanel>[0]> = {}): string {
  return renderToStaticMarkup(
    <WorkspacePanel
      actions={actions}
      activeGroup="files"
      files={[]}
      onCollapse={() => {}}
      onSelectGroup={() => {}}
      outputs={[]}
      resize={resize}
      tabs={tabs}
      {...over}
    />,
  );
}

/** One document open in the panel, with the fields the group filter reads. */
function document(over: Partial<PreviewSlot> = {}): TabState {
  return {
    activeTabId: HOME_TAB_ID,
    tabs: [{
      home: false,
      id: HOME_TAB_ID,
      label: "notes.md",
      loading: false,
      path: "notes.md",
      source: "file",
      ...over,
    }],
  };
}

function count(markup: string, needle: string): number {
  return markup.split(needle).length - 1;
}

test("a fresh panel offers three group tabs and opens on 工作区", () => {
  const markup = render(initialTabState());
  assert.equal(count(markup, 'role="tab"'), 3);
  for (const label of ["团队", "产物", "工作区"]) {
    assert.ok(markup.includes(`<span>${label}</span>`), `${label} is missing from the group tabs`);
  }
  // 任务 is not a tab: the run's steps live in the transcript.
  assert.doesNotMatch(markup, /<span>任务<\/span>/);
  assert.doesNotMatch(markup, /<span>文件<\/span>/);
  assert.equal(count(markup, "panel-group-tab is-active"), 1);
  // The panel's own controls live in its header, not in a tab bar. Only the
  // collapse control is left; the expand affordance is gone.
  assert.doesNotMatch(markup, /aria-label="放大面板"/);
  assert.match(markup, /aria-label="收起面板"/);
});

test("团队 says this build has no team rather than inventing agents", () => {
  const markup = render(initialTabState(), { activeGroup: "team" });
  assert.match(markup, /还没有团队/);
  assert.match(markup, /这个版本没有接入多智能体团队/);
});

test("工作区 lists every file and folder of the workspace", () => {
  const markup = render(initialTabState(), {
    activeGroup: "files",
    files: [
      { modifiedAt: "2026-01-01T00:00:00.000Z", path: "a.txt", size: 12 },
      { modifiedAt: "2026-01-01T00:00:00.000Z", path: "sub/b.txt", size: 2048 },
    ],
  });
  assert.match(markup, />a\.txt</);
  assert.match(markup, />b\.txt</);
  assert.match(markup, />sub</);
  assert.equal(count(markup, "panel-list-row is-folder"), 1);
  assert.match(markup, /aria-label="搜索文件"/);
});

test("a deep path is one foldable row per directory, not one row with slashes", () => {
  const markup = render(initialTabState(), {
    activeGroup: "files",
    files: [{
      modifiedAt: "2026-01-01T00:00:00.000Z",
      path: "antibody_pipeline/runs/demo-01/05_screening/report.md",
      size: 822,
    }],
  });
  // Four directories, four folds, each labelled with its own segment.
  assert.equal(count(markup, "panel-list-row is-folder"), 4);
  for (const name of ["antibody_pipeline", "runs", "demo-01", "05_screening"]) {
    assert.equal(count(markup, `class="label">${name}<`), 1, `${name} is its own row`);
  }
  // The joined path survives only as the file's tooltip, never as a folder name.
  assert.equal(count(markup, "antibody_pipeline/runs/demo-01/05_screening"), 1);
  assert.match(markup, /title="antibody_pipeline\/runs\/demo-01\/05_screening\/report\.md · 822 B · /u);
});

test("a nested file appears once, under its own folders", () => {
  const markup = render(initialTabState(), {
    activeGroup: "files",
    files: [
      { modifiedAt: "2026-01-01T00:00:00.000Z", path: "a/one.txt", size: 1 },
      { modifiedAt: "2026-01-01T00:00:00.000Z", path: "a/b/two.txt", size: 1 },
    ],
  });
  assert.equal(count(markup, "panel-list-row is-folder"), 2);
  assert.equal(count(markup, 'class="label">one.txt<'), 1);
  assert.equal(count(markup, 'class="label">two.txt<'), 1);
});

test("an empty workspace says so instead of rendering an empty tree", () => {
  const markup = render(initialTabState(), { activeGroup: "files" });
  assert.match(markup, /工作区里还没有文件/);
});

test("an artifact row is a name and a tooltip, not a preview of its contents", () => {
  const description = "这份报告汇总了三条证据链，覆盖蛋白结构的比对结果与相关文献的支撑情况。";
  const markup = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [
      {
        artifact: {
          description,
          id: "a1",
          kind: "report",
          name: "结构比对报告.md",
        },
        version: { id: "v1", version: 3 },
      } as never,
    ],
  });
  assert.match(markup, /结构比对报告\.md/);
  // The server's description is a paragraph, and a paragraph per row buried the
  // names it was meant to help pick between. It survives as the tooltip and
  // nowhere else — one occurrence, inside `title="`.
  assert.ok(markup.includes(`title="${description}"`), "the description is not the tooltip");
  assert.equal(count(markup, description), 1);
});

test("a document opened from 产物 becomes its own tab and the body is the document", () => {
  const placed = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "v1",
    label: "结构比对报告.md",
    path: "",
    source: "artifact",
  });
  const tabs: TabState = {
    ...placed,
    tabs: placed.tabs.map((slot) => ({ ...slot, content: "# 标题", loading: false })),
  };
  const outputs = [{
    artifact: { id: "a1", kind: "report", name: "结构比对报告.md", title: "结构比对报告" },
    version: { id: "v1", version: 3 },
  }] as never;
  const markup = render(tabs, { activeGroup: "artifacts", outputs });
  // Three group tabs plus the document.
  assert.equal(count(markup, 'role="tab"'), 4);
  assert.equal(count(markup, "doc-tab-close"), 1);
  assert.match(markup, /aria-label="新增页签"/);
  assert.match(markup, /class="doc-tab is-active"/);
  assert.match(markup, /<h1>标题<\/h1>/);
  // The artifacts list stays beside the document, and the document is drawn on
  // the handoff's canvas rather than in the list column.
  assert.match(markup, /所有产物/);
  assert.match(markup, /class="artifact-canvas"/);
  assert.match(markup, /aria-label="下载"/);
});

test("a document belongs to the group it was opened from", () => {
  // An artifact tab must not surface under 文件, nor a source file under 产物:
  // the two lists are views of the same workspace, not one shared shelf.
  const artifactDoc: TabState = document({ source: "artifact", artifactId: "v1", label: "报告.md" });
  const artifacts = render(artifactDoc, { activeGroup: "artifacts" });
  assert.match(artifacts, /报告\.md/);
  const files = render(artifactDoc, { activeGroup: "files" });
  assert.match(files, /工作区里还没有文件/);

  const fileDoc = document({ label: "notes.md" });
  const underArtifacts = render(fileDoc, { activeGroup: "artifacts" });
  assert.match(underArtifacts, /这次会话还没有产物/);
});

test("a loading document shows a spinner rather than an empty body", () => {
  const markup = render(document({ loading: true }), { activeGroup: "files" });
  assert.match(markup, /spinner/);
  assert.doesNotMatch(markup, /这个类型暂时没有预览/);
});

test("a failed read renders its error and not the unsupported-type note", () => {
  const markup = render(document({ error: "读取失败", label: "a.bin", path: "a.bin" }), {
    activeGroup: "files",
  });
  assert.match(markup, /读取失败/);
  assert.doesNotMatch(markup, /这个类型暂时没有预览/);
});

test("a markdown document renders its body, not a source listing", () => {
  const markup = render(document({ content: "# 标题", label: "notes.md" }), { activeGroup: "files" });
  assert.match(markup, /<h1>标题<\/h1>/);
});

test("a table in the preview is wrapped in a scroller rather than clipped", () => {
  // A table cannot be narrowed — its columns are as wide as their content — so
  // on a panel dragged down to its minimum the overflow has to scroll. The
  // panel clips, so without the wrapper the right-hand columns would be gone.
  const markup = render(document({
    content: "| 名称 | 结果 |\n| --- | --- |\n| 甲 | 通过 |",
    label: "report.md",
    path: "report.md",
  }), { activeGroup: "files" });
  assert.match(markup, /class="md-scroll"/);
  assert.ok(markup.indexOf('<div class="md-scroll">') < markup.indexOf("<table>"));
  assert.match(markup, /<th>名称<\/th>/u);
  assert.match(markup, /<td>通过<\/td>/u);
});

test("a structure file goes to the 3D viewer, not to a source listing", () => {
  const markup = render(document({
    content: "ATOM      1  N   ALA A   1      11.104   6.134  -6.504  1.00 20.00           N",
    label: "a.pdb",
    path: "a.pdb",
  }), { activeGroup: "files" });
  // The viewer is loaded on demand, so a static render stops at its fallback —
  // which is the point: the contents are never printed as raw text.
  assert.match(markup, /class="doc-placeholder"><span class="spinner"/);
  assert.doesNotMatch(markup, /ATOM/);
});

test("the panel's left edge is a separator that reports the width it is at", () => {
  const markup = render(initialTabState(), { resize: { ...resize, width: 512 } });
  assert.match(markup, /class="workspace-splitter"/);
  assert.match(markup, /role="separator"/);
  // A separator a keyboard cannot reach is a separator half the users cannot
  // use, so it takes focus and says where it is in the range.
  assert.match(markup, /aria-valuenow="512"/);
  assert.match(markup, new RegExp(`aria-valuemin="${PANEL_MIN_WIDTH}"`, "u"));
  assert.match(markup, new RegExp(`aria-valuemax="${PANEL_MAX_WIDTH}"`, "u"));
  assert.match(markup, /tabindex="0"/u);
});
