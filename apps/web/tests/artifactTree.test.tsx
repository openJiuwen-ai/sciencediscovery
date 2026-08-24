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
import { readFileSync } from "node:fs";
import test from "node:test";

import type { ScientificArtifact, WorkspaceFile } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import {
  artifactTreeIconKind,
  ArtifactTreeList,
  workspaceFileTreeIconKind,
  WorkspaceFileTreeList,
} from "../src/App.js";
import { artifactTreeCount, buildArtifactTree, buildWorkspaceFileTree, pathTreeLeaves } from "../src/artifactTree.js";

function artifact(id: string, name: string, kind: ScientificArtifact["kind"] = "dataset"): ScientificArtifact {
  return {
    createdAt: "2026-08-06T00:00:00.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Analysis",
    currentVersion: 1,
    id,
    kind,
    logicalName: name,
    name,
    origin: "llm_declared",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-08-06T00:00:00.000Z",
  };
}

function workspaceFile(path: string, previewKind?: WorkspaceFile["previewKind"]): WorkspaceFile {
  return {
    modifiedAt: "2026-08-07T00:00:00.000Z",
    path,
    ...(previewKind ? { previewKind } : {}),
    size: 128,
  };
}

test("buildArtifactTree nests full logical names while flat names stay at the root", () => {
  const tree = buildArtifactTree([
    artifact("nested", "e/f/g.md"),
    artifact("flat", "summary.csv"),
  ]);

  assert.equal(tree[0]?.kind, "directory");
  assert.equal(tree[0]?.name, "e");
  const f = tree[0]?.kind === "directory" ? tree[0].children[0] : undefined;
  assert.equal(f?.kind, "directory");
  assert.equal(f?.name, "f");
  const leaf = f?.kind === "directory" ? f.children[0] : undefined;
  assert.equal(leaf?.kind, "artifact");
  assert.equal(leaf?.name, "g.md");
  assert.equal(leaf?.path, "e/f/g.md");
  assert.equal(leaf?.kind === "artifact" ? leaf.artifact.id : undefined, "nested");
  assert.equal(tree[1]?.kind, "artifact");
  assert.equal(tree[1]?.path, "summary.csv");
  assert.equal(artifactTreeCount(tree), 2);
});

test("same basenames in different directories remain separate artifact leaves", () => {
  const tree = buildArtifactTree([
    artifact("a-out", "a/out.csv"),
    artifact("b-out", "b/out.csv"),
  ]);

  assert.equal(artifactTreeCount(tree), 2);
  assert.deepEqual(tree.map((entry) => entry.path), ["a", "b"]);
  assert.deepEqual(tree.map((entry) => entry.kind === "directory" ? entry.children[0]?.path : undefined), [
    "a/out.csv",
    "b/out.csv",
  ]);
});

test("artifact tree icon kind prefers metadata and falls back to the filename for other artifacts", () => {
  assert.equal(artifactTreeIconKind(artifact("metadata-wins", "plot.png", "dataset")), "dataset");
  assert.equal(artifactTreeIconKind(artifact("figure-fallback", "plot.png", "other")), "figure");
  assert.equal(artifactTreeIconKind(artifact("structure-fallback", "model.structure.json", "other")), "structure");
  assert.equal(artifactTreeIconKind(artifact("unknown", "README", "other")), "other");
  // Legacy `.json` rows recorded as dataset must not keep the table icon.
  assert.equal(artifactTreeIconKind(artifact("legacy-json", "af3_input.json", "dataset")), "json");
  assert.equal(artifactTreeIconKind(artifact("legacy-structure-json", "model.structure.json", "structure")), "structure");
});

