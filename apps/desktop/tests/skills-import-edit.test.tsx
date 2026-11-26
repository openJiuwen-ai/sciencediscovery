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
import { SkillDetailView } from "../src/views/settings/SkillDetailView.js";
import { SkillGitImportView } from "../src/views/settings/SkillGitImportView.js";
import { fileTree } from "../src/views/settings/skill-files.js";
import { SkillToasts } from "../src/views/settings/SkillToasts.js";
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

test("the add menu opens 上传技能 as a dialog, and its close control returns to the list", async () => {
  const stub = new StubClient().reply([skill]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openAddView(view, TEXT.settings.skills.addMenu.upload);
    assert.equal(view.root.findAllByProps({ role: "dialog" }).length, 1, "上传技能 did not open a dialog");
    assert.ok(view.root.findAllByType(SkillUploadView), "the dialog has no upload body");
    // The list stays behind the dialog rather than being swapped out.
    assert.ok(view.root.findAllByType("button")
      .some((node) => node.props.className === "settings-card-main"));
    await act(async () => {
      const close = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === TEXT.settings.skills.closeDialog);
      assert.ok(close, "the dialog has no close control");
      close.props.onClick();
    });
    assert.equal(view.root.findAllByProps({ role: "dialog" }).length, 0);
    assert.equal(view.root.findAllByType(SkillUploadView).length, 0);
  } finally { await act(async () => { view.unmount(); }); }
});

test("a running Git import shows its progress instead of the form", async () => {
  const job = {
    done: 11, failures: [], id: "job-1", imported: [], startedAt: new Date().toISOString(),
    status: "running" as const, total: 120,
  };
  const view = await mount(
    <SkillGitImportView client={new StubClient().asClient()} job={job} onCancel={() => {}} onStart={async () => {}} />,
  );
  try {
    const markup = JSON.stringify(view.toJSON());
    assert.match(markup, /正在导入\(11\/120\)/u);
    assert.match(markup, /9%/u);
    assert.ok(!markup.includes(TEXT.settings.skills.git.url), "the URL form still paints during the job");
  } finally { await act(async () => { view.unmount(); }); }
});

test("one SKILL.md goes up as the multipart field the route reads", async () => {
  const stub = new StubClient().reply(detail);
  const imported: SkillDetail[] = [];
  const view = await mount(
    <SkillUploadView
      client={stub.asClient()}
      onImported={(row) => { imported.push(row); }}
      onCancel={() => {}}
    />,
  );
  try {
    const file = new File(["# review"], "SKILL.md", { type: "text/markdown" });
    const input = view.root.findAllByType("input").find((node) => node.props.type === "file");
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { files: [file] } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.uploadDialog.confirm).props.onClick(); });

    const call = stub.calls[0];
    assert.equal(call?.path, "/api/skills/import?onDuplicate=rename");
    assert.equal(call?.init.method, "POST");
    const form = call?.init.body;
    assert.ok(form instanceof FormData);
    assert.equal((form.get("file") as File).name, "SKILL.md");
    assert.deepEqual(imported.map((row) => row.id), ["review"]);
    assert.equal(stub.calls.length, 1, "a second import was sent");
  } finally { await act(async () => { view.unmount(); }); }
});

/** Pick a file in the dialog and press 确定, then hand back the markup the
 *  refusal left on the pane. */
async function refusalMarkup(reason: unknown): Promise<string> {
  const stub = new StubClient().fail(reason);
  const view = await mount(
    <SkillUploadView client={stub.asClient()} onCancel={() => {}} onImported={() => {}} />,
  );
  try {
    const file = new File(["PK"], "skills-main.zip", { type: "application/zip" });
    const input = view.root.findAllByType("input").find((node) => node.props.type === "file");
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { files: [file] } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.uploadDialog.confirm).props.onClick(); });
    return JSON.stringify(view.toJSON());
  } finally { await act(async () => { view.unmount(); }); }
}

test("an archive over the entry cap shows the count beside the cap, in the pane's language", async () => {
  const markup = await refusalMarkup(new ApiRequestError(
    "Skill archive exceeds 500 entries",
    413,
    "SKILL_PACKAGE_REFUSED",
    { refusal: { actual: 1200, cap: 500, limit: "entries", reason: "too-large" } },
  ));
  const text = TEXT.settings.skills.uploadDialog.refusals;
  assert.ok(markup.includes(text.entries(1200, 500)), "the count and the cap are not beside each other");
  assert.ok(markup.includes(text.onePackage), "the Git import route is not offered");
  assert.ok(!markup.includes("Skill archive exceeds 500 entries"), "the server's English sentence was shown verbatim");
});

