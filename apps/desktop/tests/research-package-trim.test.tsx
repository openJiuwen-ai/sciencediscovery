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
    // #1024 (reopened): the compact preview carries the package's own omissions
    // under the meta line. One entry counts as one, and the rows sit behind a
    // collapsed disclosure: the count is what a reader needs at a glance.
    const disclosure = view.root.findAll((node) => node.type === "details"
      && String(node.props.className ?? "").includes("research-import-omissions"))[0]!;
    assert.ok(disclosure, "the rows live in a disclosure");
    assert.equal(disclosure.props.open, undefined, "the rows start collapsed");
    assert.equal(disclosure.findAll((node) => node.type === "summary").length, 1, "the count is the disclosure's summary");
    assert.ok(markup.includes(t.importOmissions(1)), "the omissions line counts the manifest's own entries");
    assert.ok(markup.includes("IMPORT-OMISSION-TEXT"), "an entry this build does not know is shown as written");
  });
});

test("every manifest entry is listed, each in readable form, and the count is the full array", async (context) => {
  // #1024 review F1: the count must be the manifest's own length and no entry may
  // be dropped. Reference-shaped rows are rendered as `工作区文件 · path · 读不出`
  // instead of a raw token, but they still count and still appear.
  const memory = "科学记忆以摘要形式保留；完整科学记忆节点和关系未包含在本包中。";
  const scoped = "导出范围省略工作区文件：3。";
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: {
          omissions: [
            memory,
            "workspace:s1:results/trial-3.csv:unreadable",
            "cas:abc123:unavailable source object",
            scoped,
            "artifact:artifact-7:source session is unavailable",
          ],
          source: { title: "pkg" },
        },
        objectCount: 2,
        packageChecksum: "c3",
        recordsBytes: 10,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "mixed.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.importOmissions(5)), "the count is the whole manifest array, not a filtered subset");
    // Owner decision: text that came in the package is shown as the package wrote it.
    assert.ok(markup.includes(memory), "a sentence the package wrote is shown verbatim");
    assert.ok(markup.includes(scoped), "including the scope sentence, with its own count");
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 5, "one row per manifest entry");
    const labels = rows.map((row) => String(row.props.children));
    assert.ok(labels.some((label) => label.includes(t.omissionText.family.workspace) && label.includes("results/trial-3.csv")
      && label.includes("unreadable")), `the workspace row names its file, and keeps the package's reason: ${JSON.stringify(labels)}`);
    assert.ok(labels.some((label) => label.includes(t.omissionText.family.cas) && label.includes("abc123")), "the CAS row keeps its id");
    assert.ok(labels.some((label) => label.includes(t.omissionText.family.artifact)), "the artifact row is listed too");
    for (const raw of ["workspace:s1:", "cas:abc123", "artifact:artifact-7"]) {
      assert.equal(markup.includes(raw), false, `no raw token leaks into the dialog: ${raw}`);
    }
    // A reference row explains itself on hover; a sentence does not need to.
    const workspaceRow = rows[labels.findIndex((label) => label.includes("results/trial-3.csv"))]!;
    assert.equal(workspaceRow.props.title, t.omissionText.hint.workspace);
  });
});

test("a manifest made only of reference rows still reports a count", async (context) => {
  // The case the review called out: filtering every `<token>:<id>:` row would
  // print `Not included: 0 items` for a package that is missing a file, an
  // artifact and a package object — telling the reader it is complete.
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: {
          omissions: [
            "workspace:s1:results/trial-3.csv:unreadable",
            "artifact:artifact-7:source session is unavailable",
            "cas:abc123:unavailable source object",
          ],
          source: { title: "pkg" },
        },
        objectCount: 1,
        packageChecksum: "c4",
        recordsBytes: 1,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "refs.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.importOmissions(3)), "three reference rows are still three omissions");
    assert.equal(markup.includes(t.importOmissions(0)), false, "the card must not claim the package is complete");
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 3, "all three rows are rendered");
  });
});

test("a non-string omission is shown, counted, and does not break the dialog", async (context) => {
  // `manifest.omissions` is only checked with `Array.isArray` when the package is
  // parsed, so a crafted package can carry objects or numbers here. The card must
  // render, count them, and show what it received.
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: { omissions: [{ x: 1 }, 123, JSON.parse('{"toString":null}')], source: { title: "pkg" } },
        objectCount: 0,
        packageChecksum: "c5",
        recordsBytes: 0,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "odd.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.importOmissions(3)), "the count includes the non-string entries");
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 3, "every entry is rendered instead of throwing");
    assert.ok(String(rows[0]!.props.children).includes('{"x":1}'), "an object entry is shown as its JSON");
    assert.ok(String(rows[1]!.props.children).includes("123"), "a number entry is shown as text");
    assert.equal(rows[0]!.props.title, t.omissionText.hint.unparsed, "it is marked as unparsed on hover");
    // `{"toString": null}` has no usable `String()`: building the row key from the
    // entry threw `TypeError: Cannot convert object to primitive value` and the
    // dialog never rendered, so this case pins the guarded path.
    assert.equal(String(rows[2]!.props.children).includes("not readable text")
      || String(rows[2]!.props.children).includes("不是可读文本"), true,
      `the crafted object still renders as text: ${String(rows[2]!.props.children)}`);
  });
});

