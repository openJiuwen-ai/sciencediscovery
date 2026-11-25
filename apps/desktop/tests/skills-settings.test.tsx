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
import { StubClient, json } from "./api-stub.js";
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

test("the tabs split the catalog by origin and narrow the grid", async () => {
  const mine = { ...skill, id: "mine", name: "mine", description: "Mine to keep." };
  const official = {
    ...skill, id: "official", name: "official", description: "Ships with the app.", source: "built-in" as const,
  };
  const stub = new StubClient().reply([mine, official]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(stub.asClient());
  try {
    const markup = text(view);
    assert.ok(markup.includes(TEXT.settings.skills.tabs.all(2)), "全部技能 does not count both");
    assert.ok(markup.includes(TEXT.settings.skills.tabs.mine(1)), "我的技能 does not count the managed package");
    assert.ok(markup.includes(TEXT.settings.skills.tabs.official(1)), "官方技能 does not count the built-in");
    const officialTab = view.root.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.tabs.official(1)));
    assert.ok(officialTab, "the 官方技能 tab is not a button");
    await act(async () => { officialTab.props.onClick(); });
    const selected = view.root.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.tabs.official(1)));
    assert.equal(selected?.props["aria-selected"], true, "the pressed tab is not the selected one");
    assert.match(text(view), /Ships with the app/);
    assert.ok(!text(view).includes("Mine to keep"), "a managed package stayed under 官方技能");
    const mineTab = view.root.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.tabs.mine(1)));
    assert.ok(mineTab);
    await act(async () => { mineTab.props.onClick(); });
    assert.match(text(view), /Mine to keep/);
    assert.ok(!text(view).includes("Ships with the app"), "a built-in stayed under 我的技能");
  } finally { await act(async () => { view.unmount(); }); }
});

test("the search field narrows the installed list by name only", async () => {
  const other = { ...skill, id: "draft", name: "draft", description: "A different package." };
  const stub = new StubClient().reply([skill, other]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(stub.asClient());
  try {
    assert.match(text(view), /Review a draft/);
    assert.match(text(view), /A different package/);
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.search);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: "draft" } }); });
    assert.match(text(view), /A different package/);
    assert.ok(!text(view).includes("Review a draft"), "the non-matching row stayed");
    // A word that appears only in a description is not a match: the search is
    // for the name the reader remembers, not for prose inside the package.
    await act(async () => { input.props.onChange({ target: { value: "different" } }); });
    assert.ok(!text(view).includes("A different package"), "a description-only match stayed");
    assert.match(text(view), new RegExp(TEXT.settings.skills.noMatches));
  } finally { await act(async () => { view.unmount(); }); }
});

test("a bulk action covers the tab on screen, not every package on the machine", async () => {
  const mine = { ...skill, id: "mine", name: "mine", description: "Mine to keep." };
  const official = {
    ...skill, id: "official", name: "official", description: "Ships with the app.", source: "built-in" as const,
  };
  const page = {
    backend: "jiuwenswarm",
    skills: [installedSkill("mine"), installedSkill("official")],
  };
  const stub = new StubClient().reply([mine, official]).reply(page);
  const view = await mount(stub.asClient());
  try {
    const mineTab = view.root.findAllByType("button")
      .find((node) => node.children.includes(TEXT.settings.skills.tabs.mine(1)));
    assert.ok(mineTab, "the 我的技能 tab is not a button");
    await act(async () => { mineTab.props.onClick(); });
    stub.reply({ enabled: false, results: [] }).reply([mine, official]).reply(page);
    await act(async () => { bulkButton(view, TEXT.settings.disableAll).props.onClick(); });
    const writes = stub.calls.filter((call) => call.init.method === "PUT");
    assert.equal(writes.length, 1);
    const body = json(writes[0]!) as { enabled: boolean; targets: Array<Record<string, unknown>> };
    assert.equal(body.enabled, false);
    // 我的技能 shows one card, so the batch carries one target.
    assert.deepEqual(body.targets, [{ skillId: "mine", name: "mine" }]);
  } finally { await act(async () => { view.unmount(); }); }
});

