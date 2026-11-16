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

/**
 * Which session a finished package is filed under (#1154 review F1): packaging
 * outlives the dialog that started it, so the write must carry the exporting
 * session, not whichever dialog happens to be open when it finishes.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import React from "react";

import { TEXT } from "../src/text.js";
import { ResearchPackage } from "../src/views/ResearchPackage.js";
import { act, create } from "./support/dom-renderer.js";

const t = TEXT.researchPackage;

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

/** The dialog installs a focus trap that reaches for the DOM; there is none here. */
function stubDocument(): () => void {
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    activeElement: null,
    addEventListener: () => undefined,
    querySelector: () => null,
    querySelectorAll: () => [],
    removeEventListener: () => undefined,
  };
  return () => { globals.document = previous; };
}

/** The shell bridge, recording what each write says it belongs to. */
function stubShell(writes: Array<{ meta?: { sessionId?: string; sessionTitle?: string } }>): () => void {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    sdShell: {
      exportFile: {
        saveDialog: async () => ({ canceled: false, token: "token-A" }),
        write: async (_token: string, _data: ArrayBuffer, meta?: { sessionId?: string; sessionTitle?: string }) => {
          writes.push({ meta });
          return { ok: true };
        },
        showInFolder: async () => ({ ok: true }),
        downloadsDir: async () => "C:\\Users\\me\\Downloads",
      },
      exportHistory: {
        list: async () => [],
        reveal: async () => ({ missing: false, ok: true }),
        forget: async () => ({ ok: true }),
      },
    },
  };
  return () => { globals.window = previous; };
}

const task = { filename: "pkg.sdresearch", id: "task-1", status: "queued" };

/** Answers the export dialog's reads: previews, session details, and one export
 *  task that is still queued until the poller asks again. */
function client(completed: { value: boolean }) {
  return {
    request: async (path: string) => {
      if (path.startsWith("/api/sessions/")) {
        const id = path.split("/")[3]!;
        return { id, messages: [], title: id === "s1" ? "会话 A" : "会话 B" };
      }
      if (path.includes("/preview")) return { estimatedBytes: 1024, files: [], omissions: [], revision: "r1" };
      if (path.endsWith("/exports") ) return task;
      if (path.includes("/exports/")) return { ...task, status: completed.value ? "completed" : "queued" };
      return {};
    },
    fetchStream: async () => ({ blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }),
  } as never;
}

const props = { onOpen: () => undefined, onRefresh: async () => undefined, projects: [] };

test("a package that finishes after another session's dialog opened is filed under the exporting session", async (context) => {
  const previousAct = (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT;
  (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const restoreDocument = stubDocument();
  const writes: Array<{ meta?: { sessionId?: string; sessionTitle?: string } }> = [];
  const restoreShell = stubShell(writes);
  const completed = { value: false };
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(React.createElement(ResearchPackage, {
        ...props,
        client: client(completed),
        request: { kind: "export", projectId: "p1", sessionId: "s1" },
      }));
    });
    await act(async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); });

    // Start the export from session A, then move the dialog to session B while
    // the package is still being built.
    const start = view.root.findAllByType("button").find((button) => button.props.className === "primary-button");
    assert.ok(start, "the dialog offers 开始后台导出");
    assert.equal(start!.props.children, t.startExport);
    await act(async () => { start!.props.onClick(); });
    await act(async () => {
      view.update(React.createElement(ResearchPackage, {
        ...props,
        client: client(completed),
        request: { kind: "export", projectId: "p1", sessionId: "s2" },
      }));
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve();
    });

    // The package finishes now: the poller's newest closure knows session B.
    completed.value = true;
    await act(async () => { context.mock.timers.tick(1_000); });
    await act(async () => { for (let tick = 0; tick < 12; tick += 1) await Promise.resolve(); });

    assert.equal(writes.length, 1, "the archive was written once");
    assert.equal(writes[0]!.meta?.sessionId, "s1", "filed under the session that exported it");
    assert.equal(writes[0]!.meta?.sessionTitle, "会话 A");
  } finally {
    act(() => { view.unmount(); });
    restoreShell();
    restoreDocument();
    context.mock.timers.reset();
    (globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = previousAct;
  }
});