test("a reference row keeps its file and its whole reason when the reason has colons", async (context) => {
  // The writers put `error.message` in the last field, and a filesystem error is
  // `ENOENT: no such file or directory, open '…'`. Splitting on every colon kept
  // `ENOENT` as the reason and dropped the path, so the dialog named neither the
  // file nor what happened to it (#1024 review of 0acbc7a).
  const enoent = "workspace:s1:results/trial-3.csv:ENOENT: no such file or directory, open '/data/trial-3.csv'";
  const artifactError = "artifact:artifact-7:Error: read failed";
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: { omissions: [enoent, artifactError], source: { title: "pkg" } },
        objectCount: 1,
        packageChecksum: "c6",
        recordsBytes: 1,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "colons.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rendered(view).includes(t.importOmissions(2)), true, "the count still covers both entries");
    assert.equal(rows.length, 2, "both entries are rows");
    const workspace = String(rows[0]!.props.children);
    assert.ok(workspace.includes(t.omissionText.family.workspace), `the workspace row names its family: ${workspace}`);
    assert.ok(workspace.includes("results/trial-3.csv"), `the workspace row keeps the path: ${workspace}`);
    assert.ok(workspace.includes("ENOENT: no such file or directory"), `the workspace row keeps the whole reason: ${workspace}`);
    const artifact = String(rows[1]!.props.children);
    assert.ok(artifact.includes(t.omissionText.family.artifact), `the artifact row names its family: ${artifact}`);
    assert.ok(artifact.includes("artifact-7"), `the artifact row keeps its id: ${artifact}`);
    assert.ok(artifact.includes("Error: read failed"), `the artifact row keeps the whole reason: ${artifact}`);
  });
});

test("evolve rows keep the run, the candidate hash and the message", async (context) => {
  // A candidate hash is `sha256:<64 hex>` (evolution/candidates.ts), so a real row
  // carries four fields after the token. Reading `fields[0]:fields[1]` as the hash
  // produced `run-1:sha256` and pushed the digest into the reason, where the
  // `missing` mapping then hid it. The three-part short-hash shape and the
  // message-only shape have to keep working too.
  const digest = "a".repeat(64);
  const withCandidate = `evolve:run-1:sha256:${digest}:missing candidate source object`;
  const withShortHash = "evolve:run-9:abc123:missing candidate source object";
  const messageOnly = "evolve:package carries an evolve record that is not a run list";
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: { omissions: [withCandidate, withShortHash, messageOnly], source: { title: "pkg" } },
        objectCount: 1,
        packageChecksum: "c7",
        recordsBytes: 1,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "evolve.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 3, "all three evolve entries are rows");

    const candidate = String(rows[0]!.props.children);
    assert.ok(candidate.includes("run-1"), `the row keeps the run: ${candidate}`);
    assert.ok(candidate.includes(digest), `the row keeps the whole digest: ${candidate}`);
    assert.ok(candidate.includes("sha256"), `the digest stays marked as sha256: ${candidate}`);
    assert.ok(candidate.includes("missing candidate source object"), `the row keeps its reason: ${candidate}`);

    const short = String(rows[1]!.props.children);
    assert.ok(short.includes("run-9") && short.includes("abc123"),
      `the three-part shape keeps the run and the short hash: ${short}`);
    assert.ok(short.includes("missing candidate source object"), `and its reason: ${short}`);

    const message = String(rows[2]!.props.children);
    assert.ok(message.includes(t.omissionText.family.evolve), `the message row names its family: ${message}`);
    assert.ok(message.includes("package carries an evolve record"),
      `a message-only row keeps the package's own text: ${message}`);
  });
});
test("package-written reasons stay in the package's language, not the dialog's", async (context) => {
  // Owner decision (2026-11-21): text that came in the package is shown as the
  // package wrote it; only the dialog's own words follow the interface language.
  // So these three sentences stay English in the zh dialog, on purpose.
  const evidence = "artifact:artifact-7:validation evidence version 4 is unavailable";
  const inputVersion = "artifact:artifact-9:input version rev-abc is unavailable";
  const truncated = "trajectory:sess-1:5 more entries could not be read; the entries listed above are only the first few.";
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: { omissions: [evidence, inputVersion, truncated], source: { title: "pkg" } },
        objectCount: 1,
        packageChecksum: "c8",
        recordsBytes: 1,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "reasons.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 3, "all three entries are rows");

    const evidenceRow = String(rows[0]!.props.children);
    assert.ok(evidenceRow.includes(t.omissionText.family.artifact), `the family name is the dialog's: ${evidenceRow}`);
    assert.ok(evidenceRow.includes("artifact-7"), `the package's id is kept: ${evidenceRow}`);
    assert.ok(evidenceRow.includes("validation evidence version 4 is unavailable"),
      `the package's reason is kept verbatim: ${evidenceRow}`);

    const inputRow = String(rows[1]!.props.children);
    assert.ok(inputRow.includes("input version rev-abc is unavailable"),
      `this reason is kept verbatim too: ${inputRow}`);

    const truncatedRow = String(rows[2]!.props.children);
    assert.ok(truncatedRow.includes("5 more entries could not be read"),
      `the truncated-trajectory reason is kept verbatim: ${truncatedRow}`);

    assert.equal(rendered(view).includes("校验证据版本"), false,
      "no dialog-side translation of package text");
  });
});
test("a nested entry that defeats both conversions still renders", async (context) => {
  // `JSON.stringify` raises RangeError on a deeply nested object, and `String()`
  // raises TypeError when `toString` is not callable, so a crafted entry can
  // defeat both. The dialog must fall back to its own placeholder (#1024 review
  // of e29bd64).
  const deep: Record<string, unknown> = { toString: null };
  let nested: unknown[] = [];
  deep.x = nested;
  for (let level = 0; level < 5000; level += 1) {
    const next: unknown[] = [];
    nested.push(next);
    nested = next;
  }
  let stringifyThrew = false;
  try {
    JSON.stringify(deep);
  } catch {
    stringifyThrew = true;
  }
  assert.equal(stringifyThrew, true, "this fixture must defeat JSON.stringify");
  let stringThrew = false;
  try {
    String(deep);
  } catch {
    stringThrew = true;
  }
  assert.equal(stringThrew, true, "and it must defeat String() too");

  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: { omissions: [deep], source: { title: "pkg" } },
        objectCount: 0,
        packageChecksum: "c9",
        recordsBytes: 0,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "deep.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.importOmissions(1)), "the entry is still counted");
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 1, "the dialog renders instead of throwing");
    assert.ok(String(rows[0]!.props.children).includes(t.omissionText.unrepresentable),
      `the row carries the dialog's placeholder: ${String(rows[0]!.props.children)}`);
  });
});

