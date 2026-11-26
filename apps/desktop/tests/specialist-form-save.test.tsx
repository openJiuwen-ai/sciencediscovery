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

// What the form writes, not just what it renders: the two defects in #1438
// lived in the draft/body seam, where static markup cannot see them.

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import React from "react";

import type { SkillDescriptor, Specialist } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { SpecialistForm } from "../src/views/settings/system/SpecialistForm.js";
import { json, StubClient } from "./api-stub.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

// The modal registers a key listener when it mounts; this suite has no DOM.
(globalThis as { document?: unknown }).document = {
  addEventListener() {},
  removeEventListener() {},
};
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, value: true, writable: true });

const base: Specialist = {
  capabilityAccess: "specific",
  connectorIds: [],
  createdAt: "2026-01-01T00:00:00.000Z",
  description: "审阅初稿",
  enabledSkillIds: [],
  id: "spec-1",
  instructions: "先读再评。",
  name: "审稿人",
  updatedAt: "2026-01-01T00:00:00.000Z",
};

const codex: Specialist = {
  ...base,
  runtime: {
    execution: "direct",
    fallback: false,
    kind: "codex",
    model: "gpt-5",
    reasoningEffort: "high",
    timeoutSeconds: 120,
  },
};

async function mount(
  specialist: Specialist,
  options: { skills?: SkillDescriptor[] } = {},
): Promise<{ stub: StubClient; view: ReactTestRenderer }> {
  const stub = new StubClient().reply({ ...specialist });
  let view: ReactTestRenderer;
  await act(async () => {
    view = create(
      <SpecialistForm
        client={stub.asClient()}
        connectors={[]}
        onCancel={() => {}}
        onSaved={() => {}}
        skills={options.skills ?? []}
        specialist={specialist}
      />,
    );
  });
  return { stub, view };
}

function input(view: ReactTestRenderer, value: string) {
  return view.root.findAllByType("input").find((node) => node.props.value === value);
}

function saveButton(view: ReactTestRenderer) {
  return view.root.findAllByType("button").find((node) => node.props.className === "primary-button");
}

async function save(view: ReactTestRenderer, stub: StubClient): Promise<void> {
  const button = saveButton(view);
  assert.ok(button, "保存 is missing");
  await act(async () => { (button.props.onClick as () => void)(); });
  for (let attempt = 0; attempt < 10 && stub.calls.length === 0; attempt += 1) {
    // The click starts an async save; these turns let its promise settle.
    await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
  }
  assert.equal(stub.calls.length, 1, "the form did not write");
}

describe("the Specialist form's saved body", () => {
  it("round-trips specific with nothing selected instead of full access", async () => {
    const { stub, view } = await mount(base);
    try {
      await save(view, stub);
      const body = json(stub.calls[0]!) as Record<string, unknown>;
      assert.equal(body.capabilityAccess, "specific", "an empty selection was collapsed to full access");
      assert.deepEqual(body.connectorIds, []);
      assert.deepEqual(body.enabledSkillIds, []);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("omits runtime when a name-only edit did not touch kind or model", async () => {
    const { stub, view } = await mount(codex);
    try {
      const name = input(view, base.name);
      assert.ok(name, "the name field is missing");
      await act(async () => { name.props.onChange({ target: { value: "审稿人（改名）" } }); });
      await save(view, stub);
      const body = json(stub.calls[0]!) as Record<string, unknown>;
      assert.equal(body.name, "审稿人（改名）");
      assert.equal("runtime" in body, false, "an untouched runtime must not be rewritten");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("keeps an all-mode role's own lists on a name-only edit", async () => {
    const available = { description: "Still installed", id: "code-engineer", name: "Code engineer" } as SkillDescriptor;
    const allWithLists: Specialist = {
      ...base,
      capabilityAccess: "all",
      connectorIds: ["pubmed"],
      enabledSkillIds: ["code-engineer"],
    };
    const { stub, view } = await mount(allWithLists, { skills: [available] });
    try {
      const name = input(view, base.name);
      assert.ok(name, "the name field is missing");
      await act(async () => { name.props.onChange({ target: { value: "审稿人（改名）" } }); });
      await save(view, stub);
      const body = json(stub.calls[0]!) as Record<string, unknown>;
      assert.equal(body.capabilityAccess, "all");
      assert.deepEqual(body.connectorIds, ["pubmed"], "full access lost the role's own connector");
      assert.deepEqual(body.enabledSkillIds, ["code-engineer"], "full access lost the role's own skill");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("repairs an unavailable skill in an all-mode role before saving", async () => {
    const available = { description: "Still installed", id: "code-engineer", name: "Code engineer" } as SkillDescriptor;
    const allWithStale: Specialist = {
      ...base,
      capabilityAccess: "all",
      connectorIds: ["pubmed"],
      enabledSkillIds: ["removed-skill", "code-engineer"],
    };
    const { stub, view } = await mount(allWithStale, { skills: [available] });
    try {
      const repair = view.root.findAllByType("button")
        .find((node) => node.props["aria-label"] === `${TEXT.settings.system.specialists.remove} removed-skill`);
      assert.ok(repair, "the unavailable skill has no repair control");
      assert.equal(saveButton(view)?.props.disabled, true, "保存 accepted a stale skill id");
      await act(async () => { repair.props.onClick(); });
      assert.equal(saveButton(view)?.props.disabled, false, "removing the stale skill did not unlock 保存");
      await save(view, stub);
      const body = json(stub.calls[0]!) as Record<string, unknown>;
      assert.equal(body.capabilityAccess, "all");
      assert.deepEqual(body.connectorIds, ["pubmed"], "repairing a skill lost the role's connector");
      assert.deepEqual(body.enabledSkillIds, ["code-engineer"], "the remaining skill was not saved");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("clears the lists only when the user explicitly switches to full access", async () => {
    const specificWithLists: Specialist = {
      ...base,
      connectorIds: ["pubmed"],
      enabledSkillIds: ["code-engineer"],
    };
    const { stub, view } = await mount(specificWithLists);
    try {
      const fullAccess = view.root.findAllByType("input")
        .find((node) => node.props.type === "radio" && node.props.name === "specialist-capability-access");
      assert.ok(fullAccess, "the 完全访问 radio is missing");
      await act(async () => { fullAccess.props.onChange(); });
      await save(view, stub);
      const body = json(stub.calls[0]!) as Record<string, unknown>;
      assert.equal(body.capabilityAccess, "all");
      assert.deepEqual(body.connectorIds, []);
      assert.deepEqual(body.enabledSkillIds, []);
    } finally {
      await act(async () => { view.unmount(); });
    }
  });

  it("clearing the model keeps the other advanced runtime options", async () => {
    const { stub, view } = await mount(codex);
    try {
      const model = input(view, "gpt-5");
      assert.ok(model, "the model field is missing");
      await act(async () => { model.props.onChange({ target: { value: "" } }); });
      await save(view, stub);
      const body = json(stub.calls[0]!) as { runtime?: Record<string, unknown> };
      assert.deepEqual(body.runtime, {
        execution: "direct",
        fallback: false,
        kind: "codex",
        reasoningEffort: "high",
        timeoutSeconds: 120,
      }, "clearing the model dropped more than the model");
    } finally {
      await act(async () => { view.unmount(); });
    }
  });
});
