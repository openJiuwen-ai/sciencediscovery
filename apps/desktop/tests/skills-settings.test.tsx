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
import type { ApiClient } from "../src/api/client.js";
import type { SkillDescriptor, SkillDetail } from "../src/api/types.js";
import { SkillForm } from "../src/views/settings/SkillForm.js";
import { SkillsSettings } from "../src/views/settings/SkillsSettings.js";
import { TEXT } from "../src/text.js";
import { StubClient } from "./api-stub.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
const skill: SkillDescriptor = {
  id: "review", name: "review", description: "Review a draft", source: "managed",
  currentRevision: 1, diagnostics: [], hash: "hash", readOnly: false, version: "revision:1",
  resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
};
const detail: SkillDetail = { ...skill, instructions: "Review carefully", frontmatter: {}, resources: [] };
// Modal keyboard listeners are outside these component-state checks.
Object.defineProperty(globalThis, "document", { configurable: true, writable: true, value: {
  addEventListener() {}, removeEventListener() {},
} });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });
const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

async function mount(client: ApiClient): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(<SkillsSettings client={client} />); });
  assert.ok(view);
  return view;
}

/**
 * The authoring form is a page of 技能 now, so the tests that drive its
 * `onSaved` reach it the way a user does: 添加技能, then 从零开始写.
 */
/** A card now opens its own page; the list's controls live behind the back
 *  control above every page below it. */
async function backToList(view: ReactTestRenderer): Promise<void> {
  await act(async () => {
    const back = view.root.findAllByType("button")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.backToList);
    assert.ok(back, "the page has no back control");
    back.props.onClick();
  });
}

async function openAuthoringForm(view: ReactTestRenderer): Promise<void> {
  await act(async () => {
    const trigger = view.root.findAllByType("button")
      .find((node) => node.props.className?.includes?.("skill-add-trigger"));
    assert.ok(trigger, "the list has no 添加技能");
    trigger.props.onClick();
  });
  await act(async () => {
    const item = view.root.findAllByType("button").find((node) => node
      .findAllByType("strong")
      .some((label) => label.children.includes(TEXT.settings.skills.addMenu.scratch)));
    assert.ok(item, "添加技能 does not offer 从零开始写");
    item.props.onClick();
  });
  assert.ok(view.root.findByType(SkillForm), "从零开始写 did not open the authoring form");
}

for (const backend of ["native", "unavailable"] as const) {
  test(`Skills catalog remains readable and creatable with ${backend} switches`, async () => {
    const stub = new StubClient().reply([skill]);
    if (backend === "native") stub.reply({ backend: "native", skills: [] });
    else stub.fail(new Error("skill adapter unavailable"));
    const client = stub.asClient();
    const view = await mount(client);
    try {
      assert.match(text(view), /Review a draft/);
      assert.ok(text(view).includes(backend === "native" ? TEXT.settings.skills.jiuwenSwarmOnly : "skill adapter unavailable"));
      const switches = view.root.findAllByProps({ role: "switch" });
      assert.equal(switches.length, 1);
      assert.equal(switches[0]?.props.disabled, true);
      stub.reply(detail);
      await act(async () => {
        const card = view.root.findAllByType("button").find((node) => node.props.className === "settings-card-main");
        assert.ok(card);
        const onClick = card.props.onClick;
        assert.ok(typeof onClick === "function");
        onClick();
      });
      assert.match(text(view), /Review carefully/);
      await backToList(view);
      stub.reply([skill]);
      if (backend === "native") stub.reply({ backend: "native", skills: [] });
      else stub.fail(new Error("skill adapter unavailable"));
      await openAuthoringForm(view);
      await act(async () => {
        const onSaved = view.root.findByType(SkillForm).props.onSaved;
        assert.ok(typeof onSaved === "function");
        await onSaved(detail);
      });
      assert.equal(stub.calls.some((call) => call.path.includes("skills-by-id")), false);
      assert.match(text(view), /Review a draft/);
      if (backend === "unavailable") {
        stub.reply([skill]).reply({ backend: "jiuwenswarm", skills: [] });
        await act(async () => {
          const retry = view.root.findAllByType("button").find((node) => node.children.includes(TEXT.settings.retry));
          assert.ok(retry);
          const onClick = retry.props.onClick;
          assert.ok(typeof onClick === "function");
          onClick();
        });
        assert.equal(view.root.findAllByProps({ role: "switch" })[0]?.props.disabled, false);
        assert.ok(!text(view).includes("skill adapter unavailable"));
      }
    } finally { await act(async () => { view.unmount(); }); }
  });
}

test("a failed first enable stays visible even when the refreshed catalog is empty", async () => {
  const stub = new StubClient().reply([]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(stub.asClient());
  try {
    stub.fail(new Error("first enable refused")).reply([]).reply({ backend: "jiuwenswarm", skills: [] });
    await openAuthoringForm(view);
    await act(async () => {
      const onSaved = view.root.findByType(SkillForm).props.onSaved;
      assert.ok(typeof onSaved === "function");
      await onSaved(detail);
    });
    assert.match(text(view), /first enable refused/);
    assert.ok(view.root.findAllByProps({ role: "alert" }).length > 0);
  } finally { await act(async () => { view.unmount(); }); }
});

test("the search field narrows the installed list", async () => {
  const other = { ...skill, id: "draft", name: "draft", description: "A different package." };
  const stub = new StubClient().reply([skill, other]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(stub.asClient());
  try {
    assert.match(text(view), /Review a draft/);
    assert.match(text(view), /A different package/);
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.search);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: "different" } }); });
    assert.match(text(view), /A different package/);
    assert.ok(!text(view).includes("Review a draft"), "the non-matching row stayed");
  } finally { await act(async () => { view.unmount(); }); }
});

test("bundled skills default on while saved disables and managed defaults remain off", async () => {
  const bundled = { ...skill, id: "evolve-design", source: "built-in" as const };
  const disabled = { ...skill, id: "literature-searcher", source: "built-in" as const };
  const saved = { name: disabled.id, skillId: disabled.id, enabled: false, source: "sciencediscovery" };
  const catalog = [bundled, disabled, skill];
  const stub = new StubClient().reply(catalog).reply({ backend: "jiuwenswarm", skills: [saved] });
  const view = await mount(stub.asClient());
  try {
    assert.deepEqual(view.root.findAllByProps({ role: "switch" }).map((node) => node.props["aria-checked"]), [true, false, false]);
    stub.reply({}).reply(catalog).reply({ backend: "jiuwenswarm", skills: [saved,
      { name: bundled.id, skillId: bundled.id, enabled: false, source: "sciencediscovery" },
    ] });
    await act(async () => {
      const toggle = view.root.findAllByProps({ role: "switch" })[0];
      assert.ok(toggle);
      toggle.props.onClick();
    });
    const write = stub.calls.find((call) => call.path.includes("skills-by-id"));
    assert.equal(write?.path, "/api/jiuwenswarm/skills-by-id/evolve-design");
    assert.deepEqual(JSON.parse(String(write?.init.body)), { enabled: false });
    assert.deepEqual(view.root.findAllByProps({ role: "switch" }).map((node) => node.props["aria-checked"]), [false, false, false]);
  } finally { await act(async () => { view.unmount(); }); }
});
