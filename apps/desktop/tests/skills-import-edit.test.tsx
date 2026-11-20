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

import React from "react";
import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiRequestError, type ApiClient } from "../src/api/client.js";
import type { ConfirmRequest } from "../src/app/use-workspace.js";
import type {
  GitSkillRepositoryInspection,
  SkillDescriptor,
  SkillDetail,
} from "../src/api/types.js";
import { SkillEditorView } from "../src/views/settings/SkillEditorView.js";
import { SkillGitImportView } from "../src/views/settings/SkillGitImportView.js";
import { SkillUploadView } from "../src/views/settings/SkillUploadView.js";
import { SkillsSettings } from "../src/views/settings/SkillsSettings.js";
import { TEXT } from "../src/text.js";
import { json, type RecordedCall, StubClient } from "./api-stub.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

const skill: SkillDescriptor = {
  id: "review", name: "review", description: "Review a draft", source: "managed",
  currentRevision: 1, diagnostics: [], hash: "hash", readOnly: false, version: "revision:1",
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
};
const detail: SkillDetail = {
  ...skill,
  frontmatter: {
    "allowed-tools": "Bash",
    compatibility: "python 3.11",
    license: "MIT",
    metadata: { owner: "sd" },
  },
  instructions: "Review carefully",
  resources: [],
};

// The modals listen on `document`, which these component-state checks do not
// have a real one of.
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
  addEventListener() {}, removeEventListener() {},
} });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

/** Resolve the promises an effect started and re-render what they set. */
async function settle(): Promise<void> {
  await act(async () => { await Promise.resolve(); });
}

async function mount(node: React.ReactElement): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(node); });
  assert.ok(view);
  return view;
}

function buttonWithText(view: ReactTestRenderer, label: string) {
  const found = view.root.findAllByType("button").find((node) => (
    Array.isArray(node.children) ? node.children.includes(label) : node.children === label
  ));
  assert.ok(found, `no button reading "${label}"`);
  return found;
}

/** The `index`th request the stub recorded, after asserting it was made. */
function requestAt(stub: StubClient, index: number): RecordedCall {
  const call = stub.calls[index];
  assert.ok(call, `request ${index} was not made`);
  return call;
}

/** Press 添加技能, then the entry whose bold line is `label`. */
async function openAddView(view: ReactTestRenderer, label: string): Promise<void> {
  await act(async () => {
    const trigger = view.root.findAllByType("button")
      .find((node) => node.props.className?.includes?.("skill-add-trigger"));
    assert.ok(trigger, "the list has no 添加技能");
    trigger.props.onClick();
  });
  await act(async () => {
    const item = view.root.findAllByType("button").find((node) => node
      .findAllByType("strong")
      .some((heading) => heading.children.includes(label)));
    assert.ok(item, `添加技能 does not offer ${label}`);
    item.props.onClick();
  });
}

function textareaWithLabel(view: ReactTestRenderer, label: string) {
  const found = view.root.findAllByType("textarea").find((node) => node.props["aria-label"] === label);
  assert.ok(found, `no textarea labelled "${label}"`);
  return found;
}