test("a match is marked in the name and the clear control restores the list", async () => {
  const other = { ...skill, id: "draft", name: "draft", description: "A different package." };
  const stub = new StubClient().reply([skill, other]).reply({ backend: "jiuwenswarm", skills: [] });
  const view = await mount(stub.asClient());
  try {
    const input = view.root.findAllByType("input")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.search);
    assert.ok(input);
    await act(async () => { input.props.onChange({ target: { value: "dra" } }); });
    const marks = view.root.findAllByType("mark");
    assert.equal(marks.length, 1, "the matched run is not marked");
    assert.deepEqual(marks[0]?.children, ["dra"]);
    const clear = view.root.findAllByType("button")
      .find((node) => node.props["aria-label"] === TEXT.settings.skills.clearSearch);
    assert.ok(clear, "the search field has no clear control");
    await act(async () => { clear.props.onClick(); });
    assert.match(text(view), /Review a draft/);
    assert.equal(view.root.findAllByType("mark").length, 0, "a mark survived the clear");
  } finally { await act(async () => { view.unmount(); }); }
});

test("a refused switch on a package's page is explained there", async () => {
  const page = {
    backend: "jiuwenswarm" as const,
    skills: [installedSkill("review")],
  };
  const stub = new StubClient().reply([skill]).reply(page).reply(detail);
  const view = await mount(stub.asClient());
  try {
    const card = view.root.findAllByType("button")
      .find((node) => node.props.className === "settings-card-main");
    assert.ok(card);
    await act(async () => { card.props.onClick(); });
    for (let tick = 0; tick < 4; tick += 1) {
      await act(async () => { await Promise.resolve(); });
    }
    assert.ok(text(view).includes("Review carefully"), "the package page did not load");
    stub.fail(new Error("switch refused")).reply([skill]).reply(page);
    await act(async () => { view.root.findAllByProps({ role: "switch" })[0]!.props.onClick(); });
    assert.match(text(view), /switch refused/);
    assert.ok(view.root.findAllByProps({ role: "alert" }).length > 0);
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

const installedSkill = (id: string, enabled = true, name = id) => ({
  name, skillId: id, enabled, description: `${id} skill`, source: "sciencediscovery",
});
const builtinSkill = (name: string, enabled = true) => ({
  name, enabled, description: `${name} skill`, source: "builtin",
});
const switchValues = (view: ReactTestRenderer) =>
  view.root.findAllByProps({ role: "switch" }).map((node) => node.props["aria-checked"]);
const bulkButton = (view: ReactTestRenderer, label: string) => {
  const found = view.root.findAllByType("button").find((node) => node.children.includes(label));
  assert.ok(found, `no ${label} button`);
  return found;
};

test("Disable all is one write for the whole page and every switch moves on the press", async () => {
  // The reported shape: 17 ScienceDiscovery skills and 14 JiuwenSwarm built-ins.
  const catalog = Array.from({ length: 17 }, (_, index) => ({ ...skill, id: `sd-${index}`, name: `sd-${index}` }));
  const installed = catalog.map((descriptor) => installedSkill(
    descriptor.id,
    true,
    // A name clash renames the import; the page still knows the name it is installed as.
    descriptor.id === "sd-3" ? "sciencediscovery-sd-3" : descriptor.id,
  ));
  const theirs = Array.from({ length: 14 }, (_, index) => builtinSkill(`jw-${index}`));
  const page = { backend: "jiuwenswarm", skills: [...installed, ...theirs] };
  const stub = new StubClient().reply(catalog).reply(page);
  const view = await mount(stub.asClient());
  try {
    assert.equal(switchValues(view).length, 31);
    // Queued before the click: the batch write is issued synchronously, and the
    // page then re-reads the list once to reconcile.
    stub.reply({ enabled: false, results: [] }).reply(catalog).reply(page);
    void act(() => { bulkButton(view, TEXT.settings.disableAll).props.onClick(); });
    // Still before the write settles: the intent, not the server, is on screen.
    assert.deepEqual(switchValues(view), Array(31).fill(false));
    const writes = stub.calls.filter((call) => call.init.method === "PUT");
    assert.equal(writes.length, 1, "one bulk write, not one per skill");
    assert.equal(writes[0]!.path, "/api/jiuwenswarm/skills-batch");
    const body = json(writes[0]!) as { enabled: boolean; targets: Array<Record<string, unknown>> };
    assert.equal(body.enabled, false);
    assert.equal(body.targets.length, 31);
    assert.deepEqual(body.targets[3], { skillId: "sd-3", name: "sciencediscovery-sd-3" });
    assert.deepEqual(body.targets[17], { name: "jw-0" });
    assert.equal(stub.calls.some((call) => call.path.includes("skills-by-id")), false);
    await act(async () => {});
    // Mount read the list once; the bulk action read it once more. No per-skill read.
    assert.equal(stub.calls.filter((call) => call.path === "/api/jiuwenswarm/skills").length, 2);
    assert.deepEqual(switchValues(view), Array(31).fill(false));
  } finally { await act(async () => { view.unmount(); }); }
});

test("row switches wait for the bulk write instead of racing it", async () => {
  const alpha = { ...skill, id: "alpha", name: "alpha" };
  const page = { backend: "jiuwenswarm", skills: [installedSkill("alpha")] };
  const stub = new StubClient().reply([alpha]).reply(page);
  const view = await mount(stub.asClient());
  try {
    stub.reply({ enabled: false, results: [{ name: "alpha", ok: true }] }).reply([alpha]).reply({
      backend: "jiuwenswarm",
      skills: [installedSkill("alpha", false)],
    });
    void act(() => { bulkButton(view, TEXT.settings.disableAll).props.onClick(); });
    // The intent is on screen before the write settles, and the row is closed
    // to a second write until the list read reconciles it.
    assert.deepEqual(switchValues(view), [false]);
    assert.equal(view.root.findAllByProps({ role: "switch" })[0]!.props.disabled, true);
    await act(async () => {});
    assert.equal(view.root.findAllByProps({ role: "switch" })[0]!.props.disabled, false);
  } finally { await act(async () => { view.unmount(); }); }
});

test("a refused row in a bulk action goes back while the accepted rows keep the intent", async () => {
  const first = { ...skill, id: "alpha", name: "alpha" };
  const second = { ...skill, id: "beta", name: "beta" };
  const theirs = builtinSkill("xlsx");
  const page = {
    backend: "jiuwenswarm",
    skills: [installedSkill("alpha"), installedSkill("beta"), theirs],
  };
  const stub = new StubClient().reply([first, second]).reply(page);
  const view = await mount(stub.asClient());
  try {
    assert.deepEqual(switchValues(view), [true, true, true]);
    stub.reply({
      enabled: false,
      results: [
        { skillId: "alpha", name: "alpha", ok: true },
        { skillId: "beta", name: "beta", ok: true },
        { name: "xlsx", ok: false, error: "JiuwenSwarm refused" },
      ],
    }).reply([first, second]).reply({
      backend: "jiuwenswarm",
      skills: [installedSkill("alpha", false), installedSkill("beta", false), theirs],
    });
    await act(async () => { bulkButton(view, TEXT.settings.disableAll).props.onClick(); });
    assert.deepEqual(switchValues(view), [false, false, true], "only the refused row is back");
    assert.match(text(view), /xlsx: JiuwenSwarm refused/);
  } finally { await act(async () => { view.unmount(); }); }
});

test("a single switch moves on the press and returns when JiuwenSwarm refuses it", async () => {
  const alpha = { ...skill, id: "alpha", name: "alpha" };
  const page = { backend: "jiuwenswarm", skills: [installedSkill("alpha")] };
  const stub = new StubClient().reply([alpha]).reply(page);
  const view = await mount(stub.asClient());
  try {
    stub.fail(new Error("switch refused")).reply([alpha]).reply(page);
    void act(() => { view.root.findAllByProps({ role: "switch" })[0]!.props.onClick(); });
    assert.deepEqual(switchValues(view), [false]);
    assert.equal(view.root.findAllByProps({ role: "switch" })[0]!.props.disabled, true);
    await act(async () => {});
    assert.deepEqual(switchValues(view), [true], "the refused value is not left on screen");
    assert.match(text(view), /switch refused/);
    const write = stub.calls.find((call) => call.path.includes("skills-by-id"));
    assert.equal(write?.path, "/api/jiuwenswarm/skills-by-id/alpha");
    assert.deepEqual(json(write!), { enabled: false });
  } finally { await act(async () => { view.unmount(); }); }
});