test("ArtifactTreeList renders distinct compact icons for every scientific artifact family", () => {
  const tree = buildArtifactTree([
    artifact("dataset", "table.csv", "dataset"),
    artifact("figure", "plot.png", "figure"),
    artifact("markdown", "notes.md", "markdown"),
    artifact("report", "paper.pdf", "report"),
    artifact("notebook", "analysis.ipynb", "notebook"),
    artifact("structure", "model.pdb", "structure"),
    artifact("html", "page.html", "html"),
    artifact("latex", "paper.tex", "latex"),
    artifact("json", "af3_input.json", "json"),
    artifact("other", "README", "other"),
    artifact("fallback", "fallback.svg", "other"),
    artifact("nested", "nested/result.csv", "dataset"),
  ]);
  const markup = renderToStaticMarkup(createElement(ArtifactTreeList, { entries: tree, onOpen: () => undefined }));

  for (const kind of ["dataset", "figure", "markdown", "report", "notebook", "structure", "html", "json", "latex", "other"]) {
    assert.match(markup, new RegExp(`artifact-tree-node-icon-${kind}`));
  }
  assert.match(markup, /artifact-tree-folder-icon/);
  assert.match(markup, /artifact-tree-node-icon-figure[^>]*height="14"/);
});

test("ArtifactTreeList renders compact folder and file rows with full-name controls", () => {
  const tree = buildArtifactTree([
    artifact("nested", "e/f/g.md"),
    artifact("flat", "summary.csv"),
  ]);
  const markup = renderToStaticMarkup(createElement(ArtifactTreeList, { entries: tree, onOpen: () => undefined }));

  assert.match(markup, /<details[^>]*open=""/);
  assert.match(markup, /Folder e/);
  assert.match(markup, /Folder e\/f/);
  assert.match(markup, /Open e\/f\/g\.md/);
  assert.match(markup, /class="artifact-tree-file"/);
  assert.match(markup, /title="e\/f\/g\.md"/);
  assert.match(markup, />g\.md</);
  assert.match(markup, /Open summary\.csv/);
  assert.doesNotMatch(markup, /file-row/);
  assert.doesNotMatch(markup, /file-kind/);
  assert.doesNotMatch(markup, />llm_declared<|>dataset<|>v1</);
});

test("artifact tree selection exposes folder and leaf checkboxes instead of preview controls", () => {
  const tree = buildArtifactTree([
    artifact("a-out", "a/out.csv"),
    artifact("a-summary", "a/summary.csv"),
    artifact("b-out", "b/out.csv"),
  ]);
  const aDirectory = tree[0];
  assert.equal(aDirectory?.kind, "directory");
  assert.deepEqual(
    aDirectory?.kind === "directory" ? pathTreeLeaves(aDirectory.children).map((leaf) => leaf.artifact.id) : [],
    ["a-out", "a-summary"],
  );

  const markup = renderToStaticMarkup(createElement(ArtifactTreeList, {
    entries: tree,
    onOpen: () => undefined,
    onSelectionChange: () => undefined,
    selectedArtifactIds: new Set(["a-out"]),
  }));

  assert.match(markup, /aria-checked="mixed"/);
  assert.match(markup, /aria-label="Select folder a"/);
  assert.match(markup, /aria-checked="true"/);
  assert.match(markup, /aria-label="Deselect a\/out\.csv"/);
  assert.match(markup, /aria-checked="false"/);
  assert.match(markup, /aria-label="Select a\/summary\.csv"/);
  assert.doesNotMatch(markup, /Open a\/out\.csv/);
});

test("buildWorkspaceFileTree groups physical files by full path and retains each file", () => {
  const nested = workspaceFile("subagents/worker-1/output.csv", "dataset");
  const tree = buildWorkspaceFileTree([
    nested,
    workspaceFile("a/out.csv"),
    workspaceFile("b/out.csv"),
    workspaceFile("README.md"),
  ]);

  assert.deepEqual(tree.map((entry) => entry.path), ["a", "b", "subagents", "README.md"]);
  const subagents = tree[2];
  const worker = subagents?.kind === "directory" ? subagents.children[0] : undefined;
  const output = worker?.kind === "directory" ? worker.children[0] : undefined;
  assert.equal(output?.kind, "file");
  assert.equal(output?.name, "output.csv");
  assert.equal(output?.path, "subagents/worker-1/output.csv");
  assert.equal(output?.kind === "file" ? output.file : undefined, nested);
});

test("workspace file tree icons use preview kinds and fall back to the generic icon", () => {
  assert.equal(workspaceFileTreeIconKind(workspaceFile("plots/result.png", "figure")), "figure");
  assert.equal(workspaceFileTreeIconKind(workspaceFile("runs/af3_input.json", "json")), "json");
  assert.equal(workspaceFileTreeIconKind(workspaceFile("data/raw", "dataset")), "dataset");
  assert.equal(workspaceFileTreeIconKind(workspaceFile("misc/README")), "other");
});

