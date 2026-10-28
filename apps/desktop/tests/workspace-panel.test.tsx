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

import type { Subagent } from "../src/api/types.js";
import { PANEL_MAX_WIDTH, PANEL_MIN_WIDTH } from "../src/app/panel-width.js";
import type { PanelResize } from "../src/app/use-panel-width.js";
import type { PreviewSlot, TabState, WorkspaceActions } from "../src/app/use-workspace.js";
import { HOME_TAB_ID, initialTabState, placeDocument } from "../src/app/preview-tabs.js";
import { PanelExpand, VersionMenu, WorkspacePanel } from "../src/views/WorkspacePanel.js";

/** The panel only reads these; the rest of the interface is not reached by a
 *  static render. */
const actions = {
  closeTab: () => false,
  openArtifact: async () => {},
  openFile: async () => {},
  selectArtifactVersion: async () => {},
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

test("a fresh panel offers two group tabs and opens on 工作区", () => {
  const markup = render(initialTabState());
  assert.equal(count(markup, 'role="tab"'), 2);
  for (const label of ["产物", "工作区"]) {
    assert.ok(markup.includes(`<span>${label}</span>`), `${label} is missing from the group tabs`);
  }
  // 团队 is gone: this build has no team for the tab to show. 会话 is not a tab
  // either — the run's steps live in the transcript.
  assert.doesNotMatch(markup, /<span>团队<\/span>/);
  assert.doesNotMatch(markup, /<span>会话<\/span>/);
  assert.doesNotMatch(markup, /<span>文件<\/span>/);
  assert.equal(count(markup, "panel-group-tab is-active"), 1);
  // The panel's own controls live in its header, not in a tab bar. Only the
  // collapse control is left; the expand affordance is gone.
  assert.doesNotMatch(markup, /aria-label="放大面板"/);
  assert.match(markup, /aria-label="收起面板"/);
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

test("an empty artifact list says the project has none, not this session", () => {
  // The list spans every Session, so "this session has none" would be a claim
  // about the wrong thing on a screen that is looking wider.
  const markup = render(initialTabState(), { activeGroup: "artifacts" });
  assert.ok(markup.includes("还没有产物。"), "the empty list does not say so");
  assert.doesNotMatch(markup, /这次会话还没有产物/u);
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
    artifactId: "a1",
    label: "结构比对报告.md",
    path: "",
    source: "artifact",
    versionId: "v1",
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
  // Two group tabs plus the document.
  assert.equal(count(markup, 'role="tab"'), 3);
  assert.equal(count(markup, "doc-tab-close"), 1);
  // The strip is only the documents that are open: there is no `+` to make an
  // empty tab, because a document is what a tab is for.
  assert.doesNotMatch(markup, /aria-label="新增页签"/u);
  assert.doesNotMatch(markup, /doc-tab-more/u);
  // The close control is a drawn cross, so its hover square is centred on it.
  assert.match(markup, /class="doc-tab-close"[^>]*><svg/u);
  assert.match(markup, /class="doc-tab is-active"/);
  assert.match(markup, /<h1>标题<\/h1>/);
  // The artifacts list stays beside the document, and the document is drawn on
  // the handoff's canvas rather than in the list column.
  assert.match(markup, /所有产物/);
  assert.match(markup, /class="artifact-canvas"/);
  assert.match(markup, /aria-label="下载"/);
  // One version is not a choice, so there is no picker to offer.
  assert.doesNotMatch(markup, /aria-label="版本"/u);
});

test("the tab strip is one row, not a tablist nested in itself", () => {
  // The strip and the row that holds its actions used to share one class, so
  // the tablist inherited the row's fixed 46px height as a width and clipped
  // every tab after the first few pixels of its label.
  const placed = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "a1",
    label: "trace.md",
    path: "subagents/a1/trace.md",
    source: "artifact",
    versionId: "v1",
  });
  const markup = render({ ...placed, tabs: placed.tabs.map((slot) => ({ ...slot, content: "x", loading: false })) }, {
    activeGroup: "artifacts",
  });
  assert.equal(count(markup, 'class="doc-tabbar"'), 1);
  assert.equal(count(markup, 'class="doc-tabs"'), 1);
  assert.ok(
    markup.indexOf('class="doc-tabbar"') < markup.indexOf('class="doc-tabs"'),
    "the tablist sits inside the row",
  );
});

function artifactOutput(id: string, artifactId: string, path: string, version: number) {
  return {
    artifact: { id: artifactId, kind: "markdown", name: "trace.md" },
    version: { id, sourcePath: path, version },
  };
}

test("two open tabs with the same name show the folder that tells them apart", () => {
  const first = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "a1",
    label: "trace.md",
    path: "subagents/a1/trace.md",
    source: "artifact",
    versionId: "v1",
  });
  const second = placeDocument(first.tabs, first.activeTabId, {
    artifactId: "b2",
    label: "trace.md",
    path: "subagents/b2/trace.md",
    source: "artifact",
    versionId: "v2",
  });
  const tabs: TabState = {
    ...second,
    tabs: second.tabs.map((slot) => ({ ...slot, content: "# trace", loading: false })),
  };
  const outputs = [
    artifactOutput("v1", "a1", "subagents/a1/trace.md", 1),
    artifactOutput("v2", "b2", "subagents/b2/trace.md", 1),
  ] as never;
  const markup = render(tabs, { activeGroup: "artifacts", outputs });
  assert.equal(count(markup, 'class="doc-tab-name">trace.md<'), 2, "both tabs stay visible");
  assert.match(markup, /class="doc-tab-hint">a1</);
  assert.match(markup, /class="doc-tab-hint">b2</);
});

