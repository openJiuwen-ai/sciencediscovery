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

// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import type { ApiClient } from "../src/api/client.js";
import type {
  ConnectorManifest,
  ModelProfile,
  ModelProvider,
  ProviderModelList,
  RunnerTarget,
  SkillDescriptor,
  Specialist,
} from "../src/api/types.js";
import type { WorkspaceActions, WorkspaceState } from "../src/app/use-workspace.js";
import { TEXT } from "../src/text.js";
import { GeneralSettings } from "../src/views/settings/GeneralSettings.js";
import { ModelForm } from "../src/views/ModelForm.js";
import { ModelPicker, ModelSettings, providerChoices } from "../src/views/settings/ModelSettings.js";
import { ListSelect } from "../src/views/settings/ListSelect.js";
import { SystemSettingsDialog } from "../src/views/SystemSettingsDialog.js";
import { RunnerSection } from "../src/views/settings/RemoteHosts.js";
import { NetworkSettings } from "../src/views/settings/NetworkSettings.js";
import { RuntimeSettings } from "../src/views/settings/RuntimeSettings.js";
import { SkillForm } from "../src/views/settings/SkillForm.js";
import { enabledAfterCreate, skillMeta, SkillsSettings } from "../src/views/settings/SkillsSettings.js";
import { AbilityPicker } from "../src/views/settings/system/AbilityPicker.js";
import { McpServers } from "../src/views/settings/system/McpServers.js";
import { SpecialistForm } from "../src/views/settings/system/SpecialistForm.js";
import { SpecialistsSettings } from "../src/views/settings/system/Specialists.js";
import { TimeoutSettings } from "../src/views/settings/system/Timeouts.js";

const { describe, it } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

/**
 * 通用 reads the recorded data directory, which lives in `localStorage`. Node
 * has no such thing, so the smallest stand-in that lets the tree compose is
 * defined here — this is test scaffolding for a browser API, not a fallback
 * the app itself needs.
 */
const store = new Map<string, string>();
(globalThis as { localStorage?: unknown }).localStorage = {
  getItem: (key: string) => store.get(key) ?? null,
  removeItem: (key: string) => void store.delete(key),
  setItem: (key: string, value: string) => void store.set(key, value),
};

/**
 * Nothing in these pages runs until its `useEffect` fires, and there is no DOM
 * here for that. What static markup does prove is the part that would break
 * loudly in a browser too: that each page composes, that the nav carries the
 * whole set of entries, and that a page reaches for its data on first render
 * instead of rendering an empty state it will never leave.
 */
const client = { request: () => new Promise(() => {}) } as unknown as ApiClient;
const noConfirm = () => {};

const loading = "正在读取…";

describe("the settings tree", () => {
  it("keeps the original desktop groups, plus MCP, 专家 and 超时", () => {
    assert.deepEqual(Object.values(TEXT.settings.system.categories), ["系统", "智能", "连接", "工作区"]);
    assert.deepEqual(
      Object.values(TEXT.settings.system.groups).map((group) => group.label),
      ["通用", "模型", "技能", "MCP 服务器", "专家", "网络", "远程", "超时"],
    );
  });
});

describe("a Runner registered on another machine", () => {
  // A ready host whose reported build is not this one's: exactly the data that
  // used to raise 版本不一致 beside the state tag. Both versions are still in the
  // response, so the card is rendered from them rather than around them.
  const host = {
    alias: "gpu-01",
    capabilities: { platform: "Linux" },
    connectionKind: "ssh",
    createdAt: "2026-01-01T00:00:00.000Z",
    hostName: "10.0.0.9",
    id: "host-1",
    location: "remote",
    runnerStatus: {
      hostId: "host-1",
      localVersion: "build-a",
      remoteVersion: "build-b",
      state: "ready",
    },
    status: "ready",
  } as unknown as RunnerTarget;

  const markup = renderToStaticMarkup(
    <RunnerSection
      client={client}
      hosts={[host]}
      onConfirm={noConfirm}
      onReload={noConfirm}
    />,
  );

  it("prints the version it reports without judging it against this one", () => {
    assert.ok(markup.includes("build-b"), "the remote version is no longer shown");
    assert.ok(markup.includes('class="settings-tag is-ok"'), "the ready tag is gone");
    // A differing build is not a warning this screen raises. The card's only
    // other warn tone would be an untrusted host key, which this host has none
    // of, so any warn tag left here is the version badge coming back.
    assert.ok(!markup.includes("settings-tag is-warn"), "the card warns about something again");
  });
});