test("one SKILL.md goes up as the multipart field the route reads", async () => {
  const stub = new StubClient().reply(detail);
  const imported: SkillDetail[] = [];
  const view = await mount(
    <SkillUploadView
      client={stub.asClient()}
      onImported={(row) => { imported.push(row); }}
      onWriteInstead={() => {}}
    />,
  );
  try {
    const file = new File(["# review"], "SKILL.md", { type: "text/markdown" });
    const input = view.root.findAllByType("input").find((node) => node.props.type === "file");
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { files: [file] } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.importAction).props.onClick(); });

    const call = stub.calls[0];
    assert.equal(call?.path, "/api/skills/import?onDuplicate=rename");
    assert.equal(call?.init.method, "POST");
    const form = call?.init.body;
    assert.ok(form instanceof FormData);
    assert.equal((form.get("file") as File).name, "SKILL.md");
    assert.deepEqual(imported.map((row) => row.id), ["review"]);
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.importSucceeded("review")));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a Git inspection pins the commit and never overwrites without the revision the user saw", async () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const inspection: GitSkillRepositoryInspection = {
    commit,
    repositoryUrl: "https://example.invalid/org/skills.git",
    candidates: [
      { description: "A fresh skill", diagnostics: [], name: "fresh", status: "new", subdirectory: "skills/fresh" },
      { currentRevision: 3, diagnostics: [], name: "review", status: "update", subdirectory: "skills/review" },
      { diagnostics: [], name: "same", status: "unchanged", subdirectory: "skills/same" },
    ],
  };
  const stub = new StubClient().reply(inspection);
  const started: unknown[] = [];
  let done = 0;
  const view = await mount(
    <SkillGitImportView
      client={stub.asClient()}
      onDone={() => { done += 1; }}
      onStart={async (request) => { started.push(request); }}
    />,
  );
  try {
    const url = view.root.findAllByType("input").find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(url);
    await act(async () => { url.props.onChange({ target: { value: inspection.repositoryUrl } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });

    assert.equal(stub.calls[0]?.path, "/api/skills/import-git/inspect");
    assert.ok(JSON.stringify(view.toJSON()).includes("A fresh skill"));
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.git.commit(commit)));
    // The select-all control, then the rows: the unchanged package is offered
    // but cannot be chosen, because there is nothing to write and writing it
    // would be a revision for a no-op.
    const checkboxes = view.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    assert.deepEqual(checkboxes.map((node) => node.props.disabled), [false, false, false, true]);
    assert.deepEqual(checkboxes.map((node) => node.props.checked), [true, true, true, false]);

    await act(async () => {
      buttonWithText(view, TEXT.settings.skills.git.importSelected(2)).props.onClick();
    });

    // One background job carries the whole selection; no per-package request
    // leaves the view.
    assert.equal(stub.calls.some((call) => call.path === "/api/skills/import-git"), false);
    assert.deepEqual(started, [{
      commit,
      items: [
        { subdirectory: "skills/fresh" },
        { expectedRevision: 3, overwrite: true, subdirectory: "skills/review" },
      ],
      repositoryUrl: inspection.repositoryUrl,
    }]);
    assert.equal(done, 1, "an accepted import does not return to the Skill list");
  } finally { await act(async () => { view.unmount(); }); }
});

const gitRows = (from: number, to: number) => Array.from({ length: to - from }, (_, offset) => ({
  description: `Skill ${from + offset}`,
  diagnostics: [],
  name: `skill-${from + offset}`,
  status: "new" as const,
  subdirectory: `skills/skill-${from + offset}`,
}));

/** A repository whose inspection answers in two pages. */
function twoPageInspection(): { commit: string; stub: StubClient; url: string } {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const url = "https://example.invalid/org/skills.git";
  const stub = new StubClient()
    .reply({ candidates: gitRows(0, 3), commit, nextCursor: "skills/skill-2", repositoryUrl: url, total: 7 })
    .reply({ candidates: gitRows(3, 7), commit, repositoryUrl: url, total: 7 });
  return { commit, stub, url };
}

