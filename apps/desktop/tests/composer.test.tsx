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

import type { Attachment } from "../src/app/attachments.js";
import { setLanguage, TEXT } from "../src/text.js";
import { EN } from "../src/text/en.js";
import { Composer, ExpertFlyout, ModelMenu, PermissionFlyout, SessionSettingsMenu } from "../src/views/Composer.js";
import { filterExperts } from "../src/views/expert-catalog.js";
import { modelBrand } from "../src/views/model-brand.js";
import { modelLabel } from "../src/views/provider-name.js";
import { act, create } from "./support/dom-renderer.js";

/** The dropdown only exists while open, and a static render never runs effects,
 *  so these cover the closed state: the triggers themselves. */
function render(
  running = false,
  options: {
    activeProjectId?: string;
    attachments?: Attachment[];
    blocked?: string;
    landing?: boolean;
    limit?: string;
    projectName?: string;
    projects?: { id: string; name: string }[];
    seededCommand?: { command: string; nonce: number; owner: string; text: string };
    surfaceKey?: string;
    tag?: { kind: "research" | "experiment" | "analysis"; label: string };
    uploading?: boolean;
    modelName?: string;
    approvalMode?: "ask_for_dangerous" | "always_allow";
    selectedModelId?: string | null;
    unavailableModel?: boolean;
  } = {},
): string {
  return renderToStaticMarkup(
    <Composer
      activeProjectId={options.activeProjectId}
      approvalMode={options.approvalMode}
      attachBlocked={options.blocked}
      attachLimit={options.limit}
      attachments={options.attachments ?? []}
      landing={options.landing}
      models={[{ id: "m1", name: options.modelName ?? "测试模型" } as never]}
      onApprovalMode={() => {}}
      onClearAttachments={() => {}}
      onCreateProject={() => {}}
      onOpenSettings={() => {}}
      onRemoveAttachment={() => {}}
      onRetryAttachment={() => {}}
      onSelectModel={() => {}}
      onSelectProject={() => {}}
      onSend={() => {}}
      onStop={() => {}}
      onUpload={() => {}}
      projectName={options.projectName}
      projects={(options.projects ?? []) as never}
      running={running}
      seededCommand={options.seededCommand}
      surfaceKey={options.surfaceKey}
      selectedModelId={options.selectedModelId === null ? undefined : options.selectedModelId ?? "m1"}
      unavailableModel={options.unavailableModel}
      tag={options.tag === undefined ? undefined : { ...options.tag, onClear: () => {} }}
      uploading={options.uploading ?? false}
    />,
  );
}

/** 会话设置's rows are rendered directly, since the menu they belong to is
 *  only mounted while open. */
function settingsMenu(evolve = false, ideaTree = false, onIdeaTree?: (draft: string) => void): string {
  return renderToStaticMarkup(
    <SessionSettingsMenu
      onClose={() => {}}
      onEvolve={evolve ? () => {} : undefined}
      onIdeaTree={ideaTree ? (onIdeaTree ?? (() => {})) : undefined}
    />,
  );
}