test("the open artifact chooses its version from the document's top right", () => {
  // One `app/trace.md` written by a subagent and rewritten by the leader turn:
  // one tab, one row, and a picker for the versions behind them.
  const placed = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "same",
    label: "trace.md",
    path: "app/trace.md",
    source: "artifact",
    versionId: "v2",
  });
  const tabs: TabState = {
    ...placed,
    tabs: placed.tabs.map((slot) => ({ ...slot, content: "# trace", loading: false })),
  };
  const outputs = [
    artifactOutput("v1", "same", "subagents/8415d00a/app/trace.md", 1),
    artifactOutput("v2", "same", "app/trace.md", 2),
  ] as never;
  const markup = render(tabs, { activeGroup: "artifacts", outputs });
  // One tab for the artifact, not one per version.
  assert.equal(count(markup, 'class="doc-tab-name">trace.md<'), 1);
  // The trigger shows the version the tab holds and says it opens a menu. It
  // is drawn here rather than left to a native select, whose popup is the
  // platform's own square list; the menu is a card of the panel's own.
  assert.equal(count(markup, 'class="doc-versions"'), 1);
  assert.match(markup, /aria-label="版本 v2"[^>]*>v2</u);
  assert.match(markup, /aria-haspopup="menu"/u);
  assert.match(markup, /aria-expanded="false"/u);
  assert.doesNotMatch(markup, /<select/u);
  assert.doesNotMatch(markup, /doc-version-menu/u, "the menu only exists while it is open");
  // The hints stay for names that collide across artifacts; a version is not
  // one, so it is not a tab hint either.
  assert.doesNotMatch(markup, /doc-tab-hint/u);
});

test("the version menu marks the version on screen", () => {
  const versions = [
    artifactOutput("v2", "same", "app/trace.md", 2),
    artifactOutput("v1", "same", "subagents/a1/app/trace.md", 1),
  ] as never;
  const markup = renderToStaticMarkup(
    <VersionMenu current="v2" onSelect={() => {}} versions={versions} />,
  );
  assert.equal(count(markup, 'role="menuitemradio"'), 2);
  assert.match(markup, /aria-checked="true"[^>]*><span>v2<\/span><svg/u);
  assert.match(markup, /aria-checked="false"[^>]*><span>v1<\/span><\/button>/u);
});

test("a tab with a unique name spends its width on the name alone", () => {
  // A hint belongs to a collision between *open* documents, not to a version
  // number that happens to exist in the list.
  const placed = placeDocument(initialTabState().tabs, HOME_TAB_ID, {
    artifactId: "same",
    label: "trace.md",
    path: "subagents/a1/trace.md",
    source: "artifact",
    versionId: "v1",
  });
  const outputs = [
    artifactOutput("v1", "same", "subagents/a1/trace.md", 1),
    artifactOutput("v2", "same", "app/trace.md", 2),
  ] as never;
  const markup = render({ ...placed, tabs: placed.tabs.map((slot) => ({ ...slot, content: "x", loading: false })) }, {
    activeGroup: "artifacts",
    outputs,
  });
  assert.doesNotMatch(markup, /doc-tab-hint/);
});

