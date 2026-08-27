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

import type { ScientificArtifact } from "@sciencediscovery/schema";
import { createElement } from "react";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "react-test-renderer";

import {
  ArtifactLifecycleControls,
  ArtifactLifecycleProvider,
} from "../src/ArtifactLifecycleControls.js";
import { LocaleProvider } from "../src/i18n/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

function artifact(id: string): ScientificArtifact {
  return {
    createdAt: "2026-08-26T00:00:00.000Z",
    createdInSessionId: "session-1",
    createdInSessionTitle: "Session",
    currentVersion: 1,
    id,
    kind: "dataset",
    logicalName: `${id}.csv`,
    name: `${id}.csv`,
    origin: "user_upload",
    projectId: "project-1",
    sessionId: "session-1",
    updatedAt: "2026-08-26T00:00:00.000Z",
  };
}

function view({
  onDelete,
  onError = () => undefined,
}: {
  onDelete: (item: ScientificArtifact) => Promise<void>;
  onError?: (message: string) => void;
}) {
  return createElement(LocaleProvider, { initialLocale: "zh-CN" }, createElement(ArtifactLifecycleProvider, {
    onDelete,
    onError,
    resetKey: "project-1",
  }, createElement("div", null,
    createElement(ArtifactLifecycleControls, { artifact: artifact("artifact-a") }),
    createElement(ArtifactLifecycleControls, { artifact: artifact("artifact-b") }),
  )));
}

function deleteButton(renderer: ReactTestRenderer, artifactId: string): ReactTestInstance {
  return renderer.root.find((node) => node.type === "button" && node.props["data-artifact-id"] === artifactId);
}

test("delete requires two clicks on the same artifact and only one row can be armed", async () => {
  const deleted: string[] = [];
  let finishDelete: (() => void) | undefined;
  const pendingDelete = new Promise<void>((resolve) => { finishDelete = resolve; });
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(view({
      onDelete: async (item) => {
        deleted.push(item.id);
        await pendingDelete;
      },
    }));
  });

  await act(async () => { deleteButton(renderer!, "artifact-a").props.onClick(); });
  assert.equal(deleteButton(renderer!, "artifact-a").props["aria-pressed"], true);
  assert.deepEqual(deleteButton(renderer!, "artifact-a").children, ["删除？"]);
  assert.deepEqual(deleted, []);

  await act(async () => { deleteButton(renderer!, "artifact-b").props.onClick(); });
  assert.equal(deleteButton(renderer!, "artifact-a").props["aria-pressed"], false);
  assert.equal(deleteButton(renderer!, "artifact-b").props["aria-pressed"], true);
  assert.deepEqual(deleted, []);

  await act(async () => { deleteButton(renderer!, "artifact-b").props.onClick(); });
  assert.deepEqual(deleted, ["artifact-b"]);
  assert.equal(deleteButton(renderer!, "artifact-b").props.disabled, true);
  assert.equal(deleteButton(renderer!, "artifact-b").findByType("svg").props.className, "lucide lucide-loader-circle spin");

  await act(async () => { finishDelete?.(); });
  assert.equal(deleteButton(renderer!, "artifact-b").props.disabled, false);
  await act(async () => renderer!.unmount());
});

test("moving focus elsewhere cancels an armed deletion", async () => {
  let calls = 0;
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(view({ onDelete: async () => { calls += 1; } }));
  });

  await act(async () => { deleteButton(renderer!, "artifact-a").props.onClick(); });
  await act(async () => { deleteButton(renderer!, "artifact-a").props.onBlur(); });
  await act(async () => { deleteButton(renderer!, "artifact-a").props.onClick(); });
  assert.equal(calls, 0);
  assert.equal(deleteButton(renderer!, "artifact-a").props["aria-pressed"], true);
  await act(async () => renderer!.unmount());
});

test("mouse presses do not leave lifecycle controls focus-locked", async () => {
  let renderer: ReactTestRenderer;
  await act(async () => {
    renderer = create(view({ onDelete: async () => undefined }));
  });

  let prevented = 0;
  let blurred = 0;
  const mouseEvent = {
    currentTarget: { blur: () => { blurred += 1; } },
    preventDefault: () => { prevented += 1; },
  };
  deleteButton(renderer!, "artifact-a").props.onMouseDown(mouseEvent);

  assert.equal(prevented, 1);
  assert.equal(blurred, 1);
  await act(async () => renderer!.unmount());
});

test("mouse-only lifecycle controls reveal on row hover while keyboard focus and touch remain usable", () => {
  const css = readFileSync(new URL("../src/styles/workspace.css", import.meta.url), "utf8");
  assert.match(css, /@media \(hover: hover\) and \(pointer: fine\)/);
  assert.match(css, /\.artifact-tree-actions \{ opacity: 0; pointer-events: none;/);
  assert.match(css, /\.artifact-tree-file-row:hover \.artifact-tree-actions,/);
  assert.match(css, /\.artifact-tree-file-row:focus-within \.artifact-tree-actions \{ opacity: 1; pointer-events: auto;/);
});

test("successful deletion reports the Artifact name in a success toast", () => {
  const app = readFileSync(new URL("../src/App.tsx", import.meta.url), "utf8");
  const start = app.indexOf("async function deleteArtifact");
  const end = app.indexOf("\n  function changeArtifactSelection", start);
  assert.ok(start >= 0 && end > start);
  const deletionFlow = app.slice(start, end);
  const request = deletionFlow.indexOf("await client.deleteProjectArtifact");
  const notification = deletionFlow.indexOf('pushToast("success", t("app.artifactDeleted"), artifact.name);');
  assert.ok(request >= 0 && notification > request);
});