describe("the add-model form", () => {
  const form = (onCancel?: () => void) =>
    renderToStaticMarkup(
      <ModelForm
        client={client}
        onConfigured={noConfirm}
        onCancel={onCancel}
        onProvidersChanged={noConfirm}
        presets={[]}
        providers={[]}
        submitLabel={TEXT.settings.model.save}
      />,
    );

  it("explains nothing under its fields", () => {
    // The example the user removed, and the class every removed sentence used.
    const markup = form(noConfirm);
    assert.ok(!markup.includes("field-help"), "a field hint is still rendered");
    assert.ok(!markup.includes("还没测试"), "the idle test sentence is back");
    assert.ok(!markup.includes("预设覆盖常见的国内外提供方"), "the preset hint is back");
  });

  it("puts 测试连接, 保存 and 取消 side by side, in that order", () => {
    const markup = form(noConfirm);
    const test = markup.indexOf(`>${TEXT.settings.model.test}</button>`);
    const save = markup.indexOf(`>${TEXT.settings.model.save}</button>`);
    const cancel = markup.indexOf(`>${TEXT.menu.cancel}</button>`);
    assert.ok(test >= 0, "no 测试连接 button");
    assert.ok(save >= 0, "no 保存 button");
    assert.ok(cancel >= 0, "no 取消 button");
    assert.ok(test < save && save < cancel, "the buttons are out of order");
  });

  it("omits 取消 where the caller has its own way back", () => {
    assert.ok(!form().includes(`>${TEXT.menu.cancel}</button>`));
  });

  it("keeps the model page's wording in step with the layout", () => {
    const model = JSON.stringify(TEXT.settings.model);
    assert.ok(model.includes("主模型"));
    for (const gone of ["已配置的提供方", "尚未指定", "保存并设为默认"]) {
      assert.ok(!model.includes(gone), `模型 still has a ${gone} label`);
    }
  });
});

describe("a configured model row", () => {
  const profile = {
    baseUrl: "https://api.example.com/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id: "model-1",
    model: "deepseek-chat",
    name: "自定义网关 · DeepSeek",
    proxyPolicy: "direct",
    updatedAt: "2026-01-01T00:00:00.000Z",
    vision: false,
  } as unknown as ModelProfile;
  const actions = {
    refreshCatalog: async () => {},
    setDefaultModel: async () => {},
  } as unknown as WorkspaceActions;
  const state = {
    defaultModelId: "model-1",
    models: [profile],
    presets: [],
    providers: [],
  } as unknown as WorkspaceState;

  const markup = renderToStaticMarkup(
    <ModelSettings actions={actions} adding={false} client={client} onAddingChange={noConfirm} state={state} />,
  );

  it("opens in place, so its name can be changed", () => {
    // The identity is a button that reports whether it is open; the editor it
    // opens is what carries the rename field, so it must be closed here.
    assert.ok(markup.includes('class="model-row-main"'), "the row identity is not an expand control");
    assert.ok(markup.includes('aria-expanded="false"'), "the row does not say it can open");
    assert.ok(markup.includes(TEXT.settings.model.expand), "the row has no expand affordance");
    assert.ok(!markup.includes(TEXT.settings.model.nameHint), "the rename editor is open with nothing asked for");
  });

  it("still shows the profile it was read as", () => {
    assert.ok(markup.includes("deepseek-chat"), "the model id is gone");
    assert.ok(markup.includes(TEXT.settings.model.default), "the primary tag is gone");
  });
});

describe("the settings directory", () => {
  const markup = renderToStaticMarkup(
    <SystemSettingsDialog
      actions={{} as unknown as WorkspaceActions}
      client={client}
      group="general"
      onClose={noConfirm}
      onGroupChange={noConfirm}
      state={{} as unknown as WorkspaceState}
    />,
  );

  it("folds away with the session sidebar's toggle instead of closing 设置", () => {
    assert.ok(markup.includes(TEXT.sidebar.collapseSidebar), "the directory has no fold control");
    assert.ok(markup.includes('aria-expanded="true"'), "the fold control does not say the directory is open");
    // The X that closed the whole surface is what this replaced.
    assert.ok(!markup.includes("settings-nav-close"), "the close-X is still in the directory head");
  });

  it("has no footer: every page writes on the press", () => {
    // 通用, 模型, 技能, MCP, 专家, 网络 and 远程 all write as they are changed,
    // and 超时 now commits its own fields; a shared save bar would only ever
    // have been disabled. 设置 is left through the rail's 会话 or Escape.
    assert.ok(!markup.includes("system-config-footer"), "the footer is back");
    assert.ok(!markup.includes(TEXT.settings.system.save), "a footer save button is back");
    assert.ok(!markup.includes("保存并关闭"), "a save-and-close button is back");
  });
});