test("a repository larger than one page reads the rest on request", async () => {
  const { commit, stub, url } = twoPageInspection();
  const view = await mount(<SkillGitImportView client={stub.asClient()} onStart={async () => {}} />);
  try {
    const input = view.root.findAllByType("input").find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: url } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });

    // The header names the repository, the list shows the page it got.
    const checkboxes = () => view.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    const rendered = () => JSON.stringify(view.toJSON());
    assert.ok(rendered().includes(TEXT.settings.skills.git.found(7)));
    assert.ok(rendered().includes(TEXT.settings.skills.git.loaded(3, 7)));
    assert.equal(checkboxes().length, 4);
    assert.ok(buttonWithText(view, TEXT.settings.skills.git.importSelected(3)));

    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.loadMore).props.onClick(); });

    // The next page is read at the same commit, from where the last one
    // ended; the rows already read stay on screen.
    assert.deepEqual(json(requestAt(stub, 1)), { commit, cursor: "skills/skill-2", repositoryUrl: url });
    assert.equal(checkboxes().length, 8);
    assert.ok(buttonWithText(view, TEXT.settings.skills.git.importSelected(7)));
    assert.ok(!rendered().includes(TEXT.settings.skills.git.loadMore));
    // Every row was ticked before the second page arrived, so the new ones
    // joined the selection.
    assert.ok(buttonWithText(view, TEXT.settings.skills.git.importSelected(7)));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a /tree/ URL keeps its subdirectory on the next page", async () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const treeUrl = "https://github.com/org/repo/tree/main/skills";
  const normalized = "https://github.com/org/repo.git";
  const stub = new StubClient()
    .reply({ candidates: gitRows(0, 3), commit, nextCursor: "skills/skill-2", repositoryUrl: normalized, total: 7 })
    .reply({ candidates: gitRows(3, 7), commit, repositoryUrl: normalized, total: 7 });
  const view = await mount(<SkillGitImportView client={stub.asClient()} onStart={async () => {}} />);
  try {
    const input = view.root.findAllByType("input").find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: treeUrl } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.loadMore).props.onClick(); });

    // The inspection response carries the normalized URL only; the /tree/
    // form is what tells the server which subtree the cursor belongs to.
    assert.deepEqual(json(requestAt(stub, 1)), {
      commit,
      cursor: "skills/skill-2",
      repositoryUrl: treeUrl,
    });
  } finally { await act(async () => { view.unmount(); }); }
});

test("loading more does not re-tick what the user unticked", async () => {
  const { stub, url } = twoPageInspection();
  const view = await mount(<SkillGitImportView client={stub.asClient()} onStart={async () => {}} />);
  try {
    const input = view.root.findAllByType("input").find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: url } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });

    const checkboxes = () => view.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    const first = checkboxes()[0];
    assert.ok(first, "the page has no checkbox");
    await act(async () => { first.props.onChange(); });
    assert.equal(buttonWithText(view, TEXT.settings.skills.git.importSelected(0)).props.disabled, true);

    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.loadMore).props.onClick(); });

    assert.equal(checkboxes().length, 8);
    assert.equal(buttonWithText(view, TEXT.settings.skills.git.importSelected(0)).props.disabled, true);
    assert.deepEqual(checkboxes().map((node) => node.props.checked), Array.from({ length: 8 }, () => false));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a checkout that cannot reach the repository names the network and the proxy", async () => {
  const stub = new StubClient().fail(
    new Error("Git skill checkout timed out; retry, or narrow the import with a Ref or subdirectory"),
  );
  const view = await mount(<SkillGitImportView client={stub.asClient()} onStart={async () => {}} />);
  try {
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: "https://github.com/org/skills" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });
    await settle();

    const rendered = JSON.stringify(view.toJSON());
    assert.ok(rendered.includes(TEXT.settings.skills.git.inspectTimeout),
      "a network timeout is not explained in the reader's language");
    assert.ok(!rendered.includes("Git skill checkout timed out"));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a slow inspection says what it is doing and can be cancelled", async () => {
  // A clone of a large repository is the one request in this pane that takes
  // long enough for a user to wonder whether the page is alive.
  let aborted = false;
  const client = {
    request: <T,>(_path: string, init: RequestInit = {}): Promise<T> => new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => {
        aborted = true;
        reject(new DOMException("The operation was aborted.", "AbortError"));
      });
    }),
  } as unknown as ApiClient;
  const view = await mount(<SkillGitImportView client={client} onStart={async () => {}} />);
  try {
    const url = view.root.findAllByType("input").find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(url);
    await act(async () => { url.props.onChange({ target: { value: "https://example.invalid/org/skills.git" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });

    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.git.inspectHint));
    const cancel = buttonWithText(view, TEXT.settings.skills.git.cancelInspect);
    await act(async () => { cancel.props.onClick(); });

    assert.equal(aborted, true);
    // Cancelling is not a failure: the page goes back to 检查 with no alert.
    buttonWithText(view, TEXT.settings.skills.git.inspect);
    assert.ok(!JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.git.inspectHint));
  } finally { await act(async () => { view.unmount(); }); }
});

