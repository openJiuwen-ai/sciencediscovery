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
import type {
  GitSkillRepositoryInspection,
  SkillDescriptor,
  SkillDetail,
} from "../src/api/types.js";
import { SkillEditorDialog } from "../src/views/settings/SkillEditorDialog.js";
import { SkillImportDialog } from "../src/views/settings/SkillImportDialog.js";
import { SkillsSettings } from "../src/views/settings/SkillsSettings.js";
import { TEXT } from "../src/text.js";
import { json, StubClient } from "./api-stub.js";
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

function textareaWithLabel(view: ReactTestRenderer, label: string) {
  const found = view.root.findAllByType("textarea").find((node) => node.props["aria-label"] === label);
  assert.ok(found, `no textarea labelled "${label}"`);
  return found;
}

test("one SKILL.md goes up as the multipart field the route reads", async () => {
  const stub = new StubClient().reply(detail);
  const imported: SkillDetail[] = [];
  const view = await mount(
    <SkillImportDialog client={stub.asClient()} onImported={(row) => { imported.push(row); }} />,
  );
  try {
    const file = new File(["# review"], "SKILL.md", { type: "text/markdown" });
    const input = view.root.findAllByType("input").find((node) => node.props.type === "file");
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { files: [file] } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.importAction).props.onClick(); });

    const call = stub.calls[0];
    assert.equal(call?.path, "/api/skills/import");
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
  const stub = new StubClient()
    .reply(inspection)
    .reply({ ...detail, id: "fresh", name: "fresh" })
    .reply({ ...detail, currentRevision: 4 });
  const imported: SkillDetail[] = [];
  const view = await mount(
    <SkillImportDialog client={stub.asClient()} onImported={(row) => { imported.push(row); }} />,
  );
  try {
    await act(async () => { buttonWithText(view, TEXT.settings.skills.importTabs.git).props.onClick(); });
    const url = view.root.findAllByType("input").find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    assert.ok(url);
    await act(async () => { url.props.onChange({ target: { value: inspection.repositoryUrl } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });

    assert.equal(stub.calls[0]?.path, "/api/skills/import-git/inspect");
    assert.ok(JSON.stringify(view.toJSON()).includes("A fresh skill"));
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.git.commit(commit)));
    // The unchanged package is offered but cannot be chosen: there is nothing
    // to write, and writing it would be a revision for a no-op.
    const checkboxes = view.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    assert.deepEqual(checkboxes.map((node) => node.props.disabled), [false, false, true]);
    assert.deepEqual(checkboxes.map((node) => node.props.checked), [true, true, false]);

    await act(async () => {
      buttonWithText(view, TEXT.settings.skills.git.importSelected(2)).props.onClick();
    });

    assert.equal(stub.calls[1]?.path, "/api/skills/import-git");
    assert.deepEqual(json(stub.calls[1]!), {
      commit,
      repositoryUrl: inspection.repositoryUrl,
      subdirectory: "skills/fresh",
    });
    assert.deepEqual(json(stub.calls[2]!), {
      commit,
      expectedRevision: 3,
      overwrite: true,
      repositoryUrl: inspection.repositoryUrl,
      subdirectory: "skills/review",
    });
    assert.deepEqual(imported.map((row) => row.id), ["fresh", "review"]);
    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.importedCount(2)));
  } finally { await act(async () => { view.unmount(); }); }
});

test("the editor submits the revision it read and hands back the keys its form does not show", async () => {
  const stub = new StubClient().reply(detail).reply({ ...detail, currentRevision: 2, instructions: "Review twice" });
  const saved: SkillDetail[] = [];
  const view = await mount(
    <SkillEditorDialog client={stub.asClient()} onClose={() => {}} onSaved={(row) => { saved.push(row); }} skillId="review" />,
  );
  try {
    assert.equal(stub.calls[0]?.path, "/api/skills/review");
    const instructions = textareaWithLabel(view, TEXT.settings.skills.editor.instructions);
    await act(async () => { instructions.props.onChange({ target: { value: "Review twice" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });

    const write = stub.calls[1];
    assert.equal(write?.path, "/api/skills/review");
    assert.equal(write?.init.method, "PUT");
    assert.deepEqual(json(write!), {
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

test("a stale revision is reported as a conflict, not as a failed save", async () => {
  const stub = new StubClient()
    .reply(detail)
    .fail(new ApiRequestError("Skill revision conflict", 409));
  const view = await mount(
    <SkillEditorDialog client={stub.asClient()} onClose={() => {}} onSaved={() => {}} skillId="review" />,
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
    <SkillEditorDialog client={stub.asClient()} onClose={() => {}} onSaved={() => {}} skillId="review" />,
  );
  try {
    await act(async () => {
      view.root.findAllByType("button")
        .find((node) => node.children.includes("references/guide.md"))?.props.onClick();
    });
    await settle();
    assert.equal(stub.calls[1]?.path, "/api/skills/review/resources/references%2Fguide.md");

    const file = textareaWithLabel(view, "references/guide.md");
    assert.equal(file.props.value, "guide");
    await act(async () => { file.props.onChange({ target: { value: "guide v2" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });

    const write = stub.calls[2];
    assert.equal(write?.path, "/api/skills/review/files/references%2Fguide.md");
    assert.deepEqual(json(write!), { content: "guide v2", expectedRevision: 1 });

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
    <SkillEditorDialog client={stub.asClient()} onClose={() => {}} onSaved={() => {}} skillId="review" />,
  );
  try {
    await act(async () => {
      view.root.findAllByType("button")
        .find((node) => node.children.includes("assets/logo.png"))?.props.onClick();
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
  const view = await mount(
    <SkillsSettings
      adding={false}
      client={client}
      importing
      onAddingChange={() => {}}
      onImportingChange={() => {}}
    />,
  );
  try {
    const dialog = view.root.findByType(SkillImportDialog);
    await act(async () => { await dialog.props.onImported(skill); });
    assert.equal(stub.calls.some((call) => call.path.includes("skills-by-id")), false);

    const next = view.root.findByType(SkillImportDialog);
    await act(async () => { await next.props.onImported({ ...detail, id: "fresh", name: "fresh" }); });
    const enable = stub.calls.find((call) => call.path.includes("skills-by-id"));
    assert.equal(enable?.path, "/api/jiuwenswarm/skills-by-id/fresh");
    assert.deepEqual(json(enable!), { enabled: true });
  } finally { await act(async () => { view.unmount(); }); }
});

test("only a managed, writable skill offers 编辑", async () => {
  const builtIn = { ...skill, id: "literature", name: "literature", source: "built-in" as const, readOnly: true };
  const stub = new StubClient().reply([skill, builtIn]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(
    <SkillsSettings
      adding={false}
      client={stub.asClient()}
      importing={false}
      onAddingChange={() => {}}
      onImportingChange={() => {}}
    />,
  );
  try {
    const editable = view.root.findAllByType("button")
      .filter((node) => node.props.className?.includes?.("skill-edit-button"));
    assert.equal(editable.length, 1);
    assert.equal(editable[0]?.props.className, "secondary-button skill-edit-button");
  } finally { await act(async () => { view.unmount(); }); }
});