test("a repository ZIP with no root SKILL.md says one package and points at Git import", async () => {
  const markup = await refusalMarkup(new ApiRequestError(
    "Skill ZIP package root must contain SKILL.md",
    400,
    "SKILL_PACKAGE_REFUSED",
    { refusal: { reason: "missing-root" } },
  ));
  const text = TEXT.settings.skills.uploadDialog.refusals;
  assert.ok(markup.includes(text.missingRoot), "the missing root is not named");
  assert.ok(markup.includes(text.onePackage), "the reader is not told that one ZIP is one package, or how to import a repository");
});

test("the drop zone is the label of the file input, so a click opens the picker", async () => {
  const view = await mount(
    <SkillUploadView client={new StubClient().asClient()} onCancel={() => {}} onImported={() => {}} />,
  );
  try {
    const input = view.root.findAllByType("input").find((node) => node.props.type === "file");
    assert.ok(input, "the dialog has no file input");
    const drop = view.root.findAllByType("label")
      .find((node) => String(node.props.className).split(" ").includes("skill-drop"));
    assert.ok(drop, "the dialog has no drop zone");
    assert.equal(drop.props.htmlFor, input.props.id, "the drop zone does not point at the file input");
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
  const view = await mount(
    <SkillGitImportView
      client={stub.asClient()}
      onCancel={() => {}}
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
    assert.equal(stub.calls.some((call) => call.path === "/api/skills/import-git"), false);
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
  const view = await mount(<SkillGitImportView client={stub.asClient()} onCancel={() => {}} onStart={async () => {}} />);
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
  const view = await mount(<SkillGitImportView client={stub.asClient()} onCancel={() => {}} onStart={async () => {}} />);
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
  const view = await mount(<SkillGitImportView client={stub.asClient()} onCancel={() => {}} onStart={async () => {}} />);
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
  const view = await mount(<SkillGitImportView client={stub.asClient()} onCancel={() => {}} onStart={async () => {}} />);
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
  const view = await mount(<SkillGitImportView client={client} onCancel={() => {}} onStart={async () => {}} />);
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
    assert.equal(view.root.findAllByType(SkillUploadView).length, 0, "the dialog stayed open after the import");

    await openAddView(view, TEXT.settings.skills.addMenu.upload);
    const next = view.root.findByType(SkillUploadView);
    await act(async () => { await next.props.onImported({ ...detail, id: "fresh", name: "fresh" }); });
    const enable = stub.calls.find((call) => call.path.includes("skills-by-id"));
    assert.ok(enable);
    assert.equal(enable.path, "/api/jiuwenswarm/skills-by-id/fresh");
    assert.deepEqual(json(enable), { enabled: true });
  } finally { await act(async () => { view.unmount(); }); }
});

test("an upload that lands leaves a success notice over the list", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    // afterInstall re-reads the catalog behind the dialog
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openAddView(view, TEXT.settings.skills.addMenu.upload);
    await act(async () => {
      await view.root.findByType(SkillUploadView).props.onImported(skill);
    });
    const markup = JSON.stringify(view.toJSON());
    assert.ok(markup.includes(TEXT.settings.skills.toastUploadDone(skill.name)), "no success notice");
    assert.ok(view.root.findAllByProps({ className: "skill-toasts" }).length === 1);
  } finally { await act(async () => { view.unmount(); }); }
});

test("an upload whose enable step fails says so instead of claiming success", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    // afterInstall tries the switch, and the runtime refuses
    .fail(new ApiRequestError("JiuwenSwarm is unreachable", 503))
    .reply([skill, { ...skill, id: "fresh", name: "fresh" }])
    .reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openAddView(view, TEXT.settings.skills.addMenu.upload);
    await act(async () => {
      await view.root.findByType(SkillUploadView).props.onImported({ ...detail, id: "fresh", name: "fresh" });
    });
    const markup = JSON.stringify(view.toJSON());
    assert.ok(markup.includes(TEXT.settings.skills.toastUploadNotEnabled("fresh")), "no enable failure notice");
    assert.ok(!markup.includes(TEXT.settings.skills.toastUploadDone("fresh")),
      "the success notice still says the package is ready");
    assert.ok(markup.includes("JiuwenSwarm is unreachable"), "the reason is missing");
  } finally { await act(async () => { view.unmount(); }); }
});