test("the editor submits the revision it read and hands back the keys its form does not show", async () => {
  const stub = new StubClient().reply(detail).reply({ ...detail, currentRevision: 2, instructions: "Review twice" });
  const saved: SkillDetail[] = [];
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={(row) => { saved.push(row); }} skillId="review" />,
  );
  try {
    assert.equal(stub.calls[0]?.path, "/api/skills/review");
    const instructions = textareaWithLabel(view, TEXT.settings.skills.editor.instructions);
    await act(async () => { instructions.props.onChange({ target: { value: "Review twice" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });

    const write = stub.calls[1];
    assert.ok(write);
    assert.equal(write.path, "/api/skills/review");
    assert.equal(write.init.method, "PUT");
    assert.deepEqual(json(write), {
      allowedTools: "Bash",
      compatibility: "python 3.11",
      description: "Review a draft",
      expectedRevision: 1,
      instructions: "Review twice",
      license: "MIT",
      metadata: { owner: "sd" },
      name: "review",
    });
    assert.equal(saved[0]?.currentRevision, 2);
  } finally { await act(async () => { view.unmount(); }); }
});

test("the editor forwards a list-valued allowed-tools unchanged", async () => {
  const listed = {
    ...detail,
    frontmatter: { ...detail.frontmatter, "allowed-tools": ["Read", "Grep"] },
  };
  const stub = new StubClient().reply(listed).reply({ ...listed, currentRevision: 2 });
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={() => {}} skillId="review" />,
  );
  try {
    const instructions = textareaWithLabel(view, TEXT.settings.skills.editor.instructions);
    await act(async () => { instructions.props.onChange({ target: { value: "Review twice" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });
    assert.deepEqual(json(stub.calls[1]!).allowedTools, ["Read", "Grep"]);
  } finally { await act(async () => { view.unmount(); }); }
});

test("a stale revision is reported as a conflict, not as a failed save", async () => {
  const stub = new StubClient()
    .reply(detail)
    .fail(new ApiRequestError("Skill revision conflict", 409));
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={() => {}} skillId="review" />,
  );
  try {
    await act(async () => {
      textareaWithLabel(view, TEXT.settings.skills.editor.instructions)
        .props.onChange({ target: { value: "Review twice" } });
    });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.editor.conflict));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a resource file is read and written through its own route", async () => {
  const withResource: SkillDetail = {
    ...detail,
    resources: [{ hash: "h", kind: "reference", path: "references/guide.md", size: 5 }],
  };
  const stub = new StubClient()
    .reply(withResource)
    .reply({ content: "guide", hash: "h", path: "references/guide.md", revision: 1, skillId: "review", size: 5 })
    .reply({ ...withResource, currentRevision: 2 })
    // The saved package re-keys the editor with its new revision, which reads
    // the file again — the pane then shows what was stored, not the draft.
    .reply({ content: "guide v2", hash: "h2", path: "references/guide.md", revision: 2, skillId: "review", size: 8 });
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={() => {}} skillId="review" />,
  );
  try {
    await openAdvancedSettings(view);
    await act(async () => {
      view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === "references/guide.md")?.props.onClick();
    });
    await settle();
    assert.equal(stub.calls[1]?.path, "/api/skills/review/resources/references%2Fguide.md");

    const file = textareaWithLabel(view, "references/guide.md");
    assert.equal(file.props.value, "guide");
    await act(async () => { file.props.onChange({ target: { value: "guide v2" } }); });
    await act(async () => {
      buttonWithText(view, TEXT.settings.skills.editor.saveFile).props.onClick();
    });

    const write = stub.calls[2];
    assert.ok(write);
    assert.equal(write.path, "/api/skills/review/files/references%2Fguide.md");
    assert.deepEqual(json(write), { content: "guide v2", expectedRevision: 1 });

    await settle();
    assert.equal(textareaWithLabel(view, "references/guide.md").props.value, "guide v2");
  } finally { await act(async () => { view.unmount(); }); }
});