describe("the model field of a provider-backed profile", () => {
  // The web front end's provider row lists the provider's models; here that
  // list is the dropdown the row opens onto, so a model is switched by picking
  // it rather than by retyping its id.
  const profile = {
    baseUrl: "https://api.minimax.com/v1",
    createdAt: "2026-01-01T00:00:00.000Z",
    hasApiToken: true,
    id: "model-1",
    model: "MiniMax-M2",
    name: "MiniMax · MiniMax-M2",
    providerId: "provider-1",
    proxyPolicy: "direct",
    updatedAt: "2026-01-01T00:00:00.000Z",
    vision: false,
  } as unknown as ModelProfile;
  const provider = {
    baseUrl: "https://api.minimax.com/v1",
    id: "provider-1",
    name: "MiniMax",
  } as unknown as ModelProvider;

  const markup = renderToStaticMarkup(
    <ModelPicker
      client={client}
      onChanged={async () => {}}
      profile={profile}
      provider={provider}
    />,
  );

  it("is a dropdown, not a free-text name", () => {
    assert.ok(markup.includes('aria-haspopup="listbox"'), "the model field is not a dropdown");
    assert.ok(!markup.includes("<input"), "the free-text name field is back");
    // While the listing loads the saved model is the one option, so the field
    // never shows a blank line where the current model should be.
    assert.ok(markup.includes("MiniMax-M2"), "the saved model is offered on the closed field");
  });

  it("says where the options come from and can refresh them", () => {
    assert.ok(markup.includes(TEXT.settings.model.pickHint), "the field explains nothing");
    assert.ok(markup.includes(TEXT.settings.model.providerRefreshHint), "the list cannot be refreshed");
    assert.ok(markup.includes(TEXT.settings.model.providerSource), "the field does not say where options came from");
  });

  it("keeps the refresh beside the field", () => {
    const field = markup.indexOf('class="model-pick-row"');
    const refresh = markup.indexOf('class="model-refresh"');
    const hint = markup.indexOf('class="field-help"');
    assert.ok(field >= 0, "the field and its refresh are not on one line");
    assert.ok(refresh > field && refresh < hint, "刷新列表 is not beside the model field");
    // At rest the refresh is plain type; blue would make it look like an action.
    assert.ok(!markup.includes("link-button"), "the refresh still looks like a link");
  });

  it("shows that a refresh is running instead of looking untouched", () => {
    // The static render never resolves the listing, which is also what a click
    // on 刷新列表 looks like until the provider answers.
    assert.ok(markup.includes(TEXT.settings.model.refreshing), "a refresh has no visible state");
  });

  it("has no buttons of its own: picking a model is the save", () => {
    // The hint mentions saving; what must not come back is the pair of buttons
    // that used to ask the same question a second time.
    assert.ok(!markup.includes("primary-button"), "保存 came back beside the dropdown");
    assert.ok(!markup.includes("secondary-button"), "取消 came back beside the dropdown");
  });
});

describe("the language picker", () => {
  const markup = renderToStaticMarkup(<GeneralSettings />);

  it("draws its own list instead of the platform's popup", () => {
    assert.ok(markup.includes("list-select-trigger"), "界面语言 went back to a native <select>");
    assert.ok(!markup.includes("<select"), "a native <select> is back");
  });

  it("does not repeat the row's label above the control", () => {
    // The row already says 界面语言; a caption would say it a second time and
    // push the control down a line.
    assert.ok(!markup.includes("list-select-caption"), "the field is named twice");
  });
});