test("a page that arrives after the repository changed does not land", async () => {
  const commit = "0123456789abcdef0123456789abcdef01234567";
  const urlA = "https://example.invalid/org/a.git";
  const urlB = "https://example.invalid/org/b.git";
  const stub = new StubClient()
    .reply({ candidates: gitRows(0, 2), commit, nextCursor: "skills/skill-1", repositoryUrl: urlA, total: 3 })
    .reply({ candidates: gitRows(2, 3), commit, repositoryUrl: urlA, total: 3 });
  const view = await mount(<SkillGitImportView client={stub.asClient()} onCancel={() => {}} onStart={async () => {}} />);
  try {
    const input = () => view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.git.url);
    const checkboxes = () => view.root.findAllByType("input").filter((node) => node.props.type === "checkbox");
    assert.ok(input());
    await act(async () => { input().props.onChange({ target: { value: urlA } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.git.inspect).props.onClick(); });
    assert.equal(checkboxes().length, 3);

    // Read the next page, then correct the address before that page answers.
    await act(async () => {
      buttonWithText(view, TEXT.settings.skills.git.loadMore).props.onClick();
      input().props.onChange({ target: { value: urlB } });
    });

    // The answer belongs to the repository the reader left: it must not
    // repaint rows, or an import would target an address no longer on screen.
    assert.equal(input().props.value, urlB);
    assert.equal(checkboxes().length, 0, "the old repository's page repainted the list");
    assert.ok(!JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.git.found(3)),
      "the old inspection's header is back");
  } finally { await act(async () => { view.unmount(); }); }
});

test("notices draw all three kinds, close, and retry where offered", async () => {
  const calls: string[] = [];
  const view = await mount(
    <SkillToasts items={[
      { id: "ok", kind: "success", message: "done", onClose: () => calls.push("close-ok") },
      { id: "run", kind: "progress", message: "running", onClose: () => calls.push("close-run") },
      {
        id: "bad", kind: "error", message: "failed",
        onClose: () => calls.push("close-bad"),
        onRetry: () => calls.push("retry"),
      },
    ]} />,
  );
  try {
    const markup = JSON.stringify(view.toJSON());
    for (const message of ["done", "running", "failed"]) {
      assert.ok(markup.includes(message), `${message} is missing`);
    }
    const retry = view.root.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.toastRetry));
    assert.ok(retry, "the failed notice offers no retry");
    await act(async () => { retry.props.onClick(); });
    assert.deepEqual(calls, ["retry"]);
    const closes = view.root.findAllByType("button")
      .filter((node) => node.props["aria-label"] === TEXT.settings.skills.toastClose);
    assert.equal(closes.length, 3);
    await act(async () => { closes[0]!.props.onClick(); });
    assert.deepEqual(calls, ["retry", "close-ok"]);
  } finally { await act(async () => { view.unmount(); }); }
});

/** The text under a rendered node, for the rows whose label is a child span. */
function textUnder(node: unknown): string {
  if (typeof node === "string") return node;
  if (Array.isArray(node)) return node.map(textUnder).join("");
  if (node !== null && typeof node === "object" && "children" in node) {
    return textUnder((node as { children: unknown }).children);
  }
  return "";
}

test("a folder created in the editor stays a folder with no files", () => {
  const tree = fileTree({ ...detail, resources: [] }, ["xxx"]);
  const folder = tree.find((node) => node.name === "xxx");
  assert.ok(folder, "the local folder is missing from the tree");
  assert.deepEqual(folder.children, []);
  // SKILL.md is a file at the root, beside the folders — not inside a 文件 group.
  const skill = tree.find((node) => node.name === "SKILL.md");
  assert.ok(skill, "SKILL.md is not at the root");
  assert.equal(skill.children, undefined);
  assert.ok(!tree.some((node) => node.children?.some((child) => child.name === "SKILL.md")),
    "SKILL.md is nested under a synthetic group");

  // Root files lead, folders follow: kkk.md sits beside SKILL.md, not after
  // every folder.
  const withRootFile = fileTree({
    ...detail,
    resources: [
      { hash: "h1", kind: "script", path: "assets/a.js", size: 1 },
      { hash: "h2", kind: "other", path: "kkk.md", size: 1 },
    ],
  }, ["xxx"]);
  assert.deepEqual(withRootFile.map((node) => node.name), ["SKILL.md", "kkk.md", "assets", "xxx"]);
});