test("an unknown family token prints as written, inherited keys included", async (context) => {
  // `FAMILY` used to be a plain object, so `FAMILY["constructor"]` returned the
  // inherited constructor and `constructor:abc:def` rendered as an invented
  // reference (`abc · def`) instead of the raw line (#1024 review of 2cb2f66).
  const unknown = "constructor:abc:def";
  const alsoUnknown = "toString:x";
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: {
        manifest: { omissions: [unknown, alsoUnknown], source: { title: "pkg" } },
        objectCount: 0,
        packageChecksum: "c10",
        recordsBytes: 0,
      },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "unknown.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const rows = view.root.findAllByProps({ className: "research-import-omissions-list" })[0]!.findAll((node) => node.type === "li");
    assert.equal(rows.length, 2, "both entries are rows");
    assert.equal(String(rows[0]!.props.children), unknown, "the constructor token is shown as written");
    assert.equal(String(rows[1]!.props.children), alsoUnknown, "and so is the toString token");
    for (const label of Object.values(t.omissionText.family)) {
      assert.equal(String(rows[0]!.props.children).includes(label), false,
        `no family label is invented for an unknown token: ${label}`);
    }
  });
});

test("a package whose manifest omits nothing says so and renders no list", async (context) => {
  // The zero case is the other half of #1024: the line still states the count,
  // and no list element is invented for an empty array.
  await withView(context, React.createElement(ResearchPackage, {
    ...props,
    client: client({
      inspection: { manifest: { omissions: [], source: { title: "pkg" } }, objectCount: 0, packageChecksum: "c2", recordsBytes: 0 },
    }),
    request: { kind: "import", projectId: "p1" },
  }), async (view) => {
    const input = view.root.findAllByProps({ type: "file" })[0]!;
    const chosen = new File([new Uint8Array([1, 2, 3, 4])], "empty.sdresearch");
    await act(async () => {
      (input.props.onChange as (event: unknown) => void)({ target: { files: [chosen] } });
      await Promise.resolve();
    });
    const markup = rendered(view);
    assert.ok(markup.includes(t.importOmissions(0)), "the line states that nothing was left out");
    assert.equal(view.root.findAllByProps({ className: "research-import-omissions-list" }).length, 0,
      "no list is drawn for an empty manifest array");
    // Nothing to expand, so the line is not a disclosure at all.
    assert.equal(view.root.findAll((node) => node.type === "details").length, 0,
      "an empty omissions array draws no collapsible block");
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
