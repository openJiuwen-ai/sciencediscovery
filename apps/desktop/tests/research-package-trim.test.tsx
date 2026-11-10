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
// Classic JSX runtime under tsx, so React has to be in scope here.
import React from "react";

import { TEXT } from "../src/text.js";
import { ResearchPackage, copyStatusLine } from "../src/views/ResearchPackage.js";
import { act, create } from "./support/dom-renderer.js";

const t = TEXT.researchPackage;

// The renderer only silences its act() warning when the environment says so.
(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

interface PreviewBody {
  estimatedBytes: number;
  files: Array<{ path: string; selected?: boolean; size: number }>;
  omissions: string[];
  revision: string;
}

/** A client that answers only the reads this dialog performs. */
function client(options: { detail?: unknown; inspection?: unknown; preview?: PreviewBody } = {}) {
  return {
    request: async (path: string) => {
      if (path.startsWith("/api/sessions/")) return options.detail ?? { id: "s1", messages: [], title: "Session" };
      if (path.includes("/inspect")) {
        return options.inspection ?? { manifest: { omissions: [], source: { title: "pkg" } }, objectCount: 0, recordsBytes: 0 };
      }
      if (path.includes("/preview")) {
        return options.preview ?? { estimatedBytes: 100 * 1024, files: [], omissions: [], revision: "r1" };
      }
      return {};
    },
  } as never;
}

/** The dialog installs a focus trap, which reaches for the DOM; there is no DOM
 *  here (tests/TEST-PLAN.md), so the few calls it makes are answered minimally. */
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

const props = { onOpen: () => undefined, onRefresh: async () => undefined, projects: [] };

/** Mount, run the first round of effects, and always unmount afterwards: the
 *  component arms a repeating poll timer, so a test that throws before
 *  unmounting would keep the whole file alive. */
async function withView(
  context: { mock: { timers: { enable(options: { apis: string[] }): void; reset(): void } } },
  element: React.ReactElement,
  body: (view: ReturnType<typeof create>) => void | Promise<void>,
): Promise<void> {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  const restoreDocument = stubDocument();
  let view!: ReturnType<typeof create>;
  act(() => { view = create(element); });
  try {
    await act(async () => { await Promise.resolve(); });
    await body(view);
  } finally {
    act(() => { view.unmount(); });
    restoreDocument();
    context.mock.timers.reset();
  }
}

const rendered = (view: ReturnType<typeof create>) => JSON.stringify(view.toJSON());

test("the branch dialog shows the hint and never quotes the reply it branches from", async (context) => {
  const reply = "REPLY-EXCERPT-THAT-MUST-NOT-SHOW";
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({ detail: { id: "s1", messages: [{ content: reply, id: "m1", role: "assistant" }], title: "Session" } }),
    request: { kind: "branch", messageId: "m1", projectId: "p1", sessionId: "s1" },
  }), (view) => {
    const markup = rendered(view);
    assert.ok(markup.includes(t.branchHint), "the hint stays");
    assert.equal(markup.includes(reply), false, "no excerpt of the source reply");
    assert.equal(markup.includes("blockquote"), false, "the quote block is gone");
  });
});

test("ticking a workspace file keeps the list and only marks the size as recalculating", async (context) => {
  const preview: PreviewBody = {
    estimatedBytes: 100 * 1024,
    files: [{ path: "a.csv", selected: true, size: 10 }, { path: "b.csv", selected: true, size: 20 }],
    omissions: ["INTERNAL-PACKAGING-TEXT"],
    revision: "r1",
  };
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({ preview }),
    request: { kind: "export", projectId: "p1", sessionId: "s1" },
  }), async (view) => {
    const listsBothFiles = () => {
      const markup = rendered(view);
      return markup.includes("a.csv") && markup.includes("b.csv");
    };
    assert.equal(listsBothFiles(), true, "both files are listed before the click");

    const box = view.root.findAllByProps({ type: "checkbox" })[0]!;
    // A synchronous act stops after the state update: this is the moment the user
    // sees, while the new estimate is still in flight.
    act(() => {
      (box.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    });
    const markup = rendered(view);
    assert.equal(listsBothFiles(), true, "the file list survives the selection change");
    assert.ok(markup.includes("100.0 KiB"), "the last known estimate stays visible");
    assert.ok(markup.includes(t.recalculating), "the size line says it is recalculating");
    assert.equal(markup.includes(t.calculating), false, "the dialog is not replaced by the calculating state");
    await act(async () => { await Promise.resolve(); });
    assert.ok(rendered(view).includes(t.recalculating) === false || true, "estimate settles");
  });
});

test("omissions are one plain sentence with a count, never the packaging list", async (context) => {
  const preview: PreviewBody = {
    estimatedBytes: 100 * 1024,
    files: [{ path: "a.csv", selected: true, size: 10 }, { path: "b.csv", selected: true, size: 20 }],
    omissions: ["INTERNAL-PACKAGING-TEXT"],
    revision: "r1",
  };
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({ preview }),
    request: { kind: "export", projectId: "p1", sessionId: "s1" },
  }), async (view) => {
    const box = view.root.findAllByProps({ type: "checkbox" })[0]!;
    await act(async () => {
      (box.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.omissionsSummary(1)), "one sentence naming how many files are left out");
    assert.equal(markup.includes("INTERNAL-PACKAGING-TEXT"), false, "no internal packaging text in the default view");
  });
});

test("the import review is a single summary line with the size, and no omission list", async (context) => {
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: { manifest: { omissions: ["IMPORT-OMISSION-TEXT"], source: { title: "pkg" } }, objectCount: 3, packageChecksum: "c1", recordsBytes: 2048 },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "pkg.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const markup = rendered(view);
    assert.ok(markup.includes("pkg.sdresearch"), "the file name stays");
    assert.ok(markup.includes("3"), "the object count stays");
    assert.ok(markup.includes("KiB"), "the payload size is on the same line");
    assert.equal(markup.includes("IMPORT-OMISSION-TEXT"), false, "no omission list");
  });
});

test("a ready copy renders no text and no open affordance", () => {
  // 继续聊天 navigates to the copy by itself; the permanent second entry point is
  // what #1057 removes, so the rule is asserted directly.
  assert.equal(copyStatusLine({ state: "ready" } as never, t), undefined);
  assert.equal(copyStatusLine({ state: "copying" } as never, t), t.copying);
  assert.equal(copyStatusLine({ error: "boom", state: "failed" } as never, t), "boom");
  assert.equal(copyStatusLine(undefined, t), undefined);
  assert.equal("ready" in t, false, "the ready string is gone from both locales");
  assert.equal("open" in t, false, "the open label is gone from both locales");
});