test("技能详情 puts the package's tree beside the open file", async () => {
  const rich: SkillDetail = {
    ...detail,
    resources: [
      { hash: "h1", kind: "script", path: "assets/a.js", size: 20 },
      { hash: "h2", kind: "reference", path: "references/b.md", size: 30 },
      { hash: "h3", kind: "other", path: "notes.txt", size: 5 },
      { hash: "h4", kind: "reference", path: "references/d.md", size: 10 },
      { hash: "h5", kind: "asset", path: "assets/r.md", size: 12 },
    ],
  };
  const stub = new StubClient()
    .reply(rich)
    .reply({
      content: "# B\n\nBody of B. See [d](./d.md) or [web](https://example.com).",
      hash: "h2", path: "references/b.md", revision: 1, skillId: "review", size: 30,
    })
    .reply({
      content: "# D\n\nBody of D. [r](assets/r.md).",
      hash: "h4", path: "references/d.md", revision: 1, skillId: "review", size: 10,
    })
    .reply({ content: "# R\n\nBody of R.", hash: "h5", path: "assets/r.md", revision: 1, skillId: "review", size: 12 });
  const view = await mount(
    <SkillDetailView
      client={stub.asClient()}
      onBack={() => {}}
      onDelete={() => {}}
      onEdit={() => {}}
      onToggle={() => {}}
      skillId="review"
      switchesAvailable={false}
    />,
  );
  try {
    await settle();
    await act(async () => {
      const tab = view.root.findAllByType("button")
        .find((node) => node.children.includes(TEXT.settings.skills.tabs.files));
      assert.ok(tab, "the 技能详情 tab is missing");
      tab.props.onClick();
    });
    const markup = JSON.stringify(view.toJSON());
    for (const label of [TEXT.settings.skills.fileTree.list, "SKILL.md", "assets", "a.js", "references", "b.md", "notes.txt"]) {
      assert.ok(markup.includes(label), `the tree does not show ${label}`);
    }
    // SKILL.md is open first, without a resource read.
    assert.ok(markup.includes("Review carefully"));
    assert.equal(stub.calls.length, 1, "SKILL.md was fetched as a resource");

    const openB = view.root.findAllByType("button")
      .find((node) => textUnder(node) === "b.md");
    assert.ok(openB, "the tree has no b.md row");
    await act(async () => { openB.props.onClick(); });
    await settle();
    assert.equal(stub.calls[1]?.path, "/api/skills/review/resources/references%2Fb.md");
    assert.match(JSON.stringify(view.toJSON()), /Body of B/u);

    // A link to another package file opens that file in the same pane; a link
    // to the web is left alone.
    const anchors = () => view.root.findAllByType("a");
    const web = anchors().find((node) => textUnder(node) === "web");
    assert.ok(web, "the external link is missing");
    let externalPrevented = false;
    await act(async () => {
      web.props.onClick({ preventDefault() { externalPrevented = true; } });
    });
    assert.equal(externalPrevented, false, "an external link was captured as a package file");

    const dLink = anchors().find((node) => textUnder(node) === "d");
    assert.ok(dLink, "the package link is missing");
    let prevented = false;
    await act(async () => {
      dLink.props.onClick({ preventDefault() { prevented = true; } });
    });
    assert.equal(prevented, true, "the package link was not handled in place");
    await settle();
    assert.equal(stub.calls[2]?.path, "/api/skills/review/resources/references%2Fd.md");
    assert.match(JSON.stringify(view.toJSON()), /Body of D/u);

    // A link written from the package root still finds its file when the
    // relative reading (references/assets/r.md) does not exist.
    const rootLink = anchors().find((node) => textUnder(node) === "r");
    assert.ok(rootLink, "the root-relative link is missing");
    await act(async () => {
      rootLink.props.onClick({ preventDefault() {} });
    });
    await settle();
    assert.equal(stub.calls[3]?.path, "/api/skills/review/resources/assets%2Fr.md");
    assert.match(JSON.stringify(view.toJSON()), /Body of R/u);
    // Folder carets are glyphs on the row's centre line, not text baselines.
    assert.ok(view.root.findAllByProps({ className: "skill-tree-caret-glyph" }).length >= 2);

    // A folder collapses its children.
    const folder = view.root.findAllByType("button")
      .find((node) => node.props["aria-expanded"] === true && textUnder(node).includes("assets"));
    assert.ok(folder, "the assets folder has no expand control");
    await act(async () => { folder.props.onClick(); });
    assert.ok(!JSON.stringify(view.toJSON()).includes("a.js"), "a collapsed folder still shows its files");
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

test("a pressed row menu survives pointer leave during scrolling; hover alone stays transient", async () => {
  const stub = new StubClient().reply([skill]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  const root = () => view.root.findAllByType("div").find(node => node.props.className === "skill-row-menu")!;
  const entries = () => view.root.findAllByType("button").filter(node => node.props.role === "menuitem");
  try {
    await act(async () => { root().props.onPointerEnter({ pointerType: "mouse" }); });
    assert.equal(entries().length, 3);
    await act(async () => { root().props.onPointerLeave(); });
    assert.equal(entries().length, 0, "hover-only menus close on pointer leave");
    await openRowMenu(view, "review");
    await act(async () => { root().props.onPointerLeave(); });
    assert.equal(entries().length, 3, "scrolling away from the trigger must not remove a pressed menu");
    await act(async () => { rowMenu(view, "review").props.onClick(); });
    assert.equal(entries().length, 0, "a second press closes the menu");
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
    // 基本信息 is the body of SKILL.md, as the handoff draws it; the page is
    // a document under 返回, not an expanded card.
    assert.ok(JSON.stringify(view.toJSON()).includes("Review carefully"));
    assert.ok(!JSON.stringify(view.toJSON()).includes("settings-card is-expandable"));
    assert.equal(view.root.findAllByProps({ role: "tab" }).length, 2, "the two tabs are missing");

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
    .reply(detail)
    .reply({ content: "---\nname: review\ndescription: Review a draft\n---\n\nReview carefully", revision: 1, skillId: "review" });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    assert.equal(stub.calls[2]?.path, "/api/skills/review");
    assert.equal(stub.calls[3]?.path, "/api/skills/review/skill-md");
    // The editor opens SKILL.md as the whole document, frontmatter included.
    const editor = view.root.findAllByType("textarea")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.content);
    assert.ok(editor, "the file editor has no textarea");
    assert.match(String(editor.props.value), /name: review/u);
    assert.match(String(editor.props.value), /Review carefully/u);
  } finally { await act(async () => { view.unmount() }); }
});

test("the file editor saves the whole SKILL.md under the revision it read", async () => {
  const nextDetail = { ...detail, currentRevision: 2 };
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail)
    .reply({ content: "---\nname: review\ndescription: Review a draft\n---\n\nReview carefully", revision: 1, skillId: "review" })
    .reply(nextDetail)
    // The editor leaves for the package's page (which reads it again); the
    // list behind it reloads too.
    .reply(nextDetail)
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    const editor = () => view.root.findAllByType("textarea")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.content);
    await act(async () => {
      editor()!.props.onChange({ target: { value: "---\nname: review\ndescription: Review a draft\n---\n\nReview even more carefully" } });
    });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });
    await settle();
    const write = stub.calls.find((call) => call.path === "/api/skills/review/skill-md" && call.init.method === "PUT");
    assert.ok(write, "the edited SKILL.md was not written");
    assert.deepEqual(json(write), {
      content: "---\nname: review\ndescription: Review a draft\n---\n\nReview even more carefully",
      expectedRevision: 1,
    });
    // Saving leaves edit mode for the package's own page.
    assert.equal(editor(), undefined, "the editor stayed open after saving");
    assert.ok(JSON.stringify(view.toJSON()).includes("skill-detail-page"), "the package page did not come back");
    await settle();
    await settle();
    const selectedTab = view.root.findAllByType("button")
      .find((node) => node.props.role === "tab" && node.props["aria-selected"] === true);
    const selectedLabel = Array.isArray(selectedTab?.children) ? selectedTab.children.join("") : selectedTab?.children;
    assert.equal(selectedLabel, TEXT.settings.skills.tabs.files, "saving did not land on 技能详情");
  } finally { await act(async () => { view.unmount() }); }
});