test("a resource that is not UTF-8 is shown as uneditable rather than decoded", async () => {
  const withBinary: SkillDetail = {
    ...detail,
    resources: [{ hash: "h", kind: "asset", path: "assets/logo.png", size: 8 }],
  };
  const stub = new StubClient()
    .reply(withBinary)
    .fail(new Error("Skill resource is not valid UTF-8"));
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={() => {}} skillId="review" />,
  );
  try {
    await openAdvancedSettings(view);
    await act(async () => {
      view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === "assets/logo.png")?.props.onClick();
    });
    await settle();
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.editor.binary));
    assert.equal(
      view.root.findAllByType("textarea")
        .some((node) => node.props["aria-label"] === "assets/logo.png"),
      false,
    );
  } finally { await act(async () => { view.unmount(); }); }
});

test("a partial reference upload keeps the revision it already stored", async () => {
  const stub = new StubClient()
    .reply(detail)
    .reply({ ...detail, currentRevision: 2 })
    .fail(new Error("disk full"));
  const saved: SkillDetail[] = [];
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={(row) => { saved.push(row); }} skillId="review" />,
  );
  try {
    await openAdvancedSettings(view);
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.references);
    assert.ok(input);
    const files = [new File(["# one"], "one.md"), new File(["# two"], "two.md")];
    await act(async () => { input.props.onChange({ target: { files } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 20)); });

    assert.equal(saved[0]?.currentRevision, 2);
    assert.ok(JSON.stringify(view.toJSON()).includes("disk full"));
  } finally { await act(async () => { view.unmount(); }); }
});

test("adding a non-UTF-8 reference file is refused before anything is written", async () => {
  const stub = new StubClient().reply(detail);
  const view = await mount(
    <SkillEditorView client={stub.asClient()} onSaved={() => {}} skillId="review" />,
  );
  try {
    await openAdvancedSettings(view);
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.references);
    assert.ok(input);
    const file = new File([new Uint8Array([0xff, 0xfe, 0x00, 0x01])], "logo.png", { type: "image/png" });
    await act(async () => { input.props.onChange({ target: { files: [file] } }); });
    await act(async () => { await new Promise((done) => setTimeout(done, 10)); });

    assert.ok(JSON.stringify(view.toJSON())
      .includes(TEXT.settings.skills.editor.referenceNotText("logo.png")));
    assert.equal(stub.calls.some((call) => call.path.includes("/files/")), false);
    assert.equal(view.root.findAllByType("fieldset")[0]?.props.disabled, false,
      "a refused pick left the editor disabled");
  } finally { await act(async () => { view.unmount(); }); }
});

test("an import enables a new package and leaves an update's switch alone", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({})
    .reply([skill, { ...skill, id: "fresh", name: "fresh" }])
    .reply({ backend: "jiuwenswarm", skills: [] });
  const client: ApiClient = stub.asClient();
  const view = await mount(<SkillsSettings client={client} />);
  try {
    await openAddView(view, TEXT.settings.skills.addMenu.upload);
    const upload = view.root.findByType(SkillUploadView);
    await act(async () => { await upload.props.onImported(skill); });
    assert.equal(stub.calls.some((call) => call.path.includes("skills-by-id")), false);

    const next = view.root.findByType(SkillUploadView);
    await act(async () => { await next.props.onImported({ ...detail, id: "fresh", name: "fresh" }); });
    const enable = stub.calls.find((call) => call.path.includes("skills-by-id"));
    assert.ok(enable);
    assert.equal(enable.path, "/api/jiuwenswarm/skills-by-id/fresh");
    assert.deepEqual(json(enable), { enabled: true });
  } finally { await act(async () => { view.unmount(); }); }
});

/** The row's chevron for `name`, after asserting the row has one. */
function rowMenu(view: ReactTestRenderer, name: string) {
  const trigger = view.root.findAllByType("button")
    .find((node) => node.props["aria-label"] === TEXT.settings.skills.rowMenu.actions(name));
  assert.ok(trigger, `the row for ${name} has no action menu`);
  return trigger;
}

async function openAdvancedSettings(view: ReactTestRenderer): Promise<void> {
  await act(async () => {
    buttonWithText(view, TEXT.settings.skills.editor.advanced).props.onClick();
  });
}

