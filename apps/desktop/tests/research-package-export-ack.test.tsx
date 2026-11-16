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
 * The over-cap acknowledgement has to reach the request (#1152).
 *
 * The dialog shows the warning, and pressing `Export anyway` is what unblocks the export
 * actions — so the flag that unblocked them must be on the outgoing options. This is the
 * case that would have caught the argument being dropped: the footer enabled, the request
 * went out without it, and the server refused work the user had just confirmed.
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

const CAP = 512 * 1024 * 1024;

function stubDocument(): () => void {
  const globals = globalThis as { document?: unknown };
  const previous = globals.document;
  globals.document = {
    activeElement: null, addEventListener: () => undefined, querySelector: () => null,
    querySelectorAll: () => [], removeEventListener: () => undefined,
  };
  return () => { globals.document = previous; };
}

function stubShell(): () => void {
  const globals = globalThis as unknown as { window?: unknown };
  const previous = globals.window;
  globals.window = {
    sdShell: {
      exportFile: {
        saveDialog: async () => ({ canceled: false, token: "token-A" }),
        write: async () => ({ ok: true }),
        showInFolder: async () => ({ ok: true }),
        downloadsDir: async () => "C:\\Users\\me\\Downloads",
      },
      exportHistory: { list: async () => [], reveal: async () => ({ missing: false, ok: true }), forget: async () => ({ ok: true }) },
    },
  };
  return () => { globals.window = previous; };
}

const task = { filename: "pkg.sdresearch", id: "task-1", status: "queued" };

/** Answers the dialog's reads, and records the export request's body. */
function client(bodies: Array<Record<string, unknown>>) {
  return {
    request: async (path: string, init?: { body?: unknown }) => {
      if (path.startsWith("/api/sessions/")) return { id: path.split("/")[3]!, messages: [], title: "session" };
      // Over the configured cap, under the ceiling an acknowledgement may use.
      if (path.includes("/preview")) return {
        estimatedBytes: CAP + 1, archiveBytes: CAP + 1, maxBytes: CAP, files: [], omissions: [], revision: "r1",
      };
      if (path.endsWith("/exports")) { bodies.push(JSON.parse(String(init?.body ?? "{}"))); return task; }
      if (path.includes("/exports/")) return { ...task, status: "queued" };
      return {};
    },
    fetchStream: async () => ({ blob: async () => new Blob([new Uint8Array([1, 2, 3])]) }),
  } as never;
}

test("the acknowledged over-cap export carries allowOverCap to the server", async (context) => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const restoreDocument = stubDocument();
  const restoreShell = stubShell();
  const bodies: Array<Record<string, unknown>> = [];
  let view!: ReturnType<typeof create>;
  try {
    await act(async () => {
      view = create(React.createElement(ResearchPackage, {
        onOpen: () => undefined, onRefresh: async () => undefined, projects: [],
        client: client(bodies), request: { kind: "export", projectId: "p1", sessionId: "s1" },
      }));
    });
    await act(async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); });

    const buttons = () => view.root.findAllByType("button");
    const acknowledge = buttons().find((button) => button.props.children === t.exportAnyway);
    assert.ok(acknowledge, "the over-cap state offers 仍要导出");
    // The gate itself, read before the confirmation: this is the half that a footer
    // edit dropping lockedByLimit would break while the body assertion stayed green.
    const gated = buttons().find((button) => button.props.className === "primary-button");
    assert.ok(gated, "the dialog offers the export action");
    assert.equal(gated!.props.disabled, true, "the unconfirmed over-cap export is disabled");
    assert.equal(bodies.length, 0, "no export request while the warning is unconfirmed");

    await act(async () => { acknowledge!.props.onClick(); });
    await act(async () => { for (let tick = 0; tick < 8; tick += 1) await Promise.resolve(); });

    const start = buttons().find((button) => button.props.className === "primary-button");
    assert.ok(start, "the dialog offers the export action once confirmed");
    assert.equal(start!.props.disabled, false, "the confirmation unblocks the action");
    await act(async () => { start!.props.onClick(); });
    await act(async () => { for (let tick = 0; tick < 12; tick += 1) await Promise.resolve(); });

    assert.equal(bodies.length, 1, "one export request was sent");
    assert.equal(bodies[0]!.allowOverCap, true, "the acknowledgement travels with the request");
  } finally {
    act(() => { view.unmount(); });
    restoreShell();
    restoreDocument();
    context.mock.timers.reset();
  }
});