test("a revision conflict in the editor is explained in the page's language", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    .fail(new ApiRequestError("Skill revision conflict: expected 1, current 2", 409));
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    const editor = view.root.findAllByType("textarea")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.content);
    assert.ok(editor);
    await act(async () => { editor.props.onChange({ target: { value: "changed" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });
    await settle();
    const markup = JSON.stringify(view.toJSON());
    assert.ok(markup.includes(TEXT.settings.skills.editor.conflict));
    assert.ok(!markup.includes("Skill revision conflict"), "the server's developer text reached the page");
  } finally { await act(async () => { view.unmount() }); }
});

test("leaving the editor without changes lands on 技能详情", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    // The package page reads the Skill again when it comes back.
    .reply(detail);
  const asks: ConfirmRequest[] = [];
  const view = await mount(
    <SkillsSettings client={stub.asClient()} onConfirm={(request) => { asks.push(request); }} />,
  );
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.exit).props.onClick(); });
    await settle();
    assert.equal(asks.length, 0, "an untouched editor asked about unsaved changes");
    await settle();
    await settle();
    const selectedTab = view.root.findAllByType("button")
      .find((node) => node.props.role === "tab" && node.props["aria-selected"] === true);
    const selectedLabel = Array.isArray(selectedTab?.children) ? selectedTab.children.join("") : selectedTab?.children;
    assert.equal(selectedLabel, TEXT.settings.skills.tabs.files, "exit did not land on 技能详情");
  } finally { await act(async () => { view.unmount() }); }
});