async function openRowMenu(view: ReactTestRenderer, name: string): Promise<void> {
  await act(async () => { rowMenu(view, name).props.onClick(); });
}

function menuItem(view: ReactTestRenderer, label: string) {
  const item = view.root.findAllByType("button")
    .find((node) => node.props.role === "menuitem" && node.children.includes(label));
  assert.ok(item, `the menu does not offer ${label}`);
  return item;
}

test("a managed skill offers export, edit and delete; a built-in only export", async () => {
  const builtIn = { ...skill, id: "literature", name: "literature", source: "built-in" as const, readOnly: true };
  const stub = new StubClient().reply([skill, builtIn]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  const menuLabels = () => view.root.findAllByType("button")
    .filter((node) => node.props.role === "menuitem")
    .flatMap((node) => node.children.filter((child) => typeof child === "string"));
  try {
    rowMenu(view, "literature");
    await openRowMenu(view, "literature");
    assert.deepEqual(menuLabels(), [TEXT.settings.skills.rowMenu.export],
      "a built-in should be copyable but not editable or deletable");
    await act(async () => { rowMenu(view, "literature").props.onClick(); });

    await openRowMenu(view, "review");
    menuItem(view, TEXT.settings.skills.rowMenu.export);
    menuItem(view, TEXT.settings.skills.rowMenu.edit);
    menuItem(view, TEXT.settings.skills.rowMenu.delete);
  } finally { await act(async () => { view.unmount(); }); }
});

test("Escape and a press outside close the menu the chevron opened", async () => {
  // The menu listens on `document`, which the stub above discards. This test
  // records what the component registers so both ways out of the popover can
  // be pressed, then puts the stub back for the tests after it.
  const registrations: Array<[string, EventListener]> = [];
  const shared = globalThis.document;
  Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
    addEventListener(type: string, handler: EventListener) { registrations.push([type, handler]); },
    removeEventListener(type: string, handler: EventListener) {
      const at = registrations.findIndex(([, added]) => added === handler);
      if (at >= 0) registrations.splice(at, 1);
    },
  } });
  const stub = new StubClient().reply([skill]).reply({ backend: "jiuwenswarm", skills: [] });
  let view: ReactTestRenderer | undefined;
  const openEntries = () => view!.root.findAllByType("button").filter((node) => node.props.role === "menuitem");
  try {
    view = await mount(<SkillsSettings client={stub.asClient()} />);

    await openRowMenu(view, "review");
    assert.equal(openEntries().length, 3, "the menu did not open");
    const escape = registrations.find(([type]) => type === "keydown")?.[1];
    assert.ok(escape, "an open menu does not listen for the keyboard");
    let claimed = false;
    await act(async () => {
      escape({ key: "Escape", preventDefault() { claimed = true; } } as unknown as Event);
    });
    assert.equal(openEntries().length, 0, "Escape left the menu open");
    assert.ok(claimed, "Escape also closed the settings dialog behind the menu");

    await openRowMenu(view, "review");
    assert.equal(openEntries().length, 3, "the menu did not reopen");
    const press = registrations.find(([type]) => type === "pointerdown")?.[1];
    assert.ok(press, "an open menu does not listen for a press outside it");
    await act(async () => { press({ target: {} } as unknown as Event); });
    assert.equal(openEntries().length, 0, "a press outside left the menu open");
  } finally {
    if (view) await act(async () => { view!.unmount(); });
    Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: shared });
  }
});

test("clicking a card opens the Skill's own page and the back control returns to the list", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await act(async () => {
      const card = view.root.findAllByType("button")
        .find((node) => node.props.className === "settings-card-main");
      assert.ok(card);
      card.props.onClick();
    });
    await settle();

    assert.equal(stub.calls[2]?.path, "/api/skills/review");
    const headings = view.root.findAllByType("h3").map((node) => JSON.stringify(node.children));
    assert.ok(headings.some((heading) => heading.includes("review")), "the page is not named after the Skill");
    assert.ok(JSON.stringify(view.toJSON()).includes("Review a draft"));
    // The body of SKILL.md is on the page, not in an expanded card.
    assert.ok(JSON.stringify(view.toJSON()).includes("Review carefully"));
    assert.ok(!JSON.stringify(view.toJSON()).includes("settings-card is-expandable"));

    await act(async () => {
      const back = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === TEXT.settings.skills.backToList);
      assert.ok(back);
      back.props.onClick();
    });
    assert.ok(view.root.findAllByType("button")
      .some((node) => node.props.className === "settings-card-main"), "the list did not come back");
  } finally { await act(async () => { view.unmount(); }); }
});