test("two artifacts with the same file name show the folder each came from", () => {
  const output = (id: string, path: string) => ({
    artifact: { id: `a-${id}`, kind: "markdown", name: "trace.md" },
    version: { id, sourcePath: path, version: 1 },
  });
  const markup = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [output("v1", "subagents/a1/trace.md"), output("v2", "subagents/b2/trace.md")] as never,
  });
  assert.equal(count(markup, 'class="label">trace.md<'), 2);
  assert.match(markup, /class="label-meta" title="subagents\/a1\/trace\.md">a1</);
  assert.match(markup, /class="label-meta" title="subagents\/b2\/trace\.md">b2</);
});

test("two versions of one artifact are one row, opening the newest", () => {
  // The two `trace.md` rows of this session were not two files: they were v1
  // and v2 of `app/trace.md`, written by different turns. The list is
  // artifacts, so there is one entry — and it is the newest version's.
  const markup = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [
      artifactOutput("v1", "same", "subagents/8415d00a/app/trace.md", 1),
      artifactOutput("v2", "same", "app/trace.md", 2),
    ] as never,
  });
  assert.equal(count(markup, 'class="label">trace.md<'), 1);
  assert.match(markup, /title="app\/trace\.md"/, "the row is the newest version");
  // No folder hint on the row: the name is unique, so the folder would be a
  // column of the same value twice. The group heading's `当前会话` is not it.
  assert.doesNotMatch(markup, /class="label-meta" title=/);
});

test("distinct artifact names get no folder column", () => {
  const markup = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [
      {
        artifact: { id: "a1", kind: "markdown", name: "trace.md" },
        version: { id: "v1", sourcePath: "subagents/a1/trace.md", version: 1 },
      },
      {
        artifact: { id: "a2", kind: "other", name: "answer.txt" },
        version: { id: "v2", sourcePath: "subagents/a1/answer.txt", version: 1 },
      },
    ] as never,
  });
  assert.doesNotMatch(markup, /class="label-meta" title=/);
});

test("a document belongs to the group it was opened from", () => {
  // An artifact tab must not surface under 文件, nor a source file under 产物:
  // the two lists are views of the same workspace, not one shared shelf.
  const artifactDoc: TabState = document({ source: "artifact", artifactId: "v1", label: "报告.md" });
  const artifacts = render(artifactDoc, { activeGroup: "artifacts" });
  assert.match(artifacts, /报告\.md/);
  const files = render(artifactDoc, { activeGroup: "files" });
  assert.match(files, /还没有打开文件/);

  const fileDoc = document({ label: "notes.md" });
  const underArtifacts = render(fileDoc, { activeGroup: "artifacts" });
  assert.match(underArtifacts, /还没有打开产物/);
});

test("an unopened document says what the screen lacks, not what the session lacks", () => {
  // The screenshot that prompted this: a full artifact list and a full file
  // tree, and a document column claiming there were none of either. The lists
  // answer "what exists"; the column answers "what is on screen", and those
  // are different questions whenever nothing has been clicked yet.
  const artifacts = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [artifactOutput("v1", "a1", "app/report.md", 1)] as never,
  });
  assert.match(artifacts, /还没有打开产物/);
  assert.doesNotMatch(artifacts, /这次会话还没有产物/);
  assert.match(artifacts, /report\.md/);

  const workspace = render(initialTabState(), {
    activeGroup: "files",
    files: [{ modifiedAt: "2026-01-01T00:00:00.000Z", path: "notes.md", size: 10 }],
  });
  assert.match(workspace, /还没有打开文件/);
  assert.doesNotMatch(workspace, /工作区里还没有文件/);
  assert.match(workspace, /notes\.md/);
});