test("WorkspaceFileTreeList renders compact physical file leaves with full-path controls", () => {
  const tree = buildWorkspaceFileTree([
    workspaceFile("inputs/tables/cohort.csv", "dataset"),
    workspaceFile("notes.md"),
  ]);
  const markup = renderToStaticMarkup(createElement(WorkspaceFileTreeList, { entries: tree, onOpen: () => undefined }));

  assert.match(markup, /Folder inputs/);
  assert.match(markup, /Folder inputs\/tables/);
  assert.match(markup, /Open inputs\/tables\/cohort\.csv/);
  assert.match(markup, /title="inputs\/tables\/cohort\.csv"/);
  assert.match(markup, />cohort\.csv</);
  assert.match(markup, /workspace-file-tree-leaf/);
  assert.match(markup, /artifact-tree-node-icon-dataset/);
  assert.doesNotMatch(markup, /file-row|file-kind/);
});

test("workspace file leaves always use the workspace reader regardless of preview kind", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const openFileStart = app.indexOf("async function openWorkspaceFile(file: WorkspaceFile)");
  const openFileEnd = app.indexOf("function openArtifact", openFileStart);
  assert.notEqual(openFileStart, -1);
  assert.notEqual(openFileEnd, -1);
  const openFile = app.slice(openFileStart, openFileEnd);

  assert.match(openFile, /await openWorkspacePath\(file\.path\)/);
  assert.doesNotMatch(openFile, /file\.(?:kind|previewKind)|setArtifactModalName/);
  assert.match(app, /<WorkspaceFileTreeList[\s\S]*?onOpen=\{\(file\) => void openWorkspaceFile\(file\)\}/);
  assert.match(app, /<ArtifactTreeList[\s\S]*?onOpen=\{openArtifact\}/);
});

test("workspace file tree selection exposes folder and leaf checkboxes independently", () => {
  const tree = buildWorkspaceFileTree([
    workspaceFile("inputs/a.csv", "dataset"),
    workspaceFile("inputs/b.csv", "dataset"),
    workspaceFile("notes.md"),
  ]);
  const markup = renderToStaticMarkup(createElement(WorkspaceFileTreeList, {
    entries: tree,
    onOpen: () => undefined,
    onSelectionChange: () => undefined,
    selectedPaths: new Set(["inputs/a.csv"]),
  }));

  assert.match(markup, /aria-checked="mixed"/);
  assert.match(markup, /aria-label="Select folder inputs"/);
  assert.match(markup, /aria-label="Deselect inputs\/a\.csv"/);
  assert.match(markup, /aria-label="Select inputs\/b\.csv"/);
  assert.doesNotMatch(markup, /Open inputs\/a\.csv/);
});

test("compact path trees use continuous vertical guides without horizontal node separators", () => {
  const css = readFileSync(new URL("../src/styles/workspace.css", import.meta.url), "utf8");
  const treeStart = css.indexOf(".artifact-tree { min-width: 0; }");
  const treeEnd = css.indexOf(".physical-files", treeStart);
  assert.notEqual(treeStart, -1);
  assert.notEqual(treeEnd, -1);
  const treeStyles = css.slice(treeStart, treeEnd);

  assert.match(treeStyles, /\.artifact-tree-directory > \.artifact-tree \{[^}]*border-left:/s);
  assert.doesNotMatch(treeStyles, /border-top:/);
  assert.match(treeStyles, /min-height: 30px/);
  assert.match(treeStyles, /\.artifact-tree-label \{[^}]*font-size: 13px;[^}]*line-height: 1\.35;/s);
});

test("workspace panel uses collapsible sections and header actions instead of a standalone toolbar", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");

  assert.doesNotMatch(app, /className="artifact-tree-toolbar"/);
  assert.match(app, /<details className="workspace-fold artifact-catalog-section" open>/);
  assert.match(app, /<details className="workspace-fold physical-files" open>/);
  assert.match(app, /className="artifact-session-actions"/);
  assert.match(app, /aria-pressed=\{artifactSelectionMode\}/);
  assert.match(app, /aria-pressed=\{workspaceFileSelectionMode\}/);
});
