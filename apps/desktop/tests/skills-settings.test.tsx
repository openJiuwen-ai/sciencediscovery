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
const noChange = () => {};
const text = (view: ReactTestRenderer) => JSON.stringify(view.toJSON());

async function mount(client: ApiClient): Promise<ReactTestRenderer> {
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(<SkillsSettings adding client={client} onAddingChange={noChange} />); });
  assert.ok(view);
  return view;
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
      stub.reply([skill]);
      if (backend === "native") stub.reply({ backend: "native", skills: [] });
      else stub.fail(new Error("skill adapter unavailable"));
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
    await act(async () => {
      const onSaved = view.root.findByType(SkillForm).props.onSaved;
      assert.ok(typeof onSaved === "function");
      await onSaved(detail);
    });
    assert.match(text(view), /first enable refused/);
    assert.ok(view.root.findAllByProps({ role: "alert" }).length > 0);
  } finally { await act(async () => { view.unmount(); }); }
});