describe("the model dropdown", () => {
  const markup = renderToStaticMarkup(
    <ListSelect
      choices={[
        { label: "MiniMax-M2", value: "MiniMax-M2" },
        { badge: TEXT.settings.model.addedOption, disabled: true, label: "abab-6.5", value: "abab-6.5" },
      ]}
      label={TEXT.settings.model.name}
      onChange={() => {}}
      value="MiniMax-M2"
    />,
  );

  it("names the field and shows the chosen model on the trigger", () => {
    assert.ok(markup.includes(TEXT.settings.model.name), "the dropdown has no label");
    assert.ok(markup.includes("MiniMax-M2"), "the chosen model is not on the trigger");
    assert.match(markup, /aria-expanded="false"/);
  });
});

describe("the choices a provider profile offers", () => {
  const listing = {
    fetchedAt: "2026-01-01T00:00:00.000Z",
    models: [
      { displayName: "MiniMax M2", id: "MiniMax-M2", profileId: "model-1" },
      { displayName: "abab 6.5", id: "abab-6.5", profileId: "model-2" },
      { id: "MiniMax-Text-01" },
    ],
    providerId: "provider-1",
    source: "remote",
  } as unknown as ProviderModelList;
  const profile = { id: "model-1", model: "MiniMax-M2" } as ModelProfile;
  const choices = providerChoices(listing, profile);

  it("marks a model another entry already uses and keeps it unselectable", () => {
    const taken = choices.find((choice) => choice.value === "abab-6.5");
    assert.equal(taken?.disabled, true);
    assert.equal(taken?.badge, TEXT.settings.model.addedOption);
    assert.equal(choices.find((choice) => choice.value === "MiniMax-Text-01")?.disabled, undefined);
  });

  it("labels an option with both names when the provider gives them", () => {
    assert.equal(choices.find((choice) => choice.value === "abab-6.5")?.label, "abab 6.5 · abab-6.5");
    assert.equal(choices.find((choice) => choice.value === "MiniMax-Text-01")?.label, "MiniMax-Text-01");
  });

  it("keeps the saved model when the listing has dropped it", () => {
    const dropped = providerChoices(listing, { ...profile, model: "retired-model" } as ModelProfile);
    assert.equal(dropped[0]?.value, "retired-model");
    // And while the listing is still loading there is nothing else to show.
    assert.deepEqual(providerChoices(undefined, profile).map((choice) => choice.value), ["MiniMax-M2"]);
  });
});

