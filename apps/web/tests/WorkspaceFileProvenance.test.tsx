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
import test from "node:test";

import type { WorkspaceFileProvenance } from "@sciencediscovery/schema";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";

import { WorkspaceFileProvenanceModal } from "../src/WorkspaceFileProvenanceModal.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const timestamp = "2026-08-01T10:00:00.000Z";

function provenance(origin: "tool" | "unknown"): WorkspaceFileProvenance {
  const currentRevision = {
    artifactVersionIds: ["artifact-version-1"],
    contentHash: "a".repeat(64),
    createdAt: timestamp,
    executionRunId: "execution-run-with-a-long-id",
    fileId: "file-1",
    id: "revision-1",
    modifiedAt: timestamp,
    origin,
    path: "results/report.md",
    projectId: "project-1",
    runId: "run-1",
    sessionId: "session-1",
    size: 42,
    toolCallId: "tool-call-1",
    toolName: "run_python" as const,
  };
  return {
    artifacts: [{ artifactId: "artifact-1", name: "report.md", version: 2, versionId: "artifact-version-1" }],
    currentRevision,
    file: {
      createdAt: timestamp,
      currentRevisionId: currentRevision.id,
      id: currentRevision.fileId,
      path: currentRevision.path,
      projectId: currentRevision.projectId,
      sessionId: currentRevision.sessionId,
      sessionTitle: "A very long source Session title retained for provenance display",
      updatedAt: timestamp,
    },
    lineage: [{
      fileId: "parent-file",
      origin: "upload",
      path: "inputs/source.md",
      revisionId: "parent-revision",
      session: { deleted: false, id: "session-0", title: "Input Session" },
    }],
    revisions: [currentRevision],
    sourceSession: {
      deleted: false,
      id: "session-1",
      title: "A very long source Session title retained for provenance display",
    },
  };
}

test("Workspace file provenance modal renders direct source and execution context", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceFileProvenanceModal, {
    file: { modifiedAt: timestamp, path: "results/report.md", size: 42 },
    onClose: () => undefined,
    provenance: provenance("tool"),
  }));

  assert.match(html, /Workspace file provenance/);
  assert.match(html, /A very long source Session title retained for provenance display/);
  assert.match(html, /workspace-provenance-session/);
  assert.match(html, /Workspace tool/);
  assert.match(html, /run_python/);
  assert.match(html, /report\.md/);
  assert.match(html, /Input Session/);
  assert.match(html, /Revision history/);
});

test("Workspace file provenance modal explains unknown attribution without guessing", () => {
  const html = renderToStaticMarkup(createElement(WorkspaceFileProvenanceModal, {
    file: { modifiedAt: timestamp, path: "results/report.md", size: 42 },
    onClose: () => undefined,
    provenance: provenance("unknown"),
  }));
  assert.match(html, /source is intentionally not inferred/);
  assert.match(html, /Unknown/);
});

test("Workspace file provenance values can be expanded for copying", async () => {
  const hash = "a".repeat(64);
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(createElement(WorkspaceFileProvenanceModal, {
      file: { modifiedAt: timestamp, path: "results/report.md", size: 42 },
      onClose: () => undefined,
      provenance: provenance("tool"),
    }));
  });

  const findHash = () => renderer!.root.find((node) => node.type === "code" && node.props.title === hash);
  assert.deepEqual(findHash().children, ["aaaaaaaa...aaaa"]);
  const toggle = findHash().parent!.findByType("button");
  assert.equal(toggle.props["aria-expanded"], false);
  assert.equal(toggle.props["aria-label"], "Show full value");

  await act(async () => toggle.props.onClick());
  assert.deepEqual(findHash().children, [hash]);
  assert.equal(findHash().parent!.findByType("button").props["aria-expanded"], true);
  assert.equal(findHash().parent!.findByType("button").props["aria-label"], "Collapse value");

  await act(async () => renderer!.unmount());
});