test("编辑 in the row menu opens the editor for that package", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    assert.equal(stub.calls[2]?.path, "/api/skills/review");
    // The editor is named in the trail bar; the reference editor has no
    // second title under it.
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.editor.title("review")));
  } finally { await act(async () => { view.unmount() }); }
});

test("删除 checks the server first, then asks before removing the package", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({ references: [], skillId: "review" })
    .reply({ deleted: "review" })
    .reply([])
    .reply({ backend: "jiuwenswarm", skills: [] });
  const asks: ConfirmRequest[] = [];
  const view = await mount(
    <SkillsSettings client={stub.asClient()} onConfirm={(request) => { asks.push(request); }} />,
  );
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.delete).props.onClick(); });
    await settle();

    assert.equal(stub.calls[2]?.path, "/api/skills/review/deletion-impact");
    assert.equal(stub.calls.some((call) => call.init.method === "DELETE"), false);
    const ask = asks[0];
    assert.ok(ask, "no confirmation was asked");
    assert.ok(ask.body.includes("review"));
    await act(async () => { await ask.onAccept(); });
    await settle();

    const remove = stub.calls.find((call) => call.init.method === "DELETE");
    assert.equal(remove?.path, "/api/skills/review");
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.rowMenu.deleted("review")));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a package still selected somewhere is not deleted and the pane names the count", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply({
      references: [
        { id: "project-one", label: "One project", scope: "project" },
        { id: "session-two", label: "One session", scope: "session" },
      ],
      skillId: "review",
    });
  const asks: ConfirmRequest[] = [];
  const view = await mount(
    <SkillsSettings client={stub.asClient()} onConfirm={(request) => { asks.push(request); }} />,
  );
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.delete).props.onClick(); });
    await settle();

    assert.equal(asks.length, 0, "a blocked deletion still asked for confirmation");
    assert.equal(stub.calls.some((call) => call.init.method === "DELETE"), false);
    assert.ok(JSON.stringify(view.toJSON())
      .includes(TEXT.settings.skills.rowMenu.deleteBlocked("review", 2)));
  } finally { await act(async () => { view.unmount(); }); }
});

test("导出 reads the package route and hands the ZIP to the save dialog", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .stream("PK\u0003\u0004package");
  const written: number[] = [];
  const dialogs: unknown[][] = [];
  const previous = (globalThis as { window?: unknown }).window;
  Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: {
    sdShell: {
      exportFile: {
        downloadsDir: async () => "/tmp",
        saveDialog: async (...args: unknown[]) => {
          dialogs.push(args);
          return { canceled: false, token: "destination" };
        },
        showInFolder: async () => ({ ok: true }),
        write: async (token: string, data: ArrayBuffer) => {
          assert.equal(token, "destination");
          written.push(data.byteLength);
          return { ok: true };
        },
      },
    },
  } });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.export).props.onClick(); });
    await settle();

    assert.equal(stub.calls[2]?.path, "/api/skills/review/package");
    // A Skill is a ZIP; the save dialog must not offer the research package's
    // .sdresearch filter when a Skill is what is being written.
    assert.deepEqual(dialogs[0]?.[1], {
      buttonLabel: TEXT.settings.skills.exportDialog.buttonLabel,
      filters: [{ extensions: ["zip"], name: TEXT.settings.skills.exportDialog.filterName }],
      title: TEXT.settings.skills.exportDialog.title,
    });
    assert.ok((written[0] ?? 0) > 0, "the archive was not written");
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.rowMenu.exported("review")));
  } finally {
    await act(async () => { view.unmount(); });
    Object.defineProperty(globalThis, "window", { configurable: true, writable: true, value: previous });
  }
});