test("leaving the editor with a draft asks before discarding it", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    // Accepting the notice lands on the package page, which reads it again.
    .reply(detail);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    const editor = view.root.findAllByType("textarea")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.content);
    assert.ok(editor);
    await act(async () => { editor.props.onChange({ target: { value: "changed again" } }); });
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.exit).props.onClick(); });
    const dialog = view.root.findAllByProps({ role: "dialog" })
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.unsavedTitle);
    assert.ok(dialog, "leaving with a draft did not ask");
    assert.ok(textUnder(dialog).includes(TEXT.settings.skills.editor.unsavedBody));
    const accept = dialog.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.uploadDialog.confirm));
    assert.ok(accept, "the notice has no 确定");
    await act(async () => { accept.props.onClick(); });
    await settle();
    await settle();
    const selectedTab = view.root.findAllByType("button")
      .find((node) => node.props.role === "tab" && node.props["aria-selected"] === true);
    const selectedLabel = Array.isArray(selectedTab?.children) ? selectedTab.children.join("") : selectedTab?.children;
    assert.equal(selectedLabel, TEXT.settings.skills.tabs.files, "accepting the notice did not land on 技能详情");
  } finally { await act(async () => { view.unmount() }); }
});

test("deleting a package file asks in the page's own 2-4 dialog", async () => {
  const rich: SkillDetail = {
    ...detail,
    resources: [{ hash: "h2", kind: "reference", path: "references/b.md", size: 30 }],
  };
  const after: SkillDetail = { ...rich, currentRevision: 2, resources: [] };
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(rich)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    .reply(after);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    const remove = view.root.findAllByType("button")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.deletePath("references/b.md"));
    assert.ok(remove, "the file row has no delete action");
    await act(async () => { remove.props.onClick(); });
    const dialog = view.root.findAllByProps({ role: "dialog" })
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.deleteTitle);
    assert.ok(dialog, "deleting a file did not ask");
    assert.ok(textUnder(dialog).includes(TEXT.settings.skills.editor.deleteBody));
    const accept = dialog.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.uploadDialog.confirm));
    assert.ok(accept, "the notice has no 确定");
    await act(async () => { accept.props.onClick(); });
    await settle();
    const write = stub.calls.find((call) => call.path.includes("/files/references%2Fb.md") && call.init.method === "DELETE");
    assert.ok(write, "the delete was not sent");
    assert.deepEqual(json(write), { expectedRevision: 1 });
  } finally { await act(async () => { view.unmount() }); }
});
test("a built-in package's page offers no empty actions menu", async () => {
  const builtIn: SkillDetail = { ...detail, readOnly: true, source: "built-in" };
  const stub = new StubClient().reply(builtIn);
  const view = await mount(
    <SkillDetailView
      client={stub.asClient()}
      onBack={() => {}}
      onDelete={() => {}}
      onEdit={() => {}}
      onToggle={() => {}}
      skillId="review"
      switchesAvailable={false}
    />,
  );
  try {
    await settle();
    const triggers = view.root.findAllByType("button")
      .filter((node) => String(node.props.className).includes("skill-row-menu-trigger"));
    assert.equal(triggers.length, 0, "the built-in page shows a trigger for an empty menu");
  } finally { await act(async () => { view.unmount() }); }
});