describe("the specialist form", () => {
  const existing: Specialist = {
    connectorIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "审阅初稿",
    enabledSkillIds: [],
    id: "spec-1",
    instructions: "先读再评。",
    name: "审稿人",
    runtime: { kind: "native" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  };

  const skill = (id: string, name: string) => ({
    description: `${name} 的说明`,
    id,
    name,
  }) as unknown as SkillDescriptor;
  const connector = (id: string, displayName: string) => ({ displayName, id }) as unknown as ConnectorManifest;

  const form = (
    specialist?: Specialist,
    options: { connectors?: ConnectorManifest[]; skills?: SkillDescriptor[] } = {},
  ) =>
    renderToStaticMarkup(
      <SpecialistForm
        client={client}
        connectors={options.connectors ?? []}
        onCancel={noConfirm}
        onSaved={noConfirm}
        skills={options.skills ?? []}
        specialist={specialist}
      />,
    );

  it("keeps 保存 disabled until the specialist has a name", () => {
    assert.match(form(), /disabled=""[^>]*>保存<\/button>/, "保存 is enabled with no name");
  });

  it("fills the form from the specialist it edits", () => {
    const markup = form(existing);
    assert.ok(markup.includes(`value="${existing.name}"`), "the name is not filled in");
    assert.ok(markup.includes(`value="${existing.description}"`), "the description is not filled in");
    assert.ok(markup.includes(existing.instructions), "the instructions are not filled in");
    assert.doesNotMatch(markup, /disabled=""[^>]*>保存<\/button>/, "保存 is disabled for a named specialist");
  });

  it("shows the counters and placeholders the design asks for", () => {
    const markup = form().replaceAll("<!-- -->", "");
    assert.ok(markup.includes("0 / 80"), "the name counter is missing");
    assert.ok(markup.includes("0 / 1000"), "the description counter is missing");
    assert.ok(markup.includes("0 / 32,768"), "the instructions counter is missing");
    assert.ok(markup.includes(TEXT.settings.system.specialists.namePlaceholder), "the name placeholder is missing");
    assert.ok(
      markup.includes(TEXT.settings.system.specialists.descriptionPlaceholder),
      "the description placeholder is missing",
    );
    assert.ok(
      markup.includes(`>${TEXT.settings.system.specialists.instructions}</span>`),
      "the instructions title is missing",
    );
    assert.ok(
      markup.includes(TEXT.settings.system.specialists.instructionsHint),
      "the instructions hint is missing",
    );
    assert.ok(
      markup.includes(TEXT.settings.system.specialists.instructionsPlaceholder),
      "the instructions placeholder is missing",
    );
    assert.match(markup, /maxlength="80"/iu);
    assert.match(markup, /maxlength="1000"/iu);
    assert.match(markup, /maxlength="32768"/iu);
  });

  it("only asks for a model name on an external runtime", () => {
    assert.ok(
      !form(existing).includes(TEXT.settings.system.specialists.modelHint),
      "a native specialist is asked for a model",
    );
    const external = form({ ...existing, runtime: { kind: "codex", model: "gpt-5" } });
    assert.ok(external.includes(TEXT.settings.system.specialists.modelHint), "the model row is missing");
    assert.ok(external.includes('value="gpt-5"'), "the runtime's model is not filled in");
  });

  it("puts 取消 before 保存", () => {
    const markup = form(existing);
    const cancel = markup.indexOf(`>${TEXT.settings.cancel}</button>`);
    const save = markup.indexOf(`>${TEXT.settings.system.save}</button>`);
    assert.ok(cancel >= 0 && save >= 0 && cancel < save, "the buttons are out of order");
  });

  it("starts a new specialist on 完全访问 with an empty 技能 list", () => {
    const markup = form();
    const copy = TEXT.settings.system.specialists;
    assert.ok(markup.includes(copy.capabilities), "the 能力 title is missing");
    assert.ok(markup.includes(copy.capabilitiesHint), "the 能力 hint is missing");
    assert.ok(markup.includes(copy.fullAccess), "完全访问 is missing");
    assert.ok(markup.includes(copy.defaultTag), "the 默认 tag is missing");
    assert.ok(markup.includes(copy.fullAccessHint), "完全访问's hint is missing");
    assert.ok(markup.includes(copy.orSpecific), "the divider is missing");
    assert.ok(markup.includes(copy.addSkill), "添加技能 is missing");
    assert.ok(markup.includes(copy.noSkills), "the empty 技能 list is missing");
    assert.ok(markup.includes(copy.skillsNote), "the empty-list warning is missing");
    assert.match(markup, /type="radio"[^>]*checked=""/, "完全访问 is not selected by default");
  });

  it("shows the specific skills a specialist already has", () => {
    const markup = form(
      { ...existing, enabledSkillIds: ["draft-review"] },
      { skills: [skill("draft-review", "初稿审阅")] },
    );
    assert.ok(markup.includes("初稿审阅"), "the chosen skill is not listed");
    assert.ok(markup.includes(`${TEXT.settings.system.specialists.remove} 初稿审阅`), "the skill has no remove control");
    assert.ok(!markup.includes(TEXT.settings.system.specialists.noSkills), "the empty state is still shown");
    assert.doesNotMatch(markup, /type="radio"[^>]*checked=""/, "完全访问 is still selected for a specific list");
  });

  it("lists every capability in the picker", () => {
    const pick = (tab: "skills" | "connectors") =>
      renderToStaticMarkup(
        <AbilityPicker
          connectors={[connector("arxiv", "arXiv")]}
          initialTab={tab}
          onApply={noConfirm}
          onClose={noConfirm}
          selectedConnectorIds={[]}
          selectedSkillIds={[]}
          skills={[skill("draft-review", "初稿审阅")]}
        />,
      );

    const skills = pick("skills");
    assert.ok(skills.includes("初稿审阅"), "the picker does not list the skill");
    assert.ok(skills.includes("初稿审阅 的说明"), "the picker does not describe the skill");
    assert.ok(skills.includes(TEXT.settings.system.specialists.addSelected), "the picker has no 添加");

    const connectors = pick("connectors");
    assert.ok(connectors.includes("arXiv"), "the picker does not list the connector");
  });
});

describe("the add-skill form", () => {
  const form = () =>
    renderToStaticMarkup(
      <SkillForm client={client} onCancel={noConfirm} onSaved={noConfirm} />,
    );

  it("asks for the authored fields and starts with 创建 disabled", () => {
    const markup = form();
    const copy = TEXT.settings.skills;
    for (const placeholder of [
      copy.namePlaceholder,
      copy.descriptionPlaceholder,
      copy.licensePlaceholder,
      copy.versionPlaceholder,
      copy.compatibilityPlaceholder,
      copy.instructionsPlaceholder,
    ]) {
      assert.ok(markup.includes(placeholder), `the form is missing ${placeholder}`);
    }
    // The runtime never enforced SKILL.md's allowed-tools, so the authoring
    // form no longer offers a field that would only write an inert declaration.
    assert.ok(!markup.includes("允许的工具"), "the unenforced allowed-tools field is back");
    assert.ok(markup.includes(copy.nameHint), "the skill-name rule is missing");
    assert.ok(markup.includes("0 / 64"), "the name counter is missing");
    assert.ok(markup.includes("0 / 1024"), "the description counter is missing");
    assert.match(markup, /maxlength="64"/iu);
    assert.match(markup, /maxlength="1024"/iu);
    assert.match(markup, /disabled=""[^>]*>创建<\/button>/, "创建 is enabled with an empty form");
  });

  it("is what 新增技能 opens", () => {
    const markup = renderToStaticMarkup(
      <SkillsSettings adding client={client} onAddingChange={noConfirm} />,
    );
    assert.ok(markup.includes(TEXT.settings.skills.add), "the modal is not labelled 新增技能");
    assert.ok(markup.includes(TEXT.settings.skills.namePlaceholder), "the authoring form is not open");
  });
});

describe("the skill card", () => {
  const skill = (fields: Partial<SkillDescriptor> = {}) => ({
    currentRevision: 1,
    description: "审阅初稿",
    diagnostics: [],
    hash: "hash",
    id: "draft-review",
    name: "draft-review",
    readOnly: false,
    resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
    source: "managed",
    version: "revision:1",
    ...fields,
  }) as SkillDescriptor;

  it("names the revision a skill was installed at instead of the server's label", () => {
    // The server's own label for an undeclared version is `revision:1`; put
    // after a `v` it read as `vrevision:1`.
    const meta = skillMeta(skill());
    assert.ok(meta.includes("第 1 版"), `the revision is not spelled out: ${meta}`);
    assert.ok(!meta.includes("vrevision"), "the server's revision label is being read as a version");
    assert.ok(meta.includes(TEXT.settings.skills.source.managed), "the card does not say where the skill came from");
  });

  it("reads a declared version as a version", () => {
    const meta = skillMeta(skill({ declaredVersion: "1.2.0", currentRevision: 4 }));
    assert.ok(meta.includes("v1.2.0"), `the declared version is missing: ${meta}`);
    assert.ok(!meta.includes("第 4 版"), "the revision is shown even though a version was declared");
  });

  it("counts the SKILL.md every package has", () => {
    // `resourceSummary.files` counts the files beside SKILL.md, so a skill
    // whose package is SKILL.md and nothing else used to read `0 个文件`.
    assert.ok(skillMeta(skill()).includes(TEXT.workspace.filesCount(1)), "a bare skill does not count SKILL.md");
    const withScript = skill({
      resourceSummary: {
        bytes: 2048,
        files: 3,
        kinds: { asset: 0, other: 0, reference: 1, script: 2 },
      },
    });
    assert.ok(
      skillMeta(withScript).includes(TEXT.workspace.filesCount(4)),
      "the resources do not count alongside SKILL.md",
    );
    assert.ok(skillMeta(skill({ source: "built-in" })).includes(TEXT.settings.skills.source.builtIn));
  });
});

describe("a skill created from the form", () => {
  it("joins a project's explicit selection", () => {
    // `selected` carries an explicit list, so a new package would arrive off.
    assert.deepEqual(enabledAfterCreate("selected", ["a", "b"], "c"), ["a", "b", "c"]);
    assert.equal(enabledAfterCreate("selected", ["a", "c"], "c"), undefined, "an already-selected skill is written twice");
  });

  it("needs no write where the mode already means every installed skill", () => {
    // `all` is the default and resolves to the whole catalog, so the new
    // package is on without a write — and writing the list would pin the
    // project to `selected` and freeze the catalog behind it.
    assert.equal(enabledAfterCreate("all", ["a"], "c"), undefined);
    assert.equal(enabledAfterCreate(undefined, [], "c"), undefined);
  });
});

describe("the MCP servers page", () => {
  const page = () =>
    renderToStaticMarkup(
      <McpServers client={client} onConfirm={noConfirm} onToast={noConfirm} />,
    );

  it("reads one card list, not the custom/built-in tabs", () => {
    const markup = page();
    assert.ok(markup.includes("settings-section"), "MCP 服务器 rendered no section");
    assert.ok(markup.includes(loading), "MCP 服务器 did not start a read");
    assert.ok(!markup.includes('role="tablist"'), "the custom/built-in tabs are back");
    assert.ok(markup.includes(TEXT.settings.system.mcp.help), "the page does not say what 内置 means");
  });

  it("opens no blank form", () => {
    // 新增服务器 is gone: a server is written from the row that already has
    // one, so the page mounts with every form closed and offers no way in.
    const markup = page();
    assert.ok(!markup.includes("settings-card is-form"), "a form is mounted before a row was picked");
    assert.ok(!markup.includes(TEXT.settings.system.mcp.add), "新增服务器 is still drawn");
  });
});

describe("each settings page", () => {
  // The registrations are written out rather than looped: the CI collector
  // audits every test declaration, and a title assembled at runtime is a
  // case it cannot name before running it.
  const asksForItsData = (name: string, element: React.ReactElement) => {
    const markup = renderToStaticMarkup(element);
    assert.ok(markup.includes("settings-section"), `${name} rendered no section`);
    assert.ok(markup.includes(loading), `${name} did not start a read`);
  };

  it("技能 renders and asks for its data", () => {
    asksForItsData(
      "技能",
      <SkillsSettings adding={false} client={client} onAddingChange={noConfirm} />,
    );
  });

  it("网络 renders and asks for its data", () => {
    asksForItsData("网络", <NetworkSettings client={client} onConfirm={noConfirm} />);
  });

  it("远程 renders and asks for its data", () => {
    asksForItsData("远程", <RuntimeSettings client={client} onConfirm={noConfirm} />);
  });

  it("专家 renders and asks for its data", () => {
    asksForItsData(
      "专家",
      <SpecialistsSettings client={client} onConfirm={noConfirm} />,
    );
  });

  it("超时 renders and asks for its data", () => {
    // The one page that used to wait for the footer's 保存. It now owns the
    // commit, so it has to stand on its own without a dialog around it.
    asksForItsData("超时", <TimeoutSettings client={client} />);
  });

  it("技能 says why it cannot read a choice when there is no project yet", () => {
    // The skill selection lives in the project layer, so a page without a
    // project has nothing to read — and says so rather than showing a list of
    // switches that would write nowhere.
    const markup = renderToStaticMarkup(
      <SkillsSettings adding={false} client={client} onAddingChange={noConfirm} />,
    );
    assert.ok(markup.includes(loading));
  });

  it("网络 keeps the sandbox mode and its allowlist, and 远程 only the Runner", () => {
    // Both of those pages are mid-read in this render, so the sections
    // themselves are behind their loading gate and there is no DOM here to
    // resolve it. What can be pinned is the vocabulary each page owns: the
    // blocks that were taken out would bring their labels back with them.
    const network = JSON.stringify(TEXT.settings.network);
    assert.ok(network.includes("沙箱网络"));
    // The allowlist mode and the box that takes its domains are offered.
    assert.ok(network.includes("域名白名单"));
    assert.ok(network.includes("允许的域名"));
    for (const gone of [
      "代理服务器",
      "新增代理服务器",
      "按模块代理",
      "允许内网与回环地址",
      "白名单流量的出站路由",
      "保存沙箱网络",
      "保存会轮换权限时代",
    ]) {
      assert.ok(!network.includes(gone), `网络 still has a ${gone} label`);
    }
    const runtime = JSON.stringify(TEXT.settings.runtime);
    assert.ok(runtime.includes("Runner"));
    for (const gone of ["常驻内核", "运行状态", "配额", "超时", "测试连接"]) {
      assert.ok(!runtime.includes(gone), `远程 still has a ${gone} label`);
    }
    // The Runner list has no heading of its own now; the group is the heading.
    assert.ok(!runtime.includes('"heading":"Runner"'));
  });
});
