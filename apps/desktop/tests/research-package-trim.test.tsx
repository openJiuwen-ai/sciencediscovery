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
import { ResearchPackage, copyStatusLine, taskErrorMessage } from "../src/views/ResearchPackage.js";
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

    // Skip the select-all box: this case is about ticking one workspace file.
    const grid = view.root.findAllByProps({ className: "research-file-grid" })[0]!;
    const box = grid.findAllByProps({ type: "checkbox" })[0]!;
    // A synchronous act stops after the state update: this is the moment the user
    // sees, while the new estimate is still in flight.
    act(() => {
      (box.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    });
    const markup = rendered(view);
    assert.equal(listsBothFiles(), true, "the file list survives the selection change");
    assert.ok(markup.includes("100.0 KB"), "the last known estimate stays visible on the scope card");
    assert.ok(markup.includes(t.recalculating), "the size line says it is recalculating");
    assert.equal(markup.includes(t.calculating), false, "the dialog is not replaced by the calculating state");
    // A // line inside the fragment's children is text, not a comment: it renders
    // into the session view where the removed entry point used to be, so the render
    // must not contain it (#1057).
    assert.equal(markup.includes("A ready copy is reached through"), false,
      "no explanation comment leaks into the rendered view");
    await act(async () => { await Promise.resolve(); });
    const settled = rendered(view);
    assert.equal(settled.includes(t.recalculating), false, "the estimate settles and the recalculating marker goes");
    assert.ok(settled.includes("100.0 KB"), "the settled size is still shown");
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
    // Skip the select-all box: this case is about ticking one workspace file.
    const grid = view.root.findAllByProps({ className: "research-file-grid" })[0]!;
    const box = grid.findAllByProps({ type: "checkbox" })[0]!;
    await act(async () => {
      (box.props.onChange as (event: unknown) => void)({ target: { checked: false } });
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.omissionsSummary(1)), "one sentence naming how many files are left out");
    assert.equal(markup.includes("INTERNAL-PACKAGING-TEXT"), false, "no internal packaging text in the default view");
  });
});

test("the import review shows the source, the object count and the record bytes", async (context) => {
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
    // #1024 AC5: the dialog used to print `(size / 1024).toFixed(1) KiB` for a
    // four-byte file, and the manifest's omissions never reached the screen.
    assert.ok(markup.includes("4 B"), "the chosen file's size is formatted by magnitude, not as KiB");
    assert.ok(markup.includes(t.recordsBytes), "the record byte count is labelled");
    assert.ok(markup.includes("2.0 KB"), "2048 records bytes read as 2.0 KB");
    assert.ok(markup.includes("pkg"), "the package's source title is shown");
    // The preview is one meta line now: source title · objects · record bytes. The
    // package's omissions are no longer rendered here, so this case must not keep
    // asserting a scroll region that the dialog deliberately dropped.
    assert.equal(markup.includes("IMPORT-OMISSION-TEXT"), false, "no omission list in the compact preview");
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

test("the complete export asks the preview for the memory graph switch", async (context) => {
  // The switch used to be pure component state: the preview never saw it, so the
  // estimate and the cap described a package without the memory graph. The complete
  // profile now offers only that switch, so this case pins it to the preview query
  // (#1235 review 2, still standing after the trajectory switch was removed).
  const calls: Array<{ path: string; init?: { body?: unknown; method?: string } }> = [];
  const inner = client();
  const tracking = {
    ...inner,
    request: async (target: string, init?: { body?: unknown; method?: string }) => {
      calls.push({ path: target, init });
      return (inner.request as (path: string, init?: unknown) => Promise<unknown>)(target, init);
    },
  };
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: tracking as never,
    request: { kind: "export", projectId: "p1", sessionId: "s1" },
  }), async (view) => {
    // The unselected card is the complete profile.
    const cards = view.root.findAllByProps({ "aria-pressed": false });
    assert.ok(cards.length > 0, "the complete card is rendered");
    await act(async () => { (cards[0]!.props.onClick as () => void)(); await Promise.resolve(); });

    // The payload switch lives in its own block; picking it from there keeps the
    // select-all and file checkboxes below out of this case.
    const options = view.root.findAllByProps({ className: "research-package-options" })[0]!;
    const switches = options.findAllByProps({ type: "checkbox" });
    assert.equal(switches.length, 1, "the complete profile offers the memory-graph switch");
    await act(async () => {
      (switches[0]!.props.onChange as (event: unknown) => void)({ target: { checked: true } });
      await Promise.resolve();
    });

    const previewQueries = calls.filter((call) => call.path.includes("/preview")).map((call) => call.path);
    assert.ok(previewQueries.some((query) => /includeFullMemoryGraph=1/.test(query)),
      `the preview must be asked for the memory graph: ${JSON.stringify(previewQueries.slice(-2))}`);
  });
});