test("the artifact list shows every session's output, the open one first", () => {
  // The panel used to read only the open session's outputs, so the files made
  // earlier in the day were invisible from the session being written now.
  const output = (id: string, sessionId: string, title: string, name: string) => ({
    artifact: { createdInSessionId: sessionId, createdInSessionTitle: title, id, kind: "markdown", name },
    version: { id: `v-${id}`, sourcePath: name, version: 1 },
  });
  const markup = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [
      output("a1", "s-old", "上周的会话", "old.md"),
      output("a2", "s-now", "正在写的会话", "now.md"),
    ] as never,
    sessionId: "s-now",
    sessions: [
      { id: "s-now", title: "正在写的会话" },
      { id: "s-old", title: "上周的会话" },
    ] as never,
  });
  // The open Session's group starts open, and the others start closed: the
  // column opens on the work in hand instead of listing a week of it.
  assert.equal(count(markup, 'class="panel-list-row'), 1);
  assert.match(markup, /class="panel-output-head is-current is-open"/);
  assert.match(markup, /class="label-meta">当前会话</u);
  // The heading is the fold's control, like a folder in the tree beside it.
  assert.equal(count(markup, 'class="panel-output-head'), 2);
  assert.match(markup, /aria-expanded="true"[^>]*class="panel-output-head/u);
  assert.equal(count(markup, 'aria-expanded="false"'), 1, "the other session's group is folded");
  // Folded is not hidden: the other Session's name is still there to open.
  assert.match(markup, /上周的会话/);
  // The open session's heading comes first, the other one after it.
  assert.ok(
    markup.indexOf("正在写的会话") < markup.indexOf("上周的会话"),
    "the open session's group is not pinned first",
  );
});

