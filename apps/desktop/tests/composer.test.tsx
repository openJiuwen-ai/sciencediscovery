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
// Classic JSX runtime under tsx, so React has to be in scope here.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { Composer, ExpertFlyout, ModelMenu, PermissionFlyout, SessionSettingsMenu } from "../src/views/Composer.js";
import { filterExperts } from "../src/views/expert-catalog.js";
import { modelBrand } from "../src/views/model-brand.js";
import { modelLabel } from "../src/views/provider-name.js";

/** The dropdown only exists while open, and a static render never runs effects,
 *  so these cover the closed state: the triggers themselves. */
function render(
  running = false,
  options: {
    activeProjectId?: string;
    blocked?: string;
    landing?: boolean;
    limit?: string;
    projectName?: string;
    projects?: { id: string; name: string }[];
    tag?: { kind: "research" | "experiment" | "analysis"; label: string };
    uploading?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <Composer
      activeProjectId={options.activeProjectId}
      attachBlocked={options.blocked}
      attachLimit={options.limit}
      landing={options.landing}
      models={[{ id: "m1", name: "测试模型" } as never]}
      onApprovalMode={() => {}}
      onCreateProject={() => {}}
      onOpenSettings={() => {}}
      onSelectModel={() => {}}
      onSelectProject={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      onUpload={() => {}}
      projectName={options.projectName}
      projects={(options.projects ?? []) as never}
      running={running}
      selectedModelId="m1"
      tag={options.tag === undefined ? undefined : { ...options.tag, onClear: () => {} }}
      uploading={options.uploading ?? false}
    />,
  );
}

/** 会话设置's rows are rendered directly, since the menu they belong to is
 *  only mounted while open. */
function settingsMenu(approvalMode?: "ask_for_dangerous" | "always_allow", running = false): string {
  return renderToStaticMarkup(
    <SessionSettingsMenu
      approvalMode={approvalMode}
      onApprovalMode={() => {}}
      onClose={() => {}}
      running={running}
    />,
  );
}

test("the composer offers the model pill, upload and session settings", () => {
  const markup = render();
  assert.match(markup, /class="composer-model-pill"/);
  assert.match(markup, /aria-label="上传文件"/);
  assert.match(markup, /aria-label="会话设置"/);
  // The approval pill moved into 会话设置; a second copy in the footer would
  // give the same choice two homes.
  assert.doesNotMatch(markup, /composer-permission-pill/);
  assert.doesNotMatch(markup, /class="composer-options"/);
});

test("the plus uploads and states the per-file ceiling in its tooltip", () => {
  const markup = render(false, { limit: "1 GiB" });
  assert.match(markup, /单个文件最大 1 GiB/);
});

test("a blocked upload disables the plus and gives the reason on it", () => {
  const markup = render(false, { blocked: "这个会话已经归档，不能再写入。取消归档后才能上传。" });
  assert.match(
    markup,
    /<button[^>]*disabled=""[^>]*title="这个会话已经归档，不能再写入。取消归档后才能上传。"/,
  );
});

test("an upload in flight replaces the plus with a spinner rather than allowing a second", () => {
  const markup = render(false, { uploading: true });
  assert.match(markup, /<button[^>]*aria-label="上传文件"[^>]*disabled=""/);
  assert.match(markup, /class="spinner"/);
});

test("会话设置 carries 权限模式 and 专家, each with its current value", () => {
  const markup = settingsMenu("ask_for_dangerous");
  assert.match(markup, />权限模式</);
  assert.match(markup, />询问</);
  assert.match(markup, />专家</);
  assert.match(markup, />无</);
  // Both rows open a panel; neither is a dead end.
  assert.match(markup, /aria-haspopup="true"/);
  assert.match(markup, /为此对话绑定一位个人专家。/);
});

test("a permission option says on screen what it allows", () => {
  const markup = renderToStaticMarkup(
    <PermissionFlyout fullAccess={false} onApprovalMode={() => {}} onClose={() => {}} />,
  );
  // Both consequences are text in the row. They were `title`s, which only a
  // mouse reaches, and this is the one switch that widens the session's reach.
  assert.match(markup, /class="session-flyout-desc" id="session-permission-ask-desc">编辑外部文件和使用互联网时始终询问/u);
  assert.match(markup, /class="session-flyout-desc" id="session-permission-full-desc">可不受限制地访问互联网和您电脑上的任何文件/u);
  assert.doesNotMatch(markup, /title=/);
  // The name is the option; the sentence is its description, not part of it.
  assert.match(markup, /aria-label="请求批准"/);
  assert.match(markup, /aria-describedby="session-permission-ask-desc"/);
  assert.match(markup, /aria-describedby="session-permission-full-desc"/);
  // The mode in force is the one marked.
  assert.equal(markup.split("is-selected").length - 1, 1);
});

/** Two experts, enough to tell a catalog from a list of fixed choices. */
const EXPERTS = [
  { description: "Writes and runs code", id: "e1", name: "code-engineer" },
  { description: "Searches the literature", id: "e2", name: "literature-searcher" },
] as never[];

test("专家's flyout lists the experts with what each one does", () => {
  const markup = renderToStaticMarkup(
    <ExpertFlyout
      loading={false}
      onClose={() => {}}
      onSelect={() => {}}
      selectedId="e2"
      specialists={EXPERTS}
    />,
  );
  assert.match(markup, /请输入关键字搜索/);
  for (const expert of EXPERTS as unknown as { description: string; name: string }[]) {
    assert.match(markup, new RegExp(expert.name));
    assert.match(markup, new RegExp(expert.description));
  }
  // 无 stays the way to unbind, and stays at the top of the list. Creating an
  // expert is 设置's job now, so the flyout is only ever a choice.
  assert.match(markup, /class="expert-mark is-none"/);
  assert.ok(markup.indexOf("expert-mark is-none") < markup.indexOf("code-engineer"));
  assert.doesNotMatch(markup, /新建…/);
  // Exactly the bound expert is marked, and it is the one identified to AT.
  const selected = markup.match(/aria-current="true"[^>]*>[\s\S]*?class="expert-name">([^<]+)</g) ?? [];
  assert.equal(selected.length, 1);
  assert.match(selected[0] ?? "", /literature-searcher/);
});

test("the 专家 row names the bound expert rather than saying 无", () => {
  const markup = renderToStaticMarkup(
    <SessionSettingsMenu
      experts={EXPERTS}
      onApprovalMode={() => {}}
      onClose={() => {}}
      running={false}
      selectedSpecialistId="e2"
    />,
  );
  assert.match(markup, />literature-searcher</);
  assert.doesNotMatch(markup, />无</);
});

test("the search matches names, not words inside a description", () => {
  const experts = [
    { description: "Screens candidates", id: "a", name: "assessment-screener" },
    { description: "Feasibility analysis", id: "b", name: "creative-material-design" },
    { description: "Synthesizes assessment results", id: "c", name: "insight-aggregator" },
  ] as never[];
  // "as" appears in "feasibility" and "assessment"; only the name decides.
  assert.deepEqual(filterExperts(experts, "as").map((row) => row.id), ["a"]);
  // A substring of the name works anywhere, and case does not matter.
  assert.deepEqual(filterExperts(experts, " MATERIAL ").map((row) => row.id), ["b"]);
  assert.equal(filterExperts(experts, "").length, 3);
});

test("an empty catalog says so instead of showing a blank card", () => {
  const markup = renderToStaticMarkup(
    <ExpertFlyout
      loading={false}
      onClose={() => {}}
      onSelect={() => {}}
      specialists={[]}
    />,
  );
  assert.match(markup, /没有匹配的专家。/);
});

test("the 专家 row is named by its label and value, and its hint is attached", () => {
  const markup = settingsMenu();
  // No aria-label: the name comes from the row's own text, so 无 is read out
  // with 专家 instead of being hidden behind a bare label.
  assert.doesNotMatch(markup, /aria-label="专家"/);
  assert.match(markup, /aria-describedby="session-experts-hint"/);
  assert.match(markup, /class="sr-only" id="session-experts-hint">为此对话绑定一位个人专家。/u);
  // The drawn tooltip is decoration; the description above is what is read.
  assert.match(markup, /aria-hidden="true" class="session-menu-tip"/);
  assert.doesNotMatch(markup, /role="tooltip"/);
});

test("the permission row reads the mode the session is in", () => {
  assert.match(settingsMenu("always_allow"), />完全访问</);
  assert.match(settingsMenu("ask_for_dangerous"), />询问</);
});

test("permission cannot be switched mid-run", () => {
  assert.match(settingsMenu(undefined, true), /<button[^>]*aria-expanded="false"[^>]*disabled=""/);
});

test("the landing arrangement carries the project and the approval mode under the card", () => {
  const chosen = {
    activeProjectId: "p1",
    landing: true,
    projectName: "蛋白质组学",
    projects: [{ id: "p1", name: "蛋白质组学" }],
  };
  const markup = render(false, chosen);
  assert.match(markup, /class="composer is-landing"/);
  assert.match(markup, /有什么需要我帮忙的/u);
  assert.match(markup, /class="composer-strip-project"[\s\S]*蛋白质组学/u);
  // With no project chosen, the item is the invitation rather than a blank —
  // and it reads as one at rest, in the placeholder's own grey.
  const unchosen = render(false, { landing: true });
  assert.match(unchosen, /class="composer-strip-project is-placeholder"/);
  assert.match(unchosen, /选择项目/u);
  // The strip is the landing page's, not the transcript composer's.
  assert.doesNotMatch(render(), /composer-strip/);
});

test("a category chip sits in front of the input and can be taken off", () => {
  const markup = render(false, { landing: true, tag: { kind: "experiment", label: "实验设计" } });
  assert.match(markup, /class="composer-tag"/u);
  assert.match(markup, /data-kind="experiment"/u);
  assert.match(markup, /class="composer-tag-label">实验设计/u);
  assert.match(markup, /aria-label="取消分类"/u);
});

test("the model menu is one line per model, the provider carried by its mark", () => {
  const markup = renderToStaticMarkup(
    <ModelMenu
      models={[
        { id: "m1", model: "kimi-k3", name: "月之暗面 · Kimi-K3", providerId: "p1" } as never,
        { id: "m2", model: "DeepSeek-V4.1-Flash", name: "DeepSeek-V4.1-Flash" } as never,
      ]}
      onAdd={() => {}}
      onSelect={() => {}}
      providers={[{ id: "p1", presetId: "moonshot" } as never]}
      selectedId="m1"
    />,
  );
  // The row says the model; the provider is the icon, and the whole name is
  // still reachable as the tooltip.
  assert.match(markup, /class="model-option-label">Kimi-K3</u);
  assert.match(markup, /title="月之暗面 · Kimi-K3"/u);
  assert.match(markup, /data-brand="moonshot"/u);
  // A profile with no provider falls back to the neutral mark.
  assert.match(markup, /data-brand="deepseek"/u);
  // The model in use is ticked once; the others are not.
  assert.equal(markup.split('class="model-option-check"').length - 1, 1);
  assert.equal(markup.split('aria-current="true"').length - 1, 1);
  // Adding one is not a model: it comes after the hairline.
  assert.match(markup, /class="model-menu-divider"[\s\S]*添加自定义模型/u);
});

test("a row's mark comes from its provider, then from its name", () => {
  const providers = [
    { id: "p1", presetId: "dashscope" } as never,
    { id: "p2", name: "自定义网关" } as never,
  ];
  assert.equal(modelBrand({ model: "qwen-max", name: "阿里云百炼 · qwen-max", providerId: "p1" }, providers), "dashscope");
  // A custom gateway says nothing about what it serves, so the model name is
  // what the row goes on.
  assert.equal(modelBrand({ model: "qwen-max", name: "自定义网关 · qwen-max", providerId: "p2" }, providers), "dashscope");
  // A standalone profile has only its name to go on.
  assert.equal(modelBrand({ model: "glm-5", name: "glm-5" }), "zhipu");
  assert.equal(modelBrand({ model: "my-model", name: "my-model" }), "custom");
  assert.equal(modelLabel("月之暗面 · Kimi-K3"), "Kimi-K3");
  assert.equal(modelLabel("Kimi-K3"), "Kimi-K3");
});
