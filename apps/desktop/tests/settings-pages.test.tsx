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
import { getLanguage, setLanguage, TEXT } from "../src/text.js";
import { writeSettingsCache } from "../src/app/settings-cache.js";
import { StubClient } from "./api-stub.js";
import { GeneralSettings } from "../src/views/settings/GeneralSettings.js";
import { SandboxDirectSettings } from "../src/views/settings/SandboxDirectSettings.js";
import { act, create } from "./support/dom-renderer.js";
import { ModelForm } from "../src/views/ModelForm.js";
import { ModelPicker, ModelSettings, providerChoices } from "../src/views/settings/ModelSettings.js";
import { ListSelect } from "../src/views/settings/ListSelect.js";
import { SystemSettingsDialog } from "../src/views/SystemSettingsDialog.js";
import { RunnerSection } from "../src/views/settings/RemoteHosts.js";
import { NetworkSettings } from "../src/views/settings/NetworkSettings.js";
import { ModelUsageSettings } from "../src/views/settings/ModelUsageSettings.js";
import { RuntimeSettings } from "../src/views/settings/RuntimeSettings.js";
import { SkillForm } from "../src/views/settings/SkillForm.js";
import { SkillsSettings } from "../src/views/settings/SkillsSettings.js";
import { skillMeta } from "../src/views/settings/skill-meta.js";
import { AbilityPicker } from "../src/views/settings/system/AbilityPicker.js";
import { McpServers } from "../src/views/settings/system/McpServers.js";
import { MemorySettings } from "../src/views/settings/system/MemorySettings.js";
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
  it("includes the desktop groups and migrated Runner, quota, search, proxy and Idea Tree pages", () => {
    assert.deepEqual(Object.values(TEXT.settings.system.categories), ["系统", "智能", "连接", "工作区"]);
    assert.deepEqual(
      Object.values(TEXT.settings.system.groups).map((group) => group.label),
      ["通用", "科学记忆", "模型", "模型用量", "技能", "MCP 服务器", "专家", "沙箱网络", "运行环境", "运行配额", "联网搜索", "网络代理", "超时", "会话管理", "导出记录", "Idea Tree"],
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

  it("puts 取消 on the far side, with 测试连接 and 保存 together on the right", () => {
    const markup = form(noConfirm);
    const test = markup.indexOf(`>${TEXT.settings.model.test}</button>`);
    const save = markup.indexOf(`>${TEXT.settings.model.save}</button>`);
    const cancel = markup.indexOf(`>${TEXT.menu.cancel}</button>`);
    assert.ok(test >= 0, "no 测试连接 button");
    assert.ok(save >= 0, "no 保存 button");
    assert.ok(cancel >= 0, "no 取消 button");
    // 取消 is the way out, so it does not sit between the two actions that
    // commit the form; the primary stays rightmost.
    assert.ok(cancel < test && test < save, "the buttons are out of order");
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
    <ModelSettings actions={actions} adding={false} client={client} onAddingChange={noConfirm} signedIn state={state} />,
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
      onShowGuide={noConfirm}
      signedIn
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
    // 超时 now commits its own fields, and 导出记录 only reveals or forgets a
    // row; a shared save bar would only ever have been disabled. 设置 is left
    // through the rail's 会话 or Escape.
    assert.ok(!markup.includes("system-config-footer"), "the footer is back");
    // The word 保存 is no longer a reliable proxy: the directory's tooltips
    // carry "本机保存过的研究包". What must not come back is a button whose
    // label is the save action.
    const labelled = [...markup.matchAll(/<button[^>]*>(.*?)<\/button>/gs)]
      .map((match) => match[1]!.replace(/<[^>]*>/g, "").trim())
      .filter((text) => text === TEXT.settings.system.save);
    assert.deepEqual(labelled, [], "a footer save button is back");
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
  const markup = renderToStaticMarkup(<GeneralSettings onShowGuide={() => {}} />);

  it("draws its own list instead of the platform's popup", () => {
    assert.ok(markup.includes("list-select-trigger"), "界面语言 went back to a native <select>");
    assert.ok(!markup.includes("<select"), "a native <select> is back");
  });

  it("does not repeat the row's label above the control", () => {
    // The row already says 界面语言; a caption would say it a second time and
    // push the control down a line.
    assert.ok(!markup.includes("list-select-caption"), "the field is named twice");
  });

  it("[U5c] draws no sandbox status row when the shell never answered", () => {
    // [mac-direct] The block moved to the 沙箱网络 group (设置 › 连接) —
    // GeneralSettings no longer carries it, so this static render of 通用
    // cannot contain it either; the live assertion now runs against
    // SandboxDirectSettings itself. Static rendering runs no effect, so the
    // bridge pull has not resolved and the status row stays hidden — a
    // settings page cannot state a sandbox nobody probed. What must also
    // hold: the row (and the switch section) never render in a plain
    // browser at all, because the section is gated on direct.available,
    // which is false without a darwin shell.
    const sandboxMarkup = renderToStaticMarkup(<SandboxDirectSettings />);
    assert.ok(!sandboxMarkup.includes(TEXT.settings.network.sandbox.status.field),
      "the sandbox status row rendered without a shell answer");
    assert.ok(!sandboxMarkup.includes("sandbox-status-dot"), "the status dot rendered without a shell answer");
    // And 通用 is now clean of the sandbox vocabulary by construction.
    assert.ok(!markup.includes("沙箱"), "通用 must not carry sandbox copy after the move");
  });
});

describe("[U5c] the sandbox status row (settings-only surface)", () => {
  // [F16] The row's state derives from BOTH inputs — the probe verdict AND
  // the session's effective mode (`directActive`, the spawn-time snapshot)
  // — because a row that reads only the probe would claim "sandboxed" on
  // an opted-in install whose probe passed. [F18] The effective mode is
  // the spawn-time snapshot, not the persisted switch: right after a
  // mid-session toggle the live stack is still in its old mode and the
  // row must keep stating the old mode. The hook is exercised through the
  // component: the bridge is installed on globalThis.window before render,
  // and react-test-renderer lets the mount effect run so the pull resolves.
  // [mac-direct] The block lives in SandboxDirectSettings (设置 › 沙箱网络)
  // after the 2026-11-25 move from 通用.

  async function renderedStatus(answer: unknown, enabled = false): Promise<string> {
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      sdShell: {
        directExecution: { get: async () => ({ available: true, enabled }) },
        seatbeltStatus: async () => answer,
      },
    };
    let tree: import("react-test-renderer").ReactTestRenderer | undefined;
    try {
      await act(async () => {
        tree = create(<SandboxDirectSettings />);
      });
      return JSON.stringify(tree?.toJSON());
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  }

  it("shows the amber failure line (with the localized cause) when the probe failed and the stack runs direct", async () => {
    const json = await renderedStatus({
      kind: "failed", platform: "darwin",
      reason: "sandbox-exec 退出码 71", diagnostics: ["/usr/bin/sandbox-exec …"],
      detail: { failCode: "exit-code", exitCode: 71 },
      directActive: true,
    });
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.field), "the status row is missing");
    assert.ok(json.includes("sandbox-status-dot"), "the status dot is missing");
    assert.ok(json.includes('"data-kind":"failed"'), "the dot must carry the failed kind for the amber tone");
    // [F12] The structured cause is localized into the hint; the raw reason
    // + diagnostics ride the dot's tooltip.
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.failCause["exit-code"]), "the localized cause is missing from the hint");
    assert.ok(json.includes("sandbox-exec 退出码 71"), "the raw reason must ride the tooltip");
  });

  it("shows the green line when the stack was spawned sandboxed", async () => {
    const json = await renderedStatus({ kind: "ok", platform: "darwin", directActive: false });
    assert.ok(json.includes('"data-kind":"ok"'), "the dot must carry the ok kind for the green tone");
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.ok), "the ok sentence is missing");
  });

  it("[hint-split] renders the lead sentence plus a collapsed details block carrying every blast-radius point", async () => {
    // The switch row keeps one lead sentence in its hint; the full impact
    // list is a sibling <details> block. Collapsed by default (the whole
    // point: passing readers pay one sentence), and every bullet is still
    // in the markup — the [U5c] red line is presence, not visibility.
    // [F29] The restart clause moved back into the lead hint, so it is no
    // longer one of the details bullets — the [F29] test below pins it to
    // the always-visible hint itself.
    const json = await renderedStatus({ kind: "ok", platform: "darwin", directActive: false });
    const direct = TEXT.settings.network.sandbox.directExecution;
    assert.ok(json.includes(direct.hint), "the lead sentence is missing from the hint");
    assert.ok(json.includes('"details"'), "the details block is missing");
    assert.ok(!json.includes('"open"'), "the details block must render collapsed by default");
    assert.ok(json.includes(direct.showDetails), "the expand label is missing");
    for (const line of direct.hintDetails) {
      assert.ok(json.includes(line), `the blast-radius bullet is missing: ${line}`);
    }
  });

  it("[F29] the restart clause rides the always-visible lead hint, not the collapsed details", () => {
    // The switch flip gives no immediate feedback: the status row keeps
    // stating the spawn-time mode until the next spawn, so right after the
    // user flips the switch ON the visible pair would say both "leaves the
    // sandbox" (hint) and "executes sandboxed" (green row) — the restart
    // clause is the only thing that explains that window, and it matters
    // precisely in the moment it is hidden behind the collapsed block.
    // The combined hint+hintDetails render assertion cannot tell "always
    // visible" from "one click away" (that blindness is how F29 slipped
    // through in the first place), so this pins the clause to the hint
    // constant itself — in both dictionaries, since the zh dictionary is
    // the Text type's source and the en one mirrors it. ([hint-split] above
    // already proves the hint renders; this test pins where the clause
    // lives.)
    const direct = TEXT.settings.network.sandbox.directExecution;
    assert.ok(direct.hint.includes("重启应用后生效"), "[F29] the zh lead hint must carry the restart clause");
    assert.ok(!direct.hintDetails.includes("重启应用后生效"), "[F29] the clause must not hide in the zh details bullets");
    const previous = getLanguage();
    try {
      setLanguage("en");
      const directEn = TEXT.settings.network.sandbox.directExecution;
      assert.ok(directEn.hint.includes("Applies after a restart"), "[F29] the en lead hint must carry the restart clause");
      assert.ok(!directEn.hintDetails.includes("Applies after a restart"), "[F29] the clause must not hide in the en details bullets");
    } finally { setLanguage(previous); }
  });

  it("[dot-beside] the status dot sits in a right-column status row, never under its label", async () => {
    // The base row grid is one column, so a control wraps under its label —
    // for a 10px status dot that read as a stray mark below the text. The
    // status rows use `is-status`: two columns (label 1fr, dot auto),
    // vertically centred. Pinned so a future tone refactor cannot quietly
    // strand the dot under the sentence again. (The renderer's JSON form
    // carries className unquoted, so the assertion matches the bare token.)
    const json = await renderedStatus({ kind: "ok", platform: "darwin", directActive: false });
    assert.ok(/class[=:]"?[^"]*is-status/.test(json) || json.includes("is-status"), "the status row must carry the is-status class");
    assert.ok(!json.includes("is-stack"), "the status row must not use the stack layout");
  });

  it("[F16] says opted-out — NOT sandboxed — when the stack runs direct with a passing probe", async () => {
    // The ordinary opt-in path: the switch was on at spawn, the probe
    // passed, the session runs direct. A row that claims "sandboxed" here
    // would state the opposite of the truth.
    const json = await renderedStatus({ kind: "ok", platform: "darwin", directActive: true }, true);
    assert.ok(json.includes('"data-kind":"opted-out"'), "the dot must carry the opted-out kind");
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.optedOut), "the opted-out sentence is missing");
    assert.ok(!json.includes(TEXT.settings.network.sandbox.status.ok), "the ok sentence must NOT appear when the stack runs direct");
  });

  it("[F18] keeps the green line right after a mid-session toggle to ON", async () => {
    // The user just flipped the switch to ON, but the running stack was
    // spawned sandboxed and a restart applies the change — so the row must
    // keep stating the mode the live stack is actually in, not the switch's
    // new value.
    const json = await renderedStatus({ kind: "ok", platform: "darwin", directActive: false }, true);
    assert.ok(json.includes('"data-kind":"ok"'), "the dot must stay green while the live stack is still sandboxed");
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.ok), "the ok sentence must stay while the live stack is still sandboxed");
    assert.ok(!json.includes(TEXT.settings.network.sandbox.status.optedOut), "the row must not claim direct before the restart actually happens");
  });

  it("[F18] keeps the failed line right after a mid-session toggle to OFF", async () => {
    // Mirror window: the user flipped the switch OFF, but the stack was
    // spawned direct (probe-failure boot). The row stays amber-failed with
    // its cause; the switch hint explains the restart.
    const json = await renderedStatus({
      kind: "failed", platform: "darwin",
      reason: "r", diagnostics: ["d"],
      detail: { failCode: "spawn-error" },
      directActive: true,
    }, false);
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.failed), "the failed sentence must stay while the live stack still runs direct");
    assert.ok(!json.includes(TEXT.settings.network.sandbox.status.ok), "the row must not claim sandboxed before the restart actually happens");
  });

  it("[F21] a failed verdict renders the amber line even when the flag says the spawn was not direct", async () => {
    // The attach-to-external-stack window: this shell never ran
    // darwinDirectEnv, so directActive stayed false — but the session's
    // probe DID fail, and the verdict is the fact the row exists to show.
    // A render keyed on directActive first would fall into the green
    // branch and claim "sandboxed" here; the verdict must win.
    const json = await renderedStatus({
      kind: "failed", platform: "darwin",
      reason: "r", diagnostics: ["d"],
      detail: { failCode: "exit-code", exitCode: 71 },
      directActive: false,
    });
    assert.ok(json.includes('"data-kind":"failed"'), "the dot must carry the failed kind, not the ok kind");
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.failed), "the failed sentence must render");
    assert.ok(!json.includes(TEXT.settings.network.sandbox.status.ok), "the green sentence must never appear on a failed verdict");
  });

  it("[F22] the direct-but-switch-off window tells the user to restart, not to turn off a switch that is already off", async () => {
    // Probe passed, stack spawned direct (opt-in at spawn), and the user
    // has since turned the switch OFF: the row must name the restart as
    // the way back, never "(the switch below is ON)".
    const json = await renderedStatus({ kind: "ok", platform: "darwin", directActive: true }, false);
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.optedOutSwitchOff), "the switch-off variant must render");
    assert.ok(!json.includes(TEXT.settings.network.sandbox.status.optedOut), "the 'switch is ON' variant must not claim a switch state that is not true");
    // [F24] The sentence is unreachable on a failed verdict (the failed
    // branch wins), so it must not carry a probe clause it can never
    // honestly state — a probe cause belongs to the amber row alone.
    assert.ok(!json.includes("探测失败"), "[F24] the switch-off variant must not mention a probe failure it can never represent");
    assert.ok(!json.includes("or its probe failed"), "[F24] the switch-off variant must not mention a probe failure it can never represent (en)");
  });

  it("[F26] an adopted stack renders the attached hedge, never an asserted ok/optedOut sentence", async () => {
    // This session attached to an already-running backend: whatever the
    // inference says, the ok ("sandboxed") and optedOut sentences assert a
    // mode this shell cannot know — the row must hedge instead, in BOTH
    // directActive shapes (the inference is not the survivor's env).
    const attachedOk = await renderedStatus({ kind: "ok", platform: "darwin", directActive: false, modeKnown: false });
    assert.ok(attachedOk.includes('"data-kind":"attached"'), "the dot must carry the attached kind for the neutral tone");
    assert.ok(attachedOk.includes(TEXT.settings.network.sandbox.status.attached), "the attached sentence must render");
    // [F26-followup-2] The stop advice must name a concrete route — the app
    // exposes no user-facing control that stops an adopted backend (quit
    // stops only a stack this shell spawned), so an unnamed route would
    // strand the user at a truthful-but-vacuous instruction. The zh row
    // names the terminal and Activity Monitor; en says the same in its
    // words (verified by the en assertion below).
    assert.ok(attachedOk.includes("活动监视器"), "[F26-followup-2] the zh stop route (Activity Monitor) must be named");
    assert.ok(!attachedOk.includes(TEXT.settings.network.sandbox.status.ok), "the green sentence must not assert over an unverified mode");
    const attachedDirect = await renderedStatus({ kind: "ok", platform: "darwin", directActive: true, modeKnown: false });
    assert.ok(attachedDirect.includes('"data-kind":"attached"'), "the directActive shape must hedge too");
    assert.ok(!attachedDirect.includes(TEXT.settings.network.sandbox.status.optedOut), "the opted-out sentence must not assert over an unverified mode");
    assert.ok(!attachedDirect.includes(TEXT.settings.network.sandbox.status.optedOutSwitchOff), "the switch-off sentence must not assert over an unverified mode");
  });

  it("[F26-followup-2] the en attached sentence names its stop route too", async () => {
    // zhaozhaozz (round 15): "stop that backend process" is truthful but
    // leaves the user to find the process themselves. The fix is per-locale
    // copy, and the en row must carry the same concreteness the zh row
    // pins above — rendered under setLanguage("en") so the proxy resolves
    // the EN dictionary for this render.
    const previous = getLanguage();
    try {
      setLanguage("en");
      const attachedEn = await renderedStatus({ kind: "ok", platform: "darwin", directActive: false, modeKnown: false });
      assert.ok(attachedEn.includes("Activity Monitor"), "[F26-followup-2] the en stop route (Activity Monitor) must be named");
      assert.ok(attachedEn.includes("terminal"), "[F26-followup-2] the en stop route (terminal) must be named");
    } finally { setLanguage(previous); }
  });

  it("[F26] a failed verdict still asserts on an adopted stack — the probe is this session's own fact", async () => {
    // The probe ran in THIS session; its failure is true regardless of
    // whose process the stack is. modeKnown:false must not downgrade the
    // amber row.
    const json = await renderedStatus({
      kind: "failed", platform: "darwin",
      reason: "r", diagnostics: ["d"],
      detail: { failCode: "spawn-error" },
      directActive: true, modeKnown: false,
    });
    assert.ok(json.includes('"data-kind":"failed"'), "the failed kind must stay");
    assert.ok(json.includes(TEXT.settings.network.sandbox.status.failed), "the failed sentence must stay");
    assert.ok(!json.includes(TEXT.settings.network.sandbox.status.attached), "the attached hedge must not replace a failed verdict");
  });

  it("shows no row when the bridge errors or predates U5c", async () => {
    const json = await renderedStatus(null);
    assert.ok(!json.includes("sandbox-status-dot"), "a null answer must not render a row");
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

  it("keeps 保存 disabled while required fields are blank", () => {
    assert.match(form(), /disabled=""[^>]*>保存<\/button>/, "保存 is enabled with blank required fields");
  });

  it("fills the form from the specialist it edits", () => {
    const markup = form(existing);
    assert.ok(markup.includes(`value="${existing.name}"`), "the name is not filled in");
    assert.ok(markup.includes(`value="${existing.description}"`), "the description is not filled in");
    assert.ok(markup.includes(existing.instructions), "the instructions are not filled in");
    assert.doesNotMatch(markup, /disabled=""[^>]*>保存<\/button>/, "保存 is disabled for a complete specialist");
  });

  it("shows an unavailable selected skill with an explicit repair control", () => {
    const markup = form({ ...existing, enabledSkillIds: ["removed-skill"] });
    assert.ok(markup.includes(TEXT.settings.system.specialists.unavailableSkill("removed-skill")));
    assert.ok(markup.includes(`${TEXT.settings.system.specialists.remove} removed-skill`));
    assert.ok(markup.includes(TEXT.settings.system.specialists.unavailableSkillsHint));
    assert.match(markup, /disabled=""[^>]*>保存<\/button>/);
  });

  it("shows the counters and placeholders the design asks for", () => {
    const markup = form().replaceAll("<!-- -->", "");
    assert.ok(markup.includes("0 / 80"), "the name counter is missing");
    assert.ok(markup.includes("0 / 500"), "the description counter is missing");
    assert.ok(markup.includes("0 / 20,000"), "the instructions counter is missing");
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
    assert.match(markup, /maxlength="500"/iu);
    assert.match(markup, /maxlength="20000"/iu);
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
      <SkillForm client={client} onSaved={noConfirm} />,
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

  it("is offered by the list's 添加技能 menu, not opened by it", () => {
    // The menu's entries are drawn on press, so the static page carries the
    // one control; that pressing 从零开始写 lands on this form is the dynamic
    // check in skills-import-edit.test.tsx.
    const markup = renderToStaticMarkup(<SkillsSettings client={client} />);
    assert.ok(markup.includes(TEXT.settings.skills.addMenu.label), "the list has no 添加技能");
    assert.ok(
      !markup.includes(TEXT.settings.skills.namePlaceholder),
      "the authoring form is on the page before 从零开始写 was chosen",
    );
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

  it("separates the three sources into tabs and marks every card", () => {
    const sourceClient = new StubClient().asClient();
    writeSettingsCache(sourceClient, "skills:jiuwenswarm", {
      enabled: [],
      native: false,
      switchesAvailable: true,
      skills: [skill({ id: "sd-review", source: "built-in" }), skill({ id: "custom-review" })],
      jiuwenSwarmSkills: [{ name: "xlsx", description: "Read spreadsheets", enabled: true, source: "builtin" }],
    });
    const markup = renderToStaticMarkup(
      <SkillsSettings client={sourceClient} />,
    );
    // The catalog's built-in and JiuwenSwarm's own built-ins are the two
    // official packages; the managed one is 我的.
    for (const label of [
      TEXT.settings.skills.tabs.all(3),
      TEXT.settings.skills.tabs.mine(1),
      TEXT.settings.skills.tabs.official(2),
    ]) {
      assert.ok(markup.includes(label), `The list does not count ${label}`);
    }
    assert.ok(markup.includes(TEXT.settings.skills.cardTag.builtIn), "a built-in card carries no 内置 tag");
    assert.ok(markup.includes(TEXT.settings.skills.cardTag.external), "a managed card carries no 外部 tag");
    assert.ok(!markup.includes("settings-detail-heading"), "Sources must be visible before opening instructions");
  });

  it("reads card tags in the current language after the module was loaded", () => {
    const previous = getLanguage();
    const sourceClient = new StubClient().asClient();
    writeSettingsCache(sourceClient, "skills:jiuwenswarm", {
      enabled: [], native: false, switchesAvailable: true, jiuwenSwarmSkills: [],
      skills: [skill({ source: "built-in" }), skill({ id: "custom" })],
    });
    try {
      for (const language of ["en", "zh-CN"] as const) {
        setLanguage(language);
        const markup = renderToStaticMarkup(<SkillsSettings client={sourceClient} />);
        assert.ok(markup.includes(TEXT.settings.skills.cardTag.builtIn));
        assert.ok(markup.includes(TEXT.settings.skills.cardTag.external));
      }
    } finally { setLanguage(previous); }
  });

  it("names the revision a skill was installed at instead of the server's label", () => {
    // The server's own label for an undeclared version is `revision:1`; put
    // after a `v` it read as `vrevision:1`.
    const meta = skillMeta(skill());
    assert.ok(meta.includes("第 1 版"), `the revision is not spelled out: ${meta}`);
    assert.ok(!meta.includes("vrevision"), "the server's revision label is being read as a version");
    assert.ok(!meta.includes(TEXT.settings.skills.source.managed), "the source is already in the badge");
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

  });
});

describe("the data sources page", () => {
  const page = () =>
    renderToStaticMarkup(
      <McpServers client={client} onConfirm={noConfirm} onToast={noConfirm} />,
    );

  it("shows catalog identity while the first read is pending", () => {
    const markup = page();
    assert.ok(markup.includes("settings-section"), "数据源 rendered no section");
    assert.ok(markup.includes(loading), "数据源 did not start a read");
    assert.ok(!markup.includes('role="tablist"'), "the custom/built-in tabs are back");
    assert.ok(markup.includes(TEXT.settings.system.groups.mcp.description), "the page does not explain default selection");
  });

  it("keeps the create form closed until the user opens it", () => {
    // Creation is offered by the loaded pane; no dialog opens on mount.
    const markup = page();
    assert.ok(!markup.includes("settings-card is-form"), "a form is mounted before a row was picked");
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

  it("科学记忆 renders and asks for its data", () => {
    asksForItsData("科学记忆", <MemorySettings client={client} />);
  });

  it("技能 renders and asks for its data", () => {
    asksForItsData(
      "技能",
      <SkillsSettings client={client} />,
    );
  });

  it("网络 renders and asks for its data", () => {
    asksForItsData("网络", <NetworkSettings client={client} onConfirm={noConfirm} />);
  });

  it("运行环境 renders its Runner skeleton before the catalog answers", () => {
    const markup = renderToStaticMarkup(<RuntimeSettings client={client} onConfirm={noConfirm} />);

    assert.ok(markup.includes("settings-section"), "运行环境 rendered no section");
    assert.ok(markup.includes(TEXT.settings.system.migrated.environments.skeleton),
      "运行环境 did not paint its first-paint skeleton");
    assert.ok(markup.includes('aria-busy="true"'), "the runtime skeleton is not marked busy");
    assert.ok(markup.includes("settings-skeleton-block"), "the runtime skeleton has no stand-in rows");
  });

  it("模型用量 renders its metrics and table skeleton before the summary answers", () => {
    const markup = renderToStaticMarkup(<ModelUsageSettings client={client} />);

    assert.ok(markup.includes(TEXT.settings.system.usage.skeleton),
      "模型用量 did not paint its first-paint skeleton");
    assert.ok(markup.includes('aria-busy="true"'), "the usage skeleton is not marked busy");
    assert.equal((markup.match(/is-usage-metric-label/g) ?? []).length, 3, "the usage skeleton has no metric cards");
    assert.equal((markup.match(/settings-skeleton-row/g) ?? []).length, 4, "the usage skeleton has no table rows");
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

  it("技能 loads global switches without requiring a project", () => {
    const markup = renderToStaticMarkup(
      <SkillsSettings client={client} />,
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

  it("[mac-direct] the sandbox opt-in vocabulary lives in 网络, not in 通用", () => {
    // User call 2026-11-25: everything that governs the sandbox belongs
    // behind one 「沙箱」 entrance, so the direct-execution block moved from
    // 通用 to the 沙箱网络 group. The copy itself is unchanged — this pins
    // the relocation, not the sentences: the keys must be reachable under
    // network.sandbox and must NOT remain under general.
    const network = JSON.stringify(TEXT.settings.network);
    assert.ok(network.includes("无沙箱运行本地代码"), "the switch's field label must live in 网络");
    assert.ok(network.includes("沙箱状态"), "the status row's field label must live in 网络");
    const general = JSON.stringify(TEXT.settings.general);
    assert.ok(!general.includes("无沙箱运行本地代码"), "通用 still carries the switch's label");
    assert.ok(!general.includes("沙箱状态"), "通用 still carries the status row's label");
  });

  it("[mac-direct] the sandbox block renders inside 网络, ahead of the network rows", async () => {
    // Round 17 review: the relocation pin above proves where the strings
    // live, not where the page draws them. This mounts the real NetworkSettings
    // (LoadGate mid-read, so the network rows are hidden) with the shell
    // bridge stubbed to a darwin shell, and asserts the opt-in block renders
    // on that page — the placement itself, not the vocabulary.
    const previousWindow = (globalThis as { window?: unknown }).window;
    (globalThis as { window?: unknown }).window = {
      sdShell: {
        directExecution: { get: async () => ({ available: true, enabled: false }) },
        seatbeltStatus: async () => ({ kind: "ok", platform: "darwin", directActive: false }),
      },
    };
    let tree: import("react-test-renderer").ReactTestRenderer | undefined;
    try {
      await act(async () => {
        tree = create(
          <NetworkSettings client={client} onConfirm={noConfirm} toast={() => {}} />,
        );
      });
      const json = JSON.stringify(tree?.toJSON());
      assert.ok(json.includes(TEXT.settings.network.sandbox.directExecution.field),
        "the opt-in switch row must render on the 网络 page");
      assert.ok(json.includes(TEXT.settings.network.sandbox.status.ok),
        "the sandbox status row must render on the 网络 page");
    } finally {
      (globalThis as { window?: unknown }).window = previousWindow;
    }
  });

  it("[heading-split] the two Groups on 网络 carry different headings, not the same one twice", () => {
    // Round 17 review: the opt-in Group reusing the page-level 沙箱网络
    // heading drew the same section rule twice with the same label. The
    // opt-in Group now carries directExecution.heading (沙箱/Sandbox) while
    // the network Group keeps 沙箱网络 — pinned here as a vocabulary pair so
    // neither heading can silently fall back to the other.
    const sandbox = TEXT.settings.network.sandbox;
    assert.ok(sandbox.directExecution.heading && sandbox.directExecution.heading !== sandbox.heading,
      "the opt-in heading must be its own, not the page-level 沙箱网络 heading");
    assert.equal(sandbox.directExecution.heading, "沙箱");
  });
});
