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
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { ModelProfile } from "../src/api/types.js";
import type { WorkspaceActions, WorkspaceState } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { SystemSettingsDialog } from "../src/views/SystemSettingsDialog.js";
import { ModelSettings } from "../src/views/settings/ModelSettings.js";
import { McpServers } from "../src/views/settings/system/McpServers.js";
import { SpecialistsSettings } from "../src/views/settings/system/Specialists.js";
import { TimeoutSettings } from "../src/views/settings/system/Timeouts.js";
import { StubClient } from "./api-stub.js";

const noop = () => {};
const client = new StubClient().asClient();
const actions = {
  confirmAction: noop,
  refreshCatalog: async () => {},
  setDefaultModel: async () => {},
  toast: noop,
} as unknown as WorkspaceActions;

function profile(id: string, name: string, model: string): ModelProfile {
  return { id, model, name } as unknown as ModelProfile;
}

function state(over: Partial<WorkspaceState> = {}): WorkspaceState {
  return {
    models: [],
    presets: [],
    providers: [],
    ...over,
  } as unknown as WorkspaceState;
}

describe("the model list", () => {
  it("marks exactly one default and offers to change it on the others", () => {
    const markup = renderToStaticMarkup(
      <ModelSettings
        actions={actions}
        adding={false}
        client={client}
        onAddingChange={noop}
        state={state({
          defaultModelId: "m1",
          models: [
            profile("m1", "自定义网关 · DeepSeek", "deepseek-chat"),
            profile("m2", "Qwen", "qwen-max"),
          ],
        })}
      />,
    );

    assert.ok(markup.includes("deepseek-chat"));
    assert.ok(markup.includes("qwen-max"));
    // 主模型 is also a substring of 设为主模型, so count the tag itself.
    assert.equal(markup.split(`settings-tag is-primary">${TEXT.settings.model.default}<`).length - 1, 1);
    // The default row has no 设为主模型; the other one does.
    assert.equal(markup.split(TEXT.settings.model.setDefault).length - 1, 1);
    assert.equal(markup.split(`aria-label="${TEXT.settings.model.test}"`).length - 1, 2);
  });

  it("draws the row's delete as a live control rather than a placeholder", () => {
    const markup = renderToStaticMarkup(
      <ModelSettings
        actions={actions}
        adding={false}
        client={client}
        onAddingChange={noop}
        state={state({ models: [profile("m1", "Qwen", "qwen-max")] })}
      />,
    );

    assert.equal(markup.split(`aria-label="${TEXT.settings.model.delete}"`).length - 1, 1);
    // Enabled: deletion exists now, so the row must not keep pointing at a
    // route the service does not have. The confirmation it raises is a
    // pointer-and-keyboard path; `settings-interactions.spec.ts` presses it.
    assert.doesNotMatch(markup, /aria-label="删除"[^>]*disabled=""/);
  });

  it("explains an empty catalog instead of showing an empty list", () => {
    const markup = renderToStaticMarkup(
      <ModelSettings
        actions={actions}
        adding={false}
        client={client}
        onAddingChange={noop}
        state={state()}
      />,
    );

    assert.ok(markup.includes(TEXT.settings.model.empty));
    assert.ok(!markup.includes("model-list"));
  });

  it("opens the add form in a modal when 添加模型 was pressed", () => {
    const markup = renderToStaticMarkup(
      <ModelSettings
        actions={actions}
        adding
        client={client}
        onAddingChange={noop}
        state={state()}
      />,
    );

    assert.match(markup, /role="dialog"/);
    assert.ok(markup.includes(TEXT.settings.model.add));
    assert.ok(markup.includes(TEXT.wizard.provider.baseUrl));
    assert.ok(markup.includes(TEXT.wizard.provider.apiKey));
    assert.ok(markup.includes(`>${TEXT.settings.model.save}</button>`));
  });
});

describe("the settings dialog", () => {
  const renderDialog = (group: Parameters<typeof SystemSettingsDialog>[0]["group"]) =>
    renderToStaticMarkup(
      <SystemSettingsDialog
        actions={actions}
        client={client}
        group={group}
        onClose={noop}
        onGroupChange={noop}
        state={state()}
      />,
    );

  it("carries the whole directory and marks the group being shown", () => {
    const markup = renderDialog("models");

    assert.match(markup, /role="dialog"/);
    assert.ok(markup.includes(`aria-label="${TEXT.settings.system.title}"`));
    for (const category of Object.values(TEXT.settings.system.categories)) {
      assert.ok(markup.includes(category), `missing category ${category}`);
    }
    for (const group of Object.values(TEXT.settings.system.groups)) {
      assert.ok(markup.includes(group.label), `missing group ${group.label}`);
    }
    assert.match(markup, /aria-current="page"[^>]*class="active"/);
    assert.ok(markup.includes(TEXT.settings.model.add));
  });

  it("has no footer and no shared save, because every pane writes on its own press", () => {
    const markup = renderDialog("models");

    assert.ok(!markup.includes("settings-footer"));
    // A shared 保存 could only ever be disabled: nothing is staged to commit.
    assert.ok(!markup.includes(`>${TEXT.settings.system.save}</button>`));
    assert.ok(markup.includes(TEXT.settings.model.add));
  });

  it("shows 通用 before any data is read, because the preference is local", () => {
    const markup = renderDialog("general");

    assert.ok(markup.includes(TEXT.settings.general.language.field));
    // The picker shows the language in force; the other choice lives in the
    // menu it opens, not in the page.
    assert.ok(markup.includes(TEXT.settings.general.language.chinese));
    assert.ok(!markup.includes(TEXT.settings.loading));
  });

  it("gives a server-backed page its loading state on first paint", () => {
    const markup = renderDialog("timeouts");

    assert.ok(markup.includes(TEXT.settings.system.groups.timeouts.label));
    assert.ok(markup.includes(TEXT.settings.system.groups.timeouts.description));
    assert.ok(markup.includes(TEXT.settings.loading));
  });
});

describe("the server-backed settings panes", () => {
  it("MCP states what the page is for before its read answers", () => {
    const markup = renderToStaticMarkup(
      <McpServers
        adding={false}
        client={client}
        onAddingChange={noop}
        onConfirm={noop}
        onToast={noop}
      />,
    );

    // The explanation belongs to the page rather than to the data, so it is
    // there while the read is still running.
    assert.ok(markup.includes(TEXT.settings.system.mcp.help));
    assert.ok(markup.includes(TEXT.settings.loading));
    assert.ok(!markup.includes(TEXT.settings.system.mcp.empty));
  });

  it("专家 starts its read behind a loading gate", () => {
    const markup = renderToStaticMarkup(
      <SpecialistsSettings client={client} onConfirm={noop} />,
    );

    assert.ok(markup.includes("settings-section"));
    assert.ok(markup.includes(TEXT.settings.loading));
  });

  it("超时 starts its read behind a loading gate", () => {
    const markup = renderToStaticMarkup(<TimeoutSettings client={client} />);

    assert.ok(markup.includes("settings-section"));
    assert.ok(markup.includes(TEXT.settings.loading));
  });
});