test("the heading names the session even when it is the only one", () => {
  // An artifact belongs to a Session, and the list is grouped by the Session
  // that made it. Heading only the second group made the list change shape as
  // a Project grew; the name is there from the first artifact on.
  const markup = render(initialTabState(), {
    activeGroup: "artifacts",
    outputs: [{
      artifact: { createdInSessionId: "s-now", createdInSessionTitle: "会话", id: "a1", kind: "markdown", name: "now.md" },
      version: { id: "v1", sourcePath: "now.md", version: 1 },
    }] as never,
    sessionId: "s-now",
    sessions: [{ id: "s-now", title: "会话" }] as never,
  });
  assert.match(markup, /now\.md/);
  assert.equal(count(markup, 'class="panel-output-head'), 1);
  assert.match(markup, /class="panel-output-head is-current is-open"/);
  assert.match(markup, /<span class="label">会话<\/span>/);
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

test("a txt answer is set as a page, not as a box of source", () => {
  const markup = render(document({
    content: "ANSWER: two anti-correlated groups\n\nCluster A (n = 6)",
    label: "answer.txt",
    path: "answer.txt",
  }), { activeGroup: "files" });
  assert.match(markup, /<pre class="tab-content-source is-prose">/u);
  assert.match(markup, /ANSWER: two anti-correlated groups/u);
});

test("a log keeps the monospaced listing, where columns line up", () => {
  const markup = render(document({
    content: "2026-10-26T06:29:36Z started\ndone",
    label: "run.log",
    path: "run.log",
  }), { activeGroup: "files" });
  assert.match(markup, /<pre class="tab-content-source">/u);
  assert.doesNotMatch(markup, /is-prose/u);
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

function subagent(overrides: Partial<Subagent> = {}): Subagent {
  return {
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "a1",
    input: { description: "read the literature", prompt: "search and summarize" },
    maxTurns: 12,
    parentTurnId: "turn-1",
    sessionId: "s1",
    status: "completed",
    steps: [],
    timeoutSeconds: 600,
    turnCount: 2,
    ...overrides,
  };
}

test("a subagent replaces the panel's groups rather than becoming a third tab", () => {
  const markup = render(initialTabState(), { subagent: subagent() });
  // No 团队 tab, and no group tabs at all while the child is open: the panel
  // shows the child's record. There is no back arrow either — the transcript
  // line that opened the child is the way back.
  assert.doesNotMatch(markup, /role="tab"/u);
  assert.doesNotMatch(markup, /<span>团队<\/span>/);
  assert.doesNotMatch(markup, /当前活跃/u);
  assert.doesNotMatch(markup, /class="panel-back"/u);
  assert.match(markup, /read the literature/);
  assert.match(markup, /class="subagent-detail"/);
});

test("the child's execution and its final output are both shown", () => {
  const markup = render(initialTabState(), {
    subagent: subagent({
      steps: [
        { content: "weighing the options", createdAt: "2026-01-01T00:00:01.000Z", id: "s1", kind: "thinking" },
        {
          content: "three papers found",
          createdAt: "2026-01-01T00:00:02.000Z",
          id: "s2",
          kind: "tool",
          status: "completed",
          toolName: "literature_search",
        },
        { content: "CONCLUSION-TEXT", createdAt: "2026-01-01T00:00:03.000Z", id: "s3", kind: "assistant" },
      ],
    }),
  });
  assert.match(markup, /weighing the options/);
  assert.match(markup, /literature_search/);
  assert.match(markup, /three papers found/);
  // The timeline is a card that starts closed, so the panel opens on the
  // answer rather than on a screen of steps.
  assert.match(markup, /<details class="subagent-card subagent-execution">/u);
  // The final answer is the output section, not a row in the timeline as well.
  assert.equal(count(markup, "CONCLUSION-TEXT"), 1);
  assert.match(markup, /class="subagent-output"/);
});

test("a tool's result is boxed, so it reads as output rather than as the timeline", () => {
  const markup = render(initialTabState(), {
    subagent: subagent({
      steps: [{
        content: "TOOL-RESULT",
        createdAt: "2026-01-01T00:00:01.000Z",
        id: "s1",
        input: '{"skillId": "code-engineer"}',
        kind: "tool",
        status: "completed",
        toolName: "read_skill",
      }],
    }),
  });
  const resultAt = markup.indexOf("TOOL-RESULT");
  assert.ok(resultAt >= 0);
  const boxAt = markup.lastIndexOf('class="subagent-tool-output"', resultAt);
  assert.ok(boxAt >= 0 && boxAt < resultAt, "the result should sit inside an output box");
  // 输入 and 输出 are both named, so the two boxes are not mistaken for each other.
  assert.match(markup, /subagent-step-label">输出<\/div><div class="subagent-tool-output"/u);
  assert.match(markup, /subagent-step-label">输入<\/div>/u);
});

test("the task the child was handed is shown above its steps", () => {
  const markup = render(initialTabState(), {
    subagent: subagent({
      input: {
        description: "read the literature",
        inputPaths: ["papers/a.pdf"],
        prompt: "PROMPT-BODY",
      },
    }),
  });
  // The brief is a card as well, and it starts closed like the timeline.
  assert.match(markup, /<details class="subagent-card subagent-task">/u);
  assert.match(markup, /PROMPT-BODY/u);
  assert.match(markup, /subagent-section-title">任务</u);
  // A path is shown as a chip of its own, not folded into the prose.
  assert.match(markup, /class="subagent-task-path" title="papers\/a\.pdf"/u);
  // The brief and the timeline are separately named, so one cannot be read as
  // the other.
  assert.match(markup, /subagent-section-title">执行详情</u);
});

test("a reply is shown in full rather than folded", () => {
  const markup = render(initialTabState(), {
    subagent: subagent({
      steps: [
        { content: "INTERIM-REPLY", createdAt: "2026-01-01T00:00:01.000Z", id: "s1", kind: "assistant" },
        { content: "FINAL-ANSWER", createdAt: "2026-01-01T00:00:02.000Z", id: "s2", kind: "assistant" },
      ],
    }),
  });
  const replyAt = markup.indexOf("INTERIM-REPLY");
  assert.ok(replyAt >= 0);
  // The only fold above it is the execution card the reader opened to get here:
  // an earlier reply is prose in the timeline, not a fold of its own, while the
  // last one is the output section.
  const before = markup.slice(0, replyAt);
  assert.equal(before.lastIndexOf("<details"), before.lastIndexOf('<details class="subagent-card subagent-execution"'));
});

test("the runtime's own system steps are left out of the timeline", () => {
  const markup = render(initialTabState(), {
    subagent: subagent({
      steps: [
        { content: "Turn 1 started", createdAt: "2026-01-01T00:00:01.000Z", id: "s1", kind: "system" },
        { content: "looked around", createdAt: "2026-01-01T00:00:02.000Z", id: "s2", kind: "thinking" },
      ],
    }),
  });
  assert.doesNotMatch(markup, /Turn 1 started/);
  assert.match(markup, /looked around/);
});

test("a child that timed out has no output, only what it had said so far", () => {
  // Nobody delivered anything here. The last thing the child said is a progress
  // note it was interrupted in the middle of, so calling it 输出 would report a
  // result the child never produced; it stays in the timeline instead.
  const markup = render(initialTabState(), {
    subagent: subagent({
      error: "Subagent wall-clock timeout after 5400 seconds",
      status: "timed_out",
      steps: [{
        content: "MOST-NUMBERS-HOLD",
        createdAt: "2026-01-01T00:00:01.000Z",
        id: "s1",
        kind: "assistant",
      }],
    }),
  });
  assert.doesNotMatch(markup, /class="subagent-output"/u);
  assert.match(markup, /MOST-NUMBERS-HOLD/u);
  assert.equal(count(markup, "MOST-NUMBERS-HOLD"), 1);
});

test("a child that has not run anything yet says so", () => {
  const markup = render(initialTabState(), { subagent: subagent({ status: "running" }) });
  assert.match(markup, /class="subagent-status is-running"/u);
  assert.match(markup, /执行中/u);
  assert.match(markup, /class="workspace-empty"/);
});

test("a tool block opened from the run takes the panel, like a child does", () => {
  // The run's tiles are short by design; the panel is where the untruncated
  // text is read. It is one mode of the panel, so the group tabs step aside.
  const markup = render(initialTabState(), {
    tool: {
      content: "the whole output\nsecond line",
      id: "result",
      label: "Result",
      name: "run_python",
      status: "completed",
      toolId: "c1",
    },
  });
  assert.match(markup, /class="panel-head is-subagent"/u);
  assert.match(markup, /工具调用/u);
  assert.match(markup, /run_python/u);
  assert.match(markup, /class="panel-body is-tool"/u);
  assert.match(markup, /the whole output\nsecond line/u);
  // The groups are still reachable: the tablist is what the head shows when
  // the mode closes, and nothing here takes that away.
  assert.doesNotMatch(markup, /role="tablist"/u);
});

test("a replayed child says it is loading instead of claiming it recorded nothing", () => {
  // A run's event log stores child snapshots without steps, so a reopened
  // finished run arrives empty. Saying "no execution was recorded" while the
  // catalog read is still in flight would be wrong, and would stay on screen
  // if the reader looked away before it landed.
  const markup = render(initialTabState(), {
    subagent: subagent({ status: "completed" }),
    subagentLoading: true,
  });
  assert.match(markup, /class="spinner"/u);
  assert.match(markup, /正在加载执行记录/u);
  assert.doesNotMatch(markup, /还没有留下可展示的执行记录/u);
});

test("a failed child keeps the reason beside its status", () => {
  const markup = render(initialTabState(), {
    subagent: subagent({ error: "the provider refused the request", status: "failed" }),
  });
  assert.match(markup, /执行失败|失败/);
  assert.match(markup, /the provider refused the request/);
  // The reason belongs to how the child ran, so it sits under the status strip
  // rather than opening the panel above the brief.
  const reasonAt = markup.indexOf("the provider refused the request");
  const statusAt = markup.indexOf('class="subagent-status is-failed"');
  assert.ok(statusAt >= 0 && statusAt < reasonAt, "the reason should follow the status");
});

test("the list and the document are separated by a draggable divider", () => {
  const markup = render(initialTabState());
  assert.match(markup, /class="panel-splitter"/u);
  assert.match(markup, /aria-label="调整列表宽度"/u);
  assert.match(markup, /aria-orientation="vertical"/u);
  // A divider only a pointer can use is half a divider: it takes focus and
  // reports where it is, so the arrow keys have somewhere to land.
  assert.match(markup, /tabindex="0"/u);
  assert.match(markup, /aria-valuenow="240"/u);
  // Both columns are open, so there is no edge in need of a way back.
  assert.doesNotMatch(markup, /panel-expand/u);
});

test("a closed column shows a control at its edge that reads as a button", () => {
  const left = renderToStaticMarkup(<PanelExpand side="left" />);
  assert.match(left, /class="panel-expand is-left"/u);
  // The divider carries the label and the keyboard action; the pill is its
  // drawing, so it does not repeat either to a screen reader.
  assert.match(left, /aria-hidden="true"/u);
  // The arrow points at the column the click brings back, not away from it.
  assert.match(left, /m9 5 7 7-7 7/u);
  const right = renderToStaticMarkup(<PanelExpand side="right" />);
  assert.match(right, /class="panel-expand is-right"/u);
  assert.match(right, /m15 5-7 7 7 7/u);
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
