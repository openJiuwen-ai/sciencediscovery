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
import type { SkillDescriptor, Specialist } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { SpecialistForm } from "../src/views/settings/system/SpecialistForm.js";
import { json, StubClient } from "./api-stub.js";
import { act, create, type ReactTestInstance, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

// The settings modal registers an Escape listener on the document, which this
// renderer does not provide.
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
  addEventListener() {}, removeEventListener() {},
} });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

const copy = TEXT.settings.system.specialists;

const valid: SkillDescriptor = {
  description: "审阅初稿",
  hash: "hash-1",
  id: "draft-review",
  name: "初稿审阅",
  readOnly: false,
  source: "managed",
} as SkillDescriptor;

const failed: SkillDescriptor = {
  description: "Failed to load: SKILL.md frontmatter is invalid YAML",
  hash: "",
  id: "idea-tree-team",
  loadFailure: { code: "SKILL_VALIDATION", message: "SKILL.md frontmatter is invalid YAML" },
  name: "idea-tree-team",
  readOnly: true,
  source: "built-in",
} as SkillDescriptor;

/** A saved specialist that was written before its bundled package broke. */
const saved: Specialist = {
  connectorIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  description: "审阅初稿",
  enabledSkillIds: [failed.id, valid.id],
  id: "spec-1",
  instructions: "先读再评。",
  name: "审稿人",
  runtime: { kind: "native" },
  updatedAt: "2026-01-01T00:00:00.000Z",
};

async function mount(node: React.ReactElement): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(node); });
  assert.ok(view);
  return view;
}

async function press(node: ReactTestInstance): Promise<void> {
  await act(async () => { node.props.onClick(); });
}

function buttonWithText(view: ReactTestRenderer, label: string): ReactTestInstance {
  const found = view.root.findAllByType("button").find((node) => (
    Array.isArray(node.children) ? node.children.includes(label) : node.children === label
  ));
  assert.ok(found, `no button reading "${label}"`);
  return found;
}

/** The skills tab of the picker, which renders over the form's own tablist. */
function pickerSkillsTab(view: ReactTestRenderer): ReactTestInstance {
  const tablists = view.root.findAll((node) => node.props.role === "tablist");
  const picker = tablists[tablists.length - 1];
  assert.ok(picker, "the picker has no tablist");
  assert.equal(tablists.length, 2, "the picker is not rendered over the form");
  const skillTab = picker.findAllByType("button")[0];
  assert.ok(skillTab, "the picker has no 技能 tab");
  return skillTab;
}

function tabCount(tab: ReactTestInstance): string {
  const count = tab.findAllByType("span").find((node) => (
    String(node.props.className ?? "").includes("settings-ability-tab-count")
  ));
  assert.ok(count, "the tab has no count");
  return count.children.join("");
}

test("the picker drops a saved package the catalog reports as failed and 添加 keeps it out", async () => {
  const stub = new StubClient().reply(saved);
  const view = await mount(
    <SpecialistForm
      client={stub.asClient()}
      connectors={[]}
      onCancel={() => {}}
      onSaved={() => {}}
      skills={[failed, valid]}
      specialist={saved}
    />,
  );

  // Both ids are saved on the record, so the form's chips show both.
  for (const skill of [failed, valid]) {
    assert.equal(
      view.root.findAll((node) => node.props["aria-label"] === `${copy.remove} ${skill.name}`).length,
      1,
      `the form does not show the saved chip for ${skill.id}`,
    );
  }

  await press(view.root.findAllByType("button").find((node) => (
    String(node.props.className ?? "").includes("settings-ability-add")
  ))!);

  // The 技能 tab of the picker must count only the capability 添加 can write;
  // a failed bundled id would be rejected by the service on save with
  // `Specialist skills are unavailable: <id>`.
  assert.equal(tabCount(pickerSkillsTab(view)), "1", "the picker counts the failed package as selected");

  await press(buttonWithText(view, copy.addSelected));

  assert.equal(
    view.root.findAll((node) => node.props["aria-label"] === `${copy.remove} ${failed.name}`).length,
    0,
    "添加 wrote the failed package back into the specialist",
  );
  assert.equal(
    view.root.findAll((node) => node.props["aria-label"] === `${copy.remove} ${valid.name}`).length,
    1,
    "添加 dropped the valid package",
  );

  // Saving proves the applied list, not only the rendered chips.
  await press(buttonWithText(view, TEXT.settings.system.save));
  await act(async () => { await Promise.resolve(); });
  assert.equal(stub.calls.length, 1, "the save was not sent");
  assert.equal(stub.calls[0].path, `/api/specialists/${saved.id}`);
  assert.deepEqual(
    (json(stub.calls[0]) as { enabledSkillIds: string[] }).enabledSkillIds,
    [valid.id],
    "the save body still names the failed package",
  );
});