test("unticking a workspace file moves the selection's own size line", async (context) => {
  // The card shows the whole profile, the line under it shows the selection; the
  // review asked for a case that can tell them apart (#1235 review 2, F8).
  const previewFor = (paths: string[]): PreviewBody => ({
    estimatedBytes: paths.length === 0 ? 300 * 1024 : 100 * 1024,
    files: [{ path: "a.csv", selected: true, size: 10 }, { path: "b.csv", selected: true, size: 20 }],
    omissions: [],
    revision: "r1",
  });
  const inner = client();
  const perSelection = {
    ...inner,
    request: async (target: string, init?: unknown) => {
      if (target.includes("/preview")) {
        const query = new URLSearchParams(target.slice(target.indexOf("?") + 1));
        return previewFor(query.getAll("filePath"));
      }
      return (inner.request as (path: string, init?: unknown) => Promise<unknown>)(target, init);
    },
  };
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: perSelection as never,
    request: { kind: "export", projectId: "p1", sessionId: "s1" },
  }), async (view) => {
    const before = rendered(view);
    assert.ok(before.includes(t.estimateUncompressed), "the number is labelled as an uncompressed estimate");
    assert.ok(before.includes("300.0 KB"), "the whole-selection estimate is shown");

    const grid = view.root.findAllByProps({ className: "research-file-grid" })[0]!;
    const box = grid.findAllByProps({ type: "checkbox" })[0]!;
    await act(async () => {
      (box.props.onChange as (event: unknown) => void)({ target: { checked: false } });
      await Promise.resolve();
    });
    const settled = rendered(view);
    assert.ok(settled.includes("100.0 KB"), "the line follows the new selection, not the profile card");
    assert.ok(settled.includes(t.estimateUncompressed), "the label keeps its qualifier");
  });
});

test("reopening the export dialog starts a fresh pending budget", async (context) => {
  // A stalled preview used to greet the reopened dialog as already exhausted
  // (#1235 review 2, F11).
  const pendingClient = {
    request: async (target: string) => {
      if (target.startsWith("/api/sessions/")) return { id: "s1", messages: [], title: "Session" };
      if (target.includes("/preview")) {
        const error = new Error("still computing") as Error & { code?: string };
        error.code = "EXPORT_PREVIEW_PENDING";
        throw error;
      }
      return {};
    },
  } as never;
  function Harness() {
    const [request, setRequest] = React.useState<unknown>({ kind: "export", projectId: "p1", sessionId: "s1" });
    return React.createElement(React.Fragment, null,
      React.createElement(ResearchPackage, { ...props, client: pendingClient, request: request as never }),
      React.createElement("button", {
        id: "reopen",
        onClick: () => setRequest({ kind: "export", projectId: "p1", sessionId: "s1" }),
        type: "button",
      }, "reopen"));
  }
  await withView(context, React.createElement(Harness), async (view) => {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      await act(async () => { context.mock.timers.tick(1_500); await Promise.resolve(); });
    }
    assert.ok(rendered(view).includes(t.pendingLong), "the first open runs out its budget");

    const reopen = view.root.findAllByProps({ id: "reopen" })[0]!;
    await act(async () => { (reopen.props.onClick as () => void)(); await Promise.resolve(); });
    assert.equal(rendered(view).includes(t.pendingLong), false, "the reopened dialog waits afresh");
  });
});

test("a localized poll answer reaches the alert instead of the details block", () => {
  // The poll settles a deleted task and the retry limit with these sentences; they
  // used to fall through to the generic failure and appear as technical detail
  // (#1235 review 2, F9).
  assert.equal(taskErrorMessage(t.exportMissing), t.exportMissing);
  assert.equal(taskErrorMessage(t.exportPollingFailed), t.exportPollingFailed);
  assert.equal(taskErrorMessage("Export task not found"), t.taskMissing);
  assert.equal(taskErrorMessage("socket hang up"), undefined,
    "an unrecognized server text stays in the details block");
});

test("a new export request starts with the payload switches off", async (context) => {
  // The component stays mounted across opens (App renders it unconditionally), so a
  // switch ticked for one package used to come back ticked for the next (#1235
  // review 3). Only the profile card cleared it, and only when leaving 完整导出.
  function Harness() {
    const [request, setRequest] = React.useState<unknown>({ kind: "export", projectId: "p1", sessionId: "s1" });
    return React.createElement(React.Fragment, null,
      React.createElement(ResearchPackage, { ...props, client: client(), request: request as never }),
      React.createElement("button", {
        id: "reopen",
        onClick: () => setRequest({ kind: "export", projectId: "p1", sessionId: "s1" }),
        type: "button",
      }, "reopen"));
  }
  const options = (view: ReturnType<typeof create>) => view.root.findAllByProps({ className: "research-package-options" })[0];
  await withView(context, React.createElement(Harness), async (view) => {
    // Open the complete profile, then tick the payload switch.
    await act(async () => { (view.root.findAllByProps({ "aria-pressed": false })[0]!.props.onClick as () => void)(); await Promise.resolve(); });
    const ticked = options(view)!.findAllByProps({ type: "checkbox" })[0]!;
    await act(async () => {
      (ticked.props.onChange as (event: unknown) => void)({ target: { checked: true } });
      await Promise.resolve();
    });
    assert.equal(options(view)!.findAllByProps({ type: "checkbox" })[0]!.props.checked, true, "the memory-graph switch is on before reopening");

    const reopen = view.root.findAllByProps({ id: "reopen" })[0]!;
    await act(async () => { (reopen.props.onClick as () => void)(); await Promise.resolve(); });
    await act(async () => { await Promise.resolve(); });
    assert.equal(options(view), undefined, "the reopened dialog starts on 必要导出, where the switches are hidden");

    await act(async () => { (view.root.findAllByProps({ "aria-pressed": false })[0]!.props.onClick as () => void)(); await Promise.resolve(); });
    assert.equal(options(view)!.findAllByProps({ type: "checkbox" })[0]!.props.checked, false,
      "choosing complete again shows the memory-graph switch off");
  });
});