test("the composer offers the model pill, upload and session settings", () => {
  const markup = render();
  assert.match(markup, /class="composer-model-pill"/);
  assert.match(markup, /aria-label="上传文件"/);
  assert.match(markup, /aria-label="会话设置"/);
  // The footer selector is the only door to the mode (#1204) now that 会话设置
  // no longer lists it; the retired pilot class must not come back.
  assert.doesNotMatch(markup, /composer-permission-pill/);
  assert.doesNotMatch(markup, /class="composer-options"/);
  const longName = "Desktop configuration 长模型名称 85fedd8a-9420-47f7-9790-1ece4fd4cfa4";
  for (const landing of [false, true]) {
    const longMarkup = render(false, { modelName: longName, landing });
    assert.ok(longMarkup.includes(`class="model-name" title="${longName}">${longName}</span>`),
      "Truncation is visual only: the selected model keeps its complete text and tooltip");
  }
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

test("the files the turn carries sit above the input, and an empty tray takes no room", () => {
  const attachment: Attachment = {
    file: new File(["x"], "报告.pdf"),
    id: "a",
    name: "报告.pdf",
    size: 16896,
    status: "uploaded",
  };
  const markup = render(false, { attachments: [attachment] });
  // Above the input, inside the composer's own box: that is what makes the tray
  // read as part of what the turn will carry rather than as a list beside it.
  assert.match(markup, /class="composer has-attachments"/u);
  assert.ok(markup.indexOf("attach-tray") < markup.indexOf("composer-input"));
  assert.match(markup, /class="attach-name">报告\.pdf</u);
  // Nothing chosen: no tray, and no height reserved for one.
  const empty = render(false);
  assert.doesNotMatch(empty, /attach-tray/u);
  assert.match(empty, /class="composer"/u);
});

test("会话设置 carries 专家 and leaves 权限模式 to the footer control", () => {
  const markup = settingsMenu();
  assert.match(markup, />专家</);
  assert.match(markup, />无</);
  // The mode has its own control beside these settings (#1204); the row here was
  // the same two choices behind a second door.
  assert.doesNotMatch(markup, /权限模式/);
  assert.doesNotMatch(markup, /询问|完全访问/);
  assert.doesNotMatch(markup, /编辑外部文件和使用互联网时始终询问/);
  // The row that is left opens a panel; it is not a dead end.
  assert.match(markup, /aria-haspopup="true"/);
  assert.match(markup, /为此对话绑定一位个人专家。/);
});

test("会话设置 carries the way into program evolution above its own settings", () => {
  const markup = settingsMenu(true);
  assert.match(markup, />程序演进实验</);
  // It is an action, not a setting: it has no current value and no flyout.
  assert.ok(markup.indexOf("程序演进实验") < markup.indexOf("专家"));
  assert.doesNotMatch(markup, /aria-haspopup="true"[\s\S]*?程序演进实验/);

  // Without somewhere to go — a static render — the row is not drawn.
  assert.doesNotMatch(settingsMenu(), /程序演进实验/);
});

test("会话设置 carries the idea-tree entry under 程序演进实验", () => {
  const markup = settingsMenu(true, true);
  assert.match(markup, />研究思路树</);
  // It sits below the evolve entry and above the expert row, the order the
  // handoff gives the menu.
  assert.ok(markup.indexOf("程序演进实验") < markup.indexOf("研究思路树"));
  assert.ok(markup.indexOf("研究思路树") < markup.indexOf(">专家<"));
  // A settings menu that cannot open the card does not offer the row.
  assert.doesNotMatch(settingsMenu(true), /研究思路树/);
});

test("会话设置 can ask for a review now, and the same row stops one under way", async () => {
  const calls: string[] = [];
  const menu = (runningReview: boolean, reviewerEnabled = true) => (
    <SessionSettingsMenu
      automaticReviewEnabled={false}
      onApprovalMode={() => {}}
      onClose={() => {}}
      onRunReview={() => { calls.push("run"); }}
      onStopReview={() => { calls.push("stop"); }}
      reviewerEnabled={reviewerEnabled}
      reviewerRunning={runningReview}
      running={false}
    />
  );

  // 自动审阅 is off, and the row is still there: one decides whether a review
  // happens by itself, the other is the reader asking for one.
  const idle = renderToStaticMarkup(menu(false));
  assert.match(idle, />立即审查</u);
  assert.doesNotMatch(idle, />停止审查</u);

  const busy = renderToStaticMarkup(menu(true));
  assert.match(busy, />停止审查</u);
  assert.doesNotMatch(busy, />立即审查</u);

  // A row with nowhere to go is not drawn, as with 程序演进实验 above.
  assert.doesNotMatch(settingsMenu(), /立即审查/u);

  const row = (view: ReturnType<typeof create>) =>
    view.root.findAllByType("span").find((node) => node.props.className === "session-menu-label"
      && (node.props.children === "立即审查" || node.props.children === "停止审查"))?.parent;

  let view;
  await act(async () => { view = create(menu(true)); });
  try {
    const stop = row(view);
    assert.ok(stop);
    await act(async () => { (stop.props.onClick as () => void)(); });
    assert.deepEqual(calls, ["stop"]);
    // The master switch being off leaves a row that cannot do anything, so it
    // says so rather than accepting a click the server would ignore.
    await act(async () => { view.update(menu(false, false)); });
    const off = row(view);
    assert.ok(off);
    assert.equal(off.props.disabled, true);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("without a Session there is nothing to review, so the reviewer rows are not drawn", () => {
  const markup = renderToStaticMarkup(
    <SessionSettingsMenu
      automaticReviewEnabled={undefined}
      onApprovalMode={() => {}}
      onClose={() => {}}
      running={false}
    />,
  );
  // The welcome and draft composers pass no handlers, and rows that would
  // return early are not offered.
  assert.doesNotMatch(markup, /自动审阅|审查档位|立即审查|停止审查/u);
});

test("审查档位 stays open while automatic review is off, because 立即审查 reads it", () => {
  const menu = (reviewerEnabled: boolean) => renderToStaticMarkup(
    <SessionSettingsMenu
      automaticReviewEnabled={false}
      onApprovalMode={() => {}}
      onClose={() => {}}
      onReviewLevel={() => {}}
      onRunReview={() => {}}
      reviewerEnabled={reviewerEnabled}
      reviewLevel="quick"
      running={false}
    />,
  );
  // The markup of the whole row, up to the label: a `disabled` attribute there
  // is what takes the choice away.
  const levelRow = (markup: string) => {
    const label = markup.indexOf(">审查档位<");
    return markup.slice(markup.lastIndexOf("<button", label), label);
  };

  // Automatic review off: the row still chooses what a manual run will do.
  const available = menu(true);
  assert.doesNotMatch(levelRow(available), /disabled/u);
  assert.match(available, /title="自动审阅已关闭；立即审查仍会使用这个档位。"/u);
  // The master switch off: nothing can run at all, so the row says so.
  assert.match(levelRow(menu(false)), /disabled=""/u);
});

test("a permission option says on screen what it allows", () => {
  const markup = renderToStaticMarkup(
    <PermissionFlyout mode="ask_for_dangerous" onApprovalMode={() => {}} onClose={() => {}} />,
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
  // Idle: no running-turn note, so the flyout is not longer than its choices.
  assert.doesNotMatch(markup, /session-flyout-note/u);
});

test("opening the mode switch mid-run says when the change lands", () => {
  const markup = renderToStaticMarkup(
    <PermissionFlyout mode="ask_for_dangerous" onApprovalMode={() => {}} onClose={() => {}} running />,
  );
  // The note promises exactly what the server does: the switch stops the
  // session's kernels and shell sessions, and only a request the new policy
  // covers is settled (a direct-on-machine request still asks separately).
  assert.match(
    markup,
    /class="session-flyout-note">本轮仍在运行：切换影响后续工具调用，并会停掉本会话的科研内核与 Shell 会话（其中的内存状态会丢失；正在执行的工具会先跑完，切换随后生效）；仅结算新策略覆盖的批准，本机直接执行仍需单独确认；只放行当前请求请用「仅允许一次」。/u,
  );
});

test("the mid-run note is English in the English interface", () => {
  // The note is a sentence, not a key: the English interface has to get the
  // copy from en.ts. The language is module state, so the test puts it back for
  // whatever runs next.
  setLanguage("en");
  try {
    const markup = renderToStaticMarkup(
      <PermissionFlyout mode="ask_for_dangerous" onApprovalMode={() => {}} onClose={() => {}} running />,
    );
    // React escapes the apostrophes in "session's" as &#x27;, so the sentence is
    // compared in the form it reaches the document.
    const expected = EN.composer.permissionRunningHint.replace(/'/gu, "&#x27;");
    assert.ok(
      markup.includes(`class="session-flyout-note">${expected}<`),
      "the English flyout note is the English sentence from en.ts",
    );
    assert.doesNotMatch(markup, /本轮仍在运行/u, "the English interface does not print the Chinese note");
  } finally {
    setLanguage("zh-CN");
  }
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
      onClose={() => {}}
      selectedSpecialistId="e2"
    />,
  );
  assert.match(markup, />literature-searcher</);
  assert.doesNotMatch(markup, />无</);
});

test("a disabled bound expert stays named with a truthful session hint", () => {
  const expert = { description: "Searches the literature", id: "e2", name: "literature-searcher", enabled: false } as never;
  const markup = renderToStaticMarkup(<SessionSettingsMenu experts={[expert]} onClose={() => {}} selectedSpecialistId="e2" />);
  assert.ok(markup.includes(`literature-searcher · ${TEXT.composer.expertsDisabled}`));
  assert.ok(markup.includes(TEXT.composer.boundExpertDisabledHint));
  assert.doesNotMatch(markup, />无</);
  const flyout = renderToStaticMarkup(<ExpertFlyout loading={false} onClose={() => {}} onSelect={() => {}} selectedId="e2" specialists={[expert]} />);
  assert.match(flyout, /aria-current="true"[^>]*disabled=""/);
  assert.ok(flyout.includes(`literature-searcher · ${TEXT.composer.expertsDisabled}`));
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

test("the permission mode can be switched mid-run and says it affects later calls", () => {
  // The server switches the session's policy while a run is active and settles
  // the request the turn is blocked on (#1330). The footer control is the only
  // door, so it must stay open — with a title that scopes the change to the
  // tool calls still to come rather than claiming the run cannot be re-scoped.
  const markup = render(true, { approvalMode: "ask_for_dangerous" });
  const trigger = markup.match(/<button[^>]*class="composer-permission[^"]*"[^>]*>/u)?.[0];
  assert.ok(trigger !== undefined, "the permission control is drawn while running");
  assert.doesNotMatch(trigger, /disabled=""/, "the run no longer locks the control");
  assert.match(trigger, /title="权限模式（本轮进行中，更改会影响后续工具调用）"/u);
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

test("a design's command is a token in front of the sentence, not text", () => {
  const markup = render(false, {
    seededCommand: { command: "/evolve-design --algorithm puct", nonce: 1, owner: "s1", text: "让压缩比更高" },
    surfaceKey: "s1",
  });
  assert.match(markup, /class="composer-command"/u);
  assert.match(markup, /composer-command-text">\/evolve-design --algorithm puct</u);
  // The goal the dialog collected is the sentence after the token, ready to be
  // completed.
  assert.match(markup, /<textarea[^>]*>让压缩比更高<\/textarea>/u);
  // The dialog proposed the search, so the token can be taken back: it carries
  // its own ✕ rather than leaving sending as the only way out.
  assert.match(markup, /aria-label="移除指令"/u);
  // Once a search is seeded the composer is not waiting for any request; it
  // asks for the one sentence the design still needs.
  assert.match(markup, /placeholder="请描述你想要优化的对象和评估标准"/u);
  assert.equal(render(false).includes("请描述你想要优化的对象和评估标准"), false);
});

test("sending a seeded design joins the token to the sentence once", async () => {
  const sent: { command?: string; content: string }[] = [];
  let view;
  await act(async () => {
    view = create(
      <Composer
        attachments={[]}
        landing
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={() => {}}
        onClearAttachments={() => {}}
        onCreateProject={() => {}}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={(content, command) => { sent.push({ command, content }); }}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        running={false}
        seededCommand={{ command: "/evolve-design --algorithm puct", nonce: 1, owner: "s1", text: "让压缩比更高" }}
        surfaceKey="s1"
        selectedModelId="m1"
        uploading={false}
      />,
    );
  });
  try {
    const area = view.root.findByProps({ id: "composer-textarea" });
    await act(async () => {
      (area.props.onChange as (event: { target: { value: string } }) => void)({
        target: { value: "让压缩比更高，并且要快" },
      });
    });
    // The dialog keeps the last word on the flags, so sending from the composer
    // carries the token as seeded — there is no second confirmation dialog.
    const send = view.root.findByProps({ "aria-label": "发送" });
    await act(async () => { (send.props.onClick as () => void)(); });
    assert.deepEqual(sent, [
      { command: "/evolve-design --algorithm puct", content: "让压缩比更高，并且要快" },
    ]);
    // The token belonged to that message: the next draft starts empty.
    assert.equal(view.root.findByProps({ id: "composer-textarea" }).props.value, "");
    assert.equal(view.root.findAllByType("span").some((node) => node.props.className === "composer-command"), false);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("a seeded design carries the parameters the dialog collected", async () => {
  // The starting values and the editable set are part of the same message as
  // the flags: closing the dialog must not leave them behind.
  const sent: { command?: string; content: string; direction?: unknown }[] = [];
  const direction = { baseline: '{"ratio": 9}', editable: ["ratio"] };
  let view;
  await act(async () => {
    view = create(
      <Composer
        attachments={[]}
        landing
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={() => {}}
        onClearAttachments={() => {}}
        onCreateProject={() => {}}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={(content, command, carried) => { sent.push({ command, content, direction: carried }); }}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        running={false}
        seededCommand={{ command: "/evolve-design --algorithm puct", direction, nonce: 1, owner: "s1", text: "让压缩比更高" }}
        surfaceKey="s1"
        selectedModelId="m1"
        uploading={false}
      />,
    );
  });
  try {
    const send = view.root.findByProps({ "aria-label": "发送" });
    await act(async () => { (send.props.onClick as () => void)(); });
    assert.deepEqual(sent, [
      { command: "/evolve-design --algorithm puct", content: "让压缩比更高", direction },
    ]);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("a design's flags can be taken back without losing the sentence", async () => {
  const cleared: string[] = [];
  const element = (seededCommand: { command: string; nonce: number; owner: string; text: string } | undefined) => (
    <Composer
      attachments={[]}
      landing
      models={[{ id: "m1", name: "测试模型" } as never]}
      onApprovalMode={() => {}}
      onClearAttachments={() => {}}
      onClearCommand={() => { cleared.push("cleared"); }}
      onCreateProject={() => {}}
      onOpenSettings={() => {}}
      onRemoveAttachment={() => {}}
      onRetryAttachment={() => {}}
      onSelectModel={() => {}}
      onSelectProject={() => {}}
      onSend={() => { cleared.push("sent"); }}
      onStop={() => {}}
      onUpload={() => {}}
      projects={[]}
      running={false}
      seededCommand={seededCommand}
      selectedModelId="m1"
      surfaceKey="s1"
      uploading={false}
    />
  );
  const seeded = { command: "/evolve-design --algorithm puct", nonce: 1, owner: "s1", text: "让压缩比更高" };
  let view;
  await act(async () => { view = create(element(seeded)); });
  try {
    const close = view.root.findByProps({ "aria-label": "移除指令" });
    await act(async () => { (close.props.onClick as () => void)(); });
    // The flags are gone and nothing was sent; the goal the dialog collected
    // is still the draft, because it is the reader's sentence.
    assert.equal(view.root.findAllByType("span").some((node) => node.props.className === "composer-command"), false);
    assert.equal(view.root.findByProps({ id: "composer-textarea" }).props.value, "让压缩比更高");
    assert.deepEqual(cleared, ["cleared"]);

    // The shell dropping the seed takes the token with it — this is what a
    // session switch does, and the composer survives that switch.
    await act(async () => { view.update(element({ ...seeded, nonce: 2 })); });
    assert.equal(view.root.findAllByType("span").some((node) => node.props.className === "composer-command"), true);
    await act(async () => { view.update(element(undefined)); });
    assert.equal(view.root.findAllByType("span").some((node) => node.props.className === "composer-command"), false);
  } finally {
    await act(async () => { view.unmount(); });
  }
});

test("a deleted model is shown as unavailable instead of selecting the first profile", () => {
  const markup = render(false, { selectedModelId: null, unavailableModel: true });
  assert.match(markup, /原模型已删除，请重新选择/u);
  assert.doesNotMatch(markup, /class="model-name">测试模型/u);
});

test("the permission selector follows the + and settings buttons and names the active mode", () => {
  const markup = render(false, { approvalMode: "ask_for_dangerous" });
  const plus = markup.indexOf('class="composer-plus"');
  const settings = markup.indexOf("composer-settings");
  const selector = markup.indexOf("composer-permission");
  assert.ok(plus >= 0 && settings > plus, "+ then settings are drawn first");
  assert.ok(selector > settings, "the selector is the third control, not tucked into the menu");
  assert.match(markup, /aria-label="请求批准"/u);
  assert.match(markup, /composer-permission-label">请求批准</u);
  assert.doesNotMatch(markup, /composer-permission is-danger/u, "the asking mode is not the warning colour");
});

test("full access is the one mode drawn in the warning colour", () => {
  const markup = render(false, { approvalMode: "always_allow" });
  assert.match(markup, /class="composer-permission is-danger"/u);
  assert.match(markup, /composer-permission-label">完全访问</u);
  assert.match(markup, /aria-label="完全访问"/u);
});

test("the selector opens the two scope explanations and reports the choice", async () => {
  const chosen: string[] = [];
  // Opening a composer menu registers a document-level dismissal listener; this
  // suite mounts React without a DOM, so the one call it makes is stubbed.
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { addEventListener() {}, removeEventListener() {} };
  let view;
  await act(async () => {
    view = create(
      <Composer
        surfaceKey="s1"
        approvalMode="always_allow"
        attachments={[]}
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={(mode) => { chosen.push(mode); }}
        onClearAttachments={() => {}}
        onCreateProject={() => {}}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={() => {}}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        running={false}
        selectedModelId="m1"
        uploading={false}
      />,
    );
  });
  try {
    const trigger = view.root.findByProps({ "aria-label": "完全访问" });
    await act(async () => {
      (trigger.props.onClick as (event: { stopPropagation: () => void }) => void)({ stopPropagation() {} });
    });
    const opened = JSON.stringify(view.toJSON());
    assert.match(opened, /编辑外部文件和使用互联网时始终询问/u);
    assert.match(opened, /可不受限制地访问互联网和您电脑上的任何文件/u);
    const asking = view.root.findByProps({ "aria-label": "请求批准" });
    await act(async () => { (asking.props.onClick as () => void)(); });
    assert.deepEqual(chosen, ["ask_for_dangerous"]);
  } finally {
    await act(async () => { view.unmount(); });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("with nothing remembered the control asks for approval", () => {
  // The shell resolves the effective default (project or global defaultApprovalMode)
  // before the composer sees it; when nothing is set anywhere that default is asking,
  // so the closed control never needs a third state (#1204 owner decision).
  const markup = render();
  assert.match(markup, /aria-label="请求批准"/u);
  assert.match(markup, /composer-permission-label">请求批准</u);
  assert.doesNotMatch(markup, /is-danger/u, "asking is not the warning colour");
});

test("with no mode chosen neither permission option claims to be the choice", () => {
  const markup = renderToStaticMarkup(<PermissionFlyout onApprovalMode={() => {}} onClose={() => {}} />);
  assert.equal(markup.split("is-selected").length - 1, 0, "no row is marked");
  assert.equal(markup.split("session-flyout-check").length - 1, 0, "no tick is drawn");
});

test("a send that answers false keeps the draft, and the same send then goes out", async () => {
  // The Idea Tree card defers by answering `false`; the words have to stay in the
  // box until it confirms, or the reader loses what they typed.
  const attempts: string[] = [];
  let accept = false;
  let view: { root: never; unmount: () => void };
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { addEventListener() {}, removeEventListener() {} };
  await act(async () => {
    view = create(
      <Composer
        surfaceKey="s1"
        attachments={[]}
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={() => {}}
        onClearAttachments={() => {}}
        onCreateProject={() => {}}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={(content) => { attempts.push(content); return accept; }}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        selectedModelId="m1"
        uploading={false}
      />,
    ) as never;
  });
  try {
    const textarea = (view!.root as unknown as { findByType: (type: string) => { props: { onChange?: (event: { target: { value: string } }) => void; value?: string } } })
      .findByType("textarea");
    await act(async () => { textarea.props.onChange?.({ target: { value: "/idea-tree-team 分析钙钛矿" } }); });

    const send = (view!.root as unknown as { findAllByType: (type: string) => { props: { "aria-label"?: string; onClick?: () => void } }[] })
      .findAllByType("button")
      .find((node) => node.props["aria-label"] === TEXT.composer.send);
    assert.ok(send, "the send button is drawn");

    await act(async () => { send!.props.onClick?.(); });
    assert.deepEqual(attempts, ["/idea-tree-team 分析钙钛矿"], "the send was attempted");
    // The deferred send answered false, so the draft is untouched.
    assert.equal(textarea.props.value, "/idea-tree-team 分析钙钛矿");

    // The card confirmed: the same words, sent once, and the box is cleared.
    accept = true;
    await act(async () => { send!.props.onClick?.(); });
    assert.deepEqual(attempts, ["/idea-tree-team 分析钙钛矿", "/idea-tree-team 分析钙钛矿"]);
    assert.equal(textarea.props.value, "");
  } finally {
    await act(async () => { view!.unmount(); });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("the idea-tree row hands the composer draft to the parameters card", async () => {
  // The card's token carries the objective, and `create_idea_research` needs
  // one, so a sentence the reader already wrote is handed to the card instead of
  // being dropped when it opens — the row used to be called with no text at all.
  const received: string[] = [];
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { addEventListener() {}, removeEventListener() {} };
  const mounted: Array<ReturnType<typeof create>> = [];
  await act(async () => {
    mounted.push(create(
      <Composer
        surfaceKey="s1"
        attachments={[]}
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={() => {}}
        onClearAttachments={() => {}}
        onCreateProject={() => {}}
        onIdeaTree={(draft) => { received.push(draft); }}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={() => true}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        running={false}
        selectedModelId="m1"
        uploading={false}
      />,
    ));
  });
  const view = mounted[0];
  assert.ok(view, "the composer mounted");
  try {
    const textarea = view.root.findByType("textarea");
    await act(async () => { textarea.props.onChange?.({ target: { value: "研究钙钛矿带隙" } }); });

    const trigger = view.root.findAllByType("button").find((node) => node.props["aria-label"] === "会话设置");
    assert.ok(trigger, "会话设置 is drawn");
    await act(async () => { trigger.props.onClick?.({ stopPropagation() {} }); });

    const row = view.root.findAllByType("span")
      .find((node) => node.props.className === "session-menu-label" && node.props.children === TEXT.composer.ideaTree)?.parent;
    assert.ok(row, "the idea-tree row is drawn");
    await act(async () => { row.props.onClick?.(); });

    assert.deepEqual(received, ["研究钙钛矿带隙"], "the draft rides with the row");
  } finally {
    await act(async () => { view.unmount(); });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("a seeded idea-tree token sends the command with the task written under it", async () => {
  // The parameters card seeds this token instead of sending anything, so the
  // send is the reader's: the composer hands the shell the command and the
  // sentence as the two halves of one message.
  const sent: { content: string; command?: string }[] = [];
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { addEventListener() {}, removeEventListener() {} };
  const mounted: Array<ReturnType<typeof create>> = [];
  await act(async () => {
    mounted.push(create(
      <Composer
        attachments={[]}
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={() => {}}
        onClearAttachments={() => {}}
        onClearCommand={() => {}}
        onCreateProject={() => {}}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={(content, command) => { sent.push({ content, command }); return true; }}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        running={false}
        seededCommand={{ command: "/idea-tree-team", nonce: 1, owner: "s1", text: "研究钙钛矿带隙" }}
        surfaceKey="s1"
        selectedModelId="m1"
        uploading={false}
      />,
    ));
  });
  const view = mounted[0];
  assert.ok(view, "the composer mounted");
  try {
    const send = view.root.findAllByType("button").find((node) => node.props["aria-label"] === TEXT.composer.send);
    assert.ok(send, "the send button is drawn");
    await act(async () => { send.props.onClick?.(); });
    assert.deepEqual(sent, [{ command: "/idea-tree-team", content: "研究钙钛矿带隙" }],
      "the token and its task leave as one message");
  } finally {
    await act(async () => { view.unmount(); });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("an idea-tree token without a task cannot be sent, and asks for a research task", async () => {
  // The parameters card seeds the token with an empty box; the reader has to
  // write the question before anything can leave, and the box has to ask for a
  // research task rather than a design goal.
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { addEventListener() {}, removeEventListener() {} };
  const mounted: Array<ReturnType<typeof create>> = [];
  await act(async () => {
    mounted.push(create(
      <Composer
        attachments={[]}
        models={[{ id: "m1", name: "测试模型" } as never]}
        onApprovalMode={() => {}}
        onClearAttachments={() => {}}
        onClearCommand={() => {}}
        onCreateProject={() => {}}
        onOpenSettings={() => {}}
        onRemoveAttachment={() => {}}
        onRetryAttachment={() => {}}
        onSelectModel={() => {}}
        onSelectProject={() => {}}
        onSend={() => true}
        onStop={() => {}}
        onUpload={() => {}}
        projects={[]}
        running={false}
        seededCommand={{ command: "/idea-tree-team", nonce: 1, owner: "s1", text: "" }}
        surfaceKey="s1"
        selectedModelId="m1"
        uploading={false}
      />,
    ));
  });
  const view = mounted[0];
  assert.ok(view, "the composer mounted");
  try {
    const send = () => view.root.findAllByType("button").find((node) => node.props["aria-label"] === TEXT.composer.send);
    const button = send();
    assert.ok(button, "the send button is drawn");
    const textarea = view.root.findByType("textarea");

    assert.equal(button.props.disabled, true, "an empty task cannot be sent");
    assert.equal(textarea.props.placeholder, TEXT.composer.ideaTreePlaceholder,
      "the token asks for a research task, not a design goal");

    await act(async () => { textarea.props.onChange?.({ target: { value: "研究钙钛矿带隙" } }); });
    const enabled = send();
    assert.ok(enabled, "the send button is drawn");
    assert.equal(enabled.props.disabled, false, "writing the task enables the send");
  } finally {
    await act(async () => { view.unmount(); });
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});

test("a seed belongs to the session that created it, not to the one opened next", async () => {
  // #1434: the parameters card seeds the command instead of sending it, and the
  // shell clears that seed in an effect — after the composer of the session
  // being opened has already mounted. So the composer itself has to ignore a
  // seed whose owner is another surface, in its initial state as well: a
  // sentence typed in one session must not arrive in the other one's input.
  const originalDocument = (globalThis as { document?: unknown }).document;
  (globalThis as { document?: unknown }).document = { addEventListener() {}, removeEventListener() {} };
  const seed = { command: "/idea-tree-team", nonce: 1, owner: "session-b", text: "这是一个测试" };
  const element = (surfaceKey: string) => (
    <Composer
      attachments={[]}
      models={[{ id: "m1", name: "测试模型" } as never]}
      onApprovalMode={() => {}}
      onClearAttachments={() => {}}
      onCreateProject={() => {}}
      onOpenSettings={() => {}}
      onRemoveAttachment={() => {}}
      onRetryAttachment={() => {}}
      onSelectModel={() => {}}
      onSelectProject={() => {}}
      onSend={() => true}
      onStop={() => {}}
      onUpload={() => {}}
      projects={[]}
      running={false}
      seededCommand={seed}
      selectedModelId="m1"
      surfaceKey={surfaceKey}
      uploading={false}
    />
  );
  try {
    for (const [surfaceKey, expected] of [["session-a", ""], ["session-b", "这是一个测试"]] as const) {
      let view;
      await act(async () => { view = create(element(surfaceKey)); });
      try {
        const area = view.root.findByProps({ id: "composer-textarea" });
        assert.equal(area.props.value, expected,
          `the composer of ${surfaceKey} shows ${expected === "" ? "nothing" : "the sentence"} for a seed owned by session-b`);
        const drawn = view.root.findAllByType("span").some((node) => node.props.className === "composer-command");
        assert.equal(drawn, expected !== "", "the token is drawn with the sentence it belongs to, and nowhere else");
      } finally {
        await act(async () => { view.unmount(); });
      }
    }
  } finally {
    if (originalDocument === undefined) delete (globalThis as { document?: unknown }).document;
    else (globalThis as { document?: unknown }).document = originalDocument;
  }
});
