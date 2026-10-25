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
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { Project } from "@sciencediscovery/schema";
import { ProjectDescriptionEditor } from "../src/ProjectDescriptionEditor.js";
import { LocaleProvider } from "../src/i18n/index.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const project: Project = { id: "project-a", name: "Project A", createdAt: "2026-10-25", description: "Original research", remoteRunnerHostIds: [], settingsOverrides: {} };

function button(renderer: ReactTestRenderer, label: string) {
  return renderer.root.findAllByType("button").find((item) => item.children.includes(label))!;
}

async function submit(renderer: ReactTestRenderer) {
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
}

test("project description preview is localized and absent descriptions have no preview text", () => {
  const html = renderToStaticMarkup(createElement(ProjectDescriptionEditor, { project, onSave: async () => {} }));
  assert.match(html, /Original research/);
  assert.match(html, /Edit description/);
  assert.doesNotMatch(html, /textarea/);
  const empty = renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" },
    createElement(ProjectDescriptionEditor, { project: { ...project, description: undefined }, onSave: async () => {} })));
  assert.match(empty, /添加描述/);
  assert.doesNotMatch(empty, /project-description-text/);
});

test("description editing cancels drafts, saves trimmed text and sends an explicit blank to clear", async (context) => {
  const saved: string[] = [];
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ProjectDescriptionEditor, { project, onSave: async (value) => { saved.push(value); } })); });
  context.after(async () => { await act(async () => renderer.unmount()); });
  await act(async () => button(renderer, "Edit description").props.onClick());
  assert.equal(renderer.root.findByType("textarea").props.value, project.description);
  assert.equal(renderer.root.findByType("textarea").props.maxLength, 2000);
  await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Discard me" } }));
  await act(async () => button(renderer, "Cancel").props.onClick());
  assert.deepEqual(saved, []);
  for (const [draft, expected] of [["  Updated RNA-seq note  ", "Updated RNA-seq note"], ["  \n\t  ", ""]]) {
    await act(async () => button(renderer, "Edit description").props.onClick());
    assert.equal(renderer.root.findByType("textarea").props.value, project.description);
    await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: draft } }));
    await submit(renderer);
    assert.equal(saved.at(-1), expected);
    assert.equal(renderer.root.findAllByType("textarea").length, 0);
  }
});

test("failed description save retains the draft and permits retry", async (context) => {
  let attempts = 0;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ProjectDescriptionEditor, { project, onSave: async () => {
    if (++attempts === 1) throw new Error("Save unavailable");
  } })); });
  context.after(async () => { await act(async () => renderer.unmount()); });
  await act(async () => button(renderer, "Edit description").props.onClick());
  await act(async () => renderer.root.findByType("textarea").props.onChange({ target: { value: "Keep this draft" } }));
  await submit(renderer);
  assert.equal(renderer.root.findByProps({ role: "alert" }).findByType("small").children.join(""), "Save unavailable");
  assert.equal(renderer.root.findByType("textarea").props.value, "Keep this draft");
  assert.equal(button(renderer, "Save description").props.disabled, false);
  await submit(renderer);
  assert.equal(attempts, 2);
  assert.equal(renderer.root.findAllByType("textarea").length, 0);
});