test("a save that fails part-way keeps the revision it already wrote", async () => {
  const withResources: SkillDetail = {
    ...detail,
    resources: [
      { hash: "h1", kind: "reference", path: "references/b.md", size: 3 },
      { hash: "h2", kind: "reference", path: "references/c.md", size: 3 },
    ],
  };
  const afterSkillMd: SkillDetail = { ...withResources, currentRevision: 2 };
  const afterB: SkillDetail = { ...withResources, currentRevision: 3 };
  const afterC: SkillDetail = { ...withResources, currentRevision: 4 };
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(withResources)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    .reply({ content: "# B", hash: "h1", path: "references/b.md", revision: 1, skillId: "review", size: 3 })
    .reply({ content: "# C", hash: "h2", path: "references/c.md", revision: 1, skillId: "review", size: 3 })
    .reply(afterSkillMd)
    .reply(afterB)
    .fail(new Error("write refused"))
    .reply(afterC);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();
    const editor = () => view.root.findAllByType("textarea")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.content);

    await act(async () => { editor()!.props.onChange({ target: { value: "---\nname: review\n---\n\nReview carefully!" } }); });
    const openResource = (name: string) => view.root.findAllByType("button")
      .find((node) => textUnder(node) === name);
    await act(async () => { openResource("b.md")!.props.onClick(); });
    await settle();
    await act(async () => { editor()!.props.onChange({ target: { value: "# B edited" } }); });
    await act(async () => { openResource("c.md")!.props.onClick(); });
    await settle();
    await act(async () => { editor()!.props.onChange({ target: { value: "# C edited" } }); });

    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });
    await settle();
    // SKILL.md and b.md landed; c.md was refused. The retry must start from
    // the revision the server already holds.
    await act(async () => { buttonWithText(view, TEXT.settings.skills.editor.save).props.onClick(); });
    await settle();

    const skillWrites = stub.calls.filter((call) => call.path === "/api/skills/review/skill-md" && call.init.method === "PUT");
    assert.equal(skillWrites.length, 1, "SKILL.md was resent on the retry");
    const cWrites = stub.calls.filter((call) => call.path === "/api/skills/review/files/references%2Fc.md");
    assert.equal(cWrites.length, 2);
    for (const write of cWrites) {
      assert.equal((json(write) as { expectedRevision: number }).expectedRevision, 3,
        "the retry used a revision from before the writes that landed");
    }
  } finally { await act(async () => { view.unmount() }); }
});

test("creating a file in the editor writes an empty one at the revision it read", async () => {
  const created: SkillDetail = { ...detail, currentRevision: 2 };
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    .reply(created);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();

    await act(async () => {
      const add = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.newFile);
      assert.ok(add, "the tree has no 新建文件");
      add.props.onClick();
    });
    const name = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.newFile);
    assert.ok(name, "新建文件 did not open a name field");
    await act(async () => { name.props.onChange({ target: { value: "notes.md" } }); });
    await act(async () => {
      const confirm = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === TEXT.settings.skills.uploadDialog.confirm);
      assert.ok(confirm);
      confirm.props.onClick();
    });
    await settle();

    const write = stub.calls.find((call) => call.path === "/api/skills/review/files/notes.md");
    assert.ok(write, "the created file was not written");
    assert.deepEqual(json(write), { content: "", expectedRevision: 1 });
    // The new file stays selected, so its body is the empty draft the next
    // save will carry.
    assert.equal(textareaWithLabel(view, TEXT.settings.skills.editor.content).props.value, "");
  } finally { await act(async () => { view.unmount() }); }
});

test("an upload that is not a text file is refused before any write", async () => {
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(detail)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" });
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();

    const picker = view.root.findAllByType("input").find((node) => node.props.type === "file");
    assert.ok(picker, "the tree has no upload picker");
    const file = new File(["png"], "logo.png");
    await act(async () => { picker.props.onChange({ target: { files: [file], value: "" } }); });
    await settle();

    assert.ok(JSON.stringify(view.toJSON()).includes(TEXT.settings.skills.editor.uploadNotText("logo.png")));
    assert.equal(stub.calls.some((call) => call.init.method === "PUT"), false,
      "a refused upload still wrote to the package");
  } finally { await act(async () => { view.unmount() }); }
});

test("renaming a package file from the editor sends the revision it read", async () => {
  const withResource: SkillDetail = {
    ...detail,
    resources: [{ hash: "h1", kind: "reference", path: "references/b.md", size: 3 }],
  };
  const renamed: SkillDetail = {
    ...withResource,
    currentRevision: 2,
    resources: [{ hash: "h1", kind: "reference", path: "references/c.md", size: 3 }],
  };
  const stub = new StubClient()
    .reply([skill])
    .reply({ backend: "jiuwenswarm", skills: [] })
    .reply(withResource)
    .reply({ content: "---\nname: review\n---\n\nReview carefully", revision: 1, skillId: "review" })
    .reply(renamed);
  const view = await mount(<SkillsSettings client={stub.asClient()} />);
  try {
    await openRowMenu(view, "review");
    await act(async () => { menuItem(view, TEXT.settings.skills.rowMenu.edit).props.onClick(); });
    await settle();

    await act(async () => {
      const edit = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.editPath("references/b.md"));
      assert.ok(edit, "the file row has no rename control");
      edit.props.onClick();
    });
    const field = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.editPath("references/b.md"));
    assert.ok(field, "the rename field did not open");
    await act(async () => { field.props.onChange({ target: { value: "c.md" } }); });
    await act(async () => {
      const confirm = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === TEXT.settings.skills.uploadDialog.confirm);
      assert.ok(confirm);
      confirm.props.onClick();
    });
    await settle();

    const write = stub.calls.find((call) => call.path === "/api/skills/review/files/references%2Fb.md/rename");
    assert.ok(write, "the rename was not sent");
    assert.deepEqual(json(write), { expectedRevision: 1, to: "references/c.md" });
    assert.ok(JSON.stringify(view.toJSON()).includes("c.md"), "the tree still shows the old name");
  } finally { await act(async () => { view.unmount() }); }
});

test("a double press on a package file renames it from the reading page", async () => {
  const rich: SkillDetail = {
    ...detail,
    resources: [{ hash: "h2", kind: "reference", path: "references/b.md", size: 30 }],
  };
  const renamed: SkillDetail = {
    ...rich,
    resources: [{ hash: "h2", kind: "reference", path: "references/c.md", size: 30 }],
  };
  const stub = new StubClient().reply(rich).reply(renamed).reply(renamed);
  const view = await mount(
    <SkillDetailView
      client={stub.asClient()}
      onBack={() => {}}
      onDelete={() => {}}
      onEdit={() => {}}
      onToggle={() => {}}
      skillId="review"
      switchesAvailable={false}
    />,
  );
  try {
    await settle();
    await act(async () => {
      const tab = view.root.findAllByType("button")
        .find((node) => node.children.includes(TEXT.settings.skills.tabs.files));
      assert.ok(tab);
      tab.props.onClick();
    });
    const row = view.root.findAllByType("button").find((node) => textUnder(node) === "b.md");
    assert.ok(row, "the tree has no b.md row");
    await act(async () => { row.props.onDoubleClick(); });
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.editor.editPath("references/b.md"));
    assert.ok(input, "double press did not open a rename field");
    await act(async () => { input.props.onChange({ target: { value: "c.md" } }); });
    await act(async () => { input.props.onKeyDown({ key: "Enter" }); });
    await settle();
    const write = stub.calls.find((call) => call.path.includes("/rename"));
    assert.equal(write?.path, "/api/skills/review/files/references%2Fb.md/rename");
    assert.deepEqual(json(write!), { expectedRevision: 1, to: "references/c.md" });
    assert.match(JSON.stringify(view.toJSON()), /c\.md/u);
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
