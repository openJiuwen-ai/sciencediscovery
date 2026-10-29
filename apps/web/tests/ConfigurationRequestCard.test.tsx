// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { MODEL_API_VARIANTS, DEFAULT_MODEL_API_VARIANT, type ModelApiProtocol } from "@sciencediscovery/schema";
import { ConfigurationRequestCard, type ConfigurationRequestActions } from "../src/configuration/ConfigurationRequestCard.js";
import { ApiRequestError } from "../src/api/auth.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { genericConfigurationPresentation, isConfigurationProposalTrace, mergeConfigurationRequests, shouldPollConfigurationRequest } from "../src/configuration/presentation.js";
import type { ChatMessage } from "@sciencediscovery/schema";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

test("CFG-Q08: only an actual configuration proposal completion refreshes cards; historical proposal traces remain readable", () => {
  assert.equal(isConfigurationProposalTrace({ name: "configuration", details: { configurationAction: "search" } }), false);
  assert.equal(isConfigurationProposalTrace({ name: "configuration", details: { configurationAction: "describe" } }), false);
  assert.equal(isConfigurationProposalTrace({ name: "configuration", details: { configurationAction: "propose" } }), true);
  assert.equal(isConfigurationProposalTrace({ name: "configuration", details: null }), false);
  assert.equal(isConfigurationProposalTrace({ name: "paper_search", details: { configurationAction: "propose" } }), false);
  assert.equal(isConfigurationProposalTrace({ name: "propose_configuration" }), true);
  assert.equal(isConfigurationProposalTrace({ name: "propose_connector_enable" }), true);
});

function request(overrides: Partial<ConfigurationRequestView> = {}): ConfigurationRequestView {
  return {
    id: "cfg-1", projectId: "p1", sessionId: "s1", runId: "r1", revision: 2, stateVersion: 3, schemaVersion: 1, adapterVersion: 1,
    capabilityId: "model.select", state: "awaiting_confirmation", reason: { code: "MODEL_REQUIRED", message: "A different model is needed." },
    scope: { kind: "session", id: "s1" }, fields: [{ id: "modelId", label: "Task model", kind: "enum", required: true,
      choices: [{ id: "a", label: "Model A" }, { id: "b", label: "Model B" }], value: "a" }],
    changes: [{ field: "Task model", before: "Old model", after: "Model A" }],
    impact: { resourceLocation: "Model registry", effectiveScope: "This session only", message: "Other sessions keep their current model." },
    verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, previewDigest: "sha256:preview-2",
    activation: { mode: "same_run", state: "not_requested" }, resumption: { state: "not_requested" },
    allowedActions: ["preview", "apply", "dismiss"], createdAt: "2026-10-19T00:00:00Z", updatedAt: "2026-10-19T00:00:00Z",
    ...(["model.connect", "model.repair_credential"].includes(overrides.capabilityId ?? "") ? { endpointAuthorization: {
      endpointTarget: "https://api.example.test/v1/chat/completions", host: "api.example.test", classification: "trusted_preset" as const, status: "trusted" as const, revision: overrides.revision ?? 2,
    } } : {}), ...overrides,
  };
}
function actions(overrides: Partial<ConfigurationRequestActions> = {}): ConfigurationRequestActions {
  return { preview: async () => request(), credential: async () => ({ handle: "opaque", expiresAt: "2099-01-01T00:00:00Z" }),
    decide: async () => request({ state: "applied", allowedActions: [] }), query: async () => request(),
    continue: async () => request(), reversal: async () => request(), ...overrides };
}
async function mount(view: ConfigurationRequestView, api = actions(), onUpdate: (value: ConfigurationRequestView) => void = () => undefined, locale: "en" | "zh" = "en") {
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: locale }, createElement(ConfigurationRequestCard, {
    request: view, actions: api, onUpdate,
  }))); });
  return renderer!;
}
const button = (renderer: ReactTestRenderer, text: string) => renderer.root.findAllByType("button").find((item) => item.children.join("") === text)!;

test("CFG generic renderer requires a new preview after edits and binds approval to the exact revision and digest", async () => {
  const decisions: unknown[] = [];
  const previews: unknown[] = [];
  const updates: ConfigurationRequestView[] = [];
  const renderer = await mount(request(), actions({
    preview: async (input) => { previews.push(input); return request({ revision: 3, previewDigest: "sha256:preview-3" }); },
    decide: async (input) => { decisions.push(input); return request({ state: "applied" }); },
  }), (value) => updates.push(value));
  assert.deepEqual(decisions, []);
  assert.match(JSON.stringify(renderer.toJSON()), /This session only/);
  await act(async () => { renderer.root.findByType("select").props.onChange({ target: { value: "b" } }); });
  assert.equal(button(renderer, "Confirm this change").props.disabled, true);
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(previews, [{ expectedRevision: 2, values: { modelId: "b" } }]);
  assert.equal(updates[0]?.previewDigest, "sha256:preview-3");
  // Parent has not supplied the new snapshot yet: do not approve the old preview.
  assert.equal(button(renderer, "Confirm this change").props.disabled, true);
  await act(async () => { renderer.update(createElement(ConfigurationRequestCard, { request: request({ revision: 3, previewDigest: "sha256:preview-3" }),
    actions: actions({ decide: async (input) => { decisions.push(input); return request({ state: "applied" }); } }), onUpdate: () => undefined })); });
  await act(async () => { button(renderer, "Confirm this change").props.onClick(); });
  assert.deepEqual(decisions, [{ revision: 3, previewDigest: "sha256:preview-3", decision: "apply" }]);
  await act(async () => { renderer.unmount(); });
});

test("CFG credentials are sent only through the dedicated channel and are cleared before preview", async () => {
  const secret = "test-secret-never-in-a-snapshot";
  const credentials: unknown[] = [];
  const previews: unknown[] = [];
  const updates: unknown[] = [];
  const renderer = await mount(request({ capabilityId: "model.repair_credential", fields: [
    { id: "apiKey", label: "API key", kind: "credential", required: true, status: "missing" },
  ] }), actions({
    credential: async (input) => { credentials.push(input); return { handle: "draft-handle", expiresAt: "2099-01-01T00:00:00Z" }; },
    preview: async (input) => { previews.push(input); return request({ capabilityId: "model.repair_credential", revision: input.expectedRevision + 1,
      fields: [{ id: "apiKey", label: "API key", kind: "credential", required: true, status: input.credentialHandle ? "provided" : "missing" }] }); },
  }), (value) => updates.push(value));
  await act(async () => { renderer.root.findByType("input").props.onChange({ target: { value: secret } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(credentials, [{ expectedRevision: 3, fieldId: "apiKey", secret }]);
  assert.deepEqual(previews, [{ expectedRevision: 2, values: {} }, { expectedRevision: 3, values: {}, credentialHandle: "draft-handle" }]);
  assert.equal(renderer.root.findByType("input").props.value, "");
  assert.doesNotMatch(JSON.stringify(updates), /test-secret|draft-handle/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /test-secret|draft-handle/);
  await act(async () => { renderer.unmount(); });
});

test("CFG conflicts block old approvals and never echo raw credential-bearing errors", async () => {
  let reads = 0;
  const renderer = await mount(request(), actions({
    decide: async () => { throw new ApiRequestError("provider returned test-secret", 409, "STALE_CONFIGURATION_PREVIEW"); },
    query: async () => { reads++; return request({ state: "stale", allowedActions: ["preview", "query"] }); },
  }));
  await act(async () => { button(renderer, "Confirm this change").props.onClick(); });
  assert.equal(button(renderer, "Confirm this change").props.disabled, true);
  assert.match(JSON.stringify(renderer.toJSON()), /Refresh it/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /test-secret/);
  await act(async () => { button(renderer, "Refresh current state").props.onClick(); });
  assert.equal(reads, 1);
  await act(async () => { renderer.unmount(); });
});

test("CFG saved records collapse with separate activation and continuation results and retain disclosure", async () => {
  const renderer = await mount(request({ state: "applied", activation: { mode: "same_run", state: "active" },
    resumption: { state: "failed" }, allowedActions: ["continue"] }));
  assert.equal(renderer.root.findByType("details").props.open, false);
  assert.equal(renderer.root.findAllByType("input").length, 0);
  const content = JSON.stringify(renderer.toJSON());
  assert.match(content, /Saved/);
  assert.match(content, /Verified active/);
  assert.match(content, /Continuation failed/);
  await act(async () => { const target = { open: true }; renderer.root.findByType("details").props.onToggle({ target, currentTarget: target }); });
  assert.equal(renderer.root.findByType("details").props.open, true);
  assert.ok(button(renderer, "Retry activation / continuation"));
  await act(async () => { renderer.unmount(); });
});

test("CFG needs-fix inputs use registered labels, safe help links, and Chinese action text", async () => {
  const renderer = await mount(request({ state: "needs_fix", allowedActions: ["preview", "dismiss"], fields: [
    { id: "baseUrl", label: "API 地址", kind: "url", required: true, value: "https://api.example.test", description: "服务地址", help: { label: "帮助", url: "javascript:alert(1)" } },
  ], error: { code: "NETWORK_UNREACHABLE", message: "无法连接模型服务", field: "baseUrl", retryable: true } }), actions(), () => undefined, "zh");
  const input = renderer.root.findByType("input");
  assert.equal(input.props.type, "url");
  assert.equal(input.props["aria-invalid"], true);
  assert.equal(renderer.root.findByType("label").props.htmlFor, input.props.id);
  assert.equal(renderer.root.findAllByType("a").length, 0);
  assert.ok(button(renderer, "刷新修改方案"));
  assert.match(JSON.stringify(renderer.toJSON()), /需要修正/);
  await act(async () => { renderer.unmount(); });
});

test("CFG leaving the card during target preview prevents a later credential upload", async () => {
  let finishTarget!: (value: ConfigurationRequestView) => void;
  const target = new Promise<ConfigurationRequestView>((resolve) => { finishTarget = resolve; });
  let uploads = 0;
  const renderer = await mount(request({ fields: [{ id: "apiToken", label: "API key", kind: "credential", required: true, status: "missing" }] }),
    actions({ preview: async () => target, credential: async () => { uploads++; return { handle: "unused", expiresAt: "2099-01-01T00:00:00Z" }; } }));
  await act(async () => { renderer.root.findByType("input").props.onChange({ target: { value: "do-not-send-after-leaving" } }); });
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  await act(async () => { renderer.unmount(); });
  await act(async () => { finishTarget(request({ revision: 3 })); await target; });
  assert.equal(uploads, 0);
});

test("CFG model protocol changes use the existing model metadata to update the variant before preview", async () => {
  const [first, second] = Object.keys(MODEL_API_VARIANTS) as ModelApiProtocol[];
  const previews: unknown[] = [];
  const renderer = await mount(request({ capabilityId: "model.connect", fields: [
    { id: "apiProtocol", kind: "enum", label: "Protocol", required: true, value: first!, choices: Object.keys(MODEL_API_VARIANTS).map((id) => ({ id, label: id })) },
    { id: "apiVariant", kind: "enum", label: "Variant", required: true, value: DEFAULT_MODEL_API_VARIANT[first!], choices: MODEL_API_VARIANTS[first!].map((id) => ({ id, label: id })) },
  ] }), actions({ preview: async (input) => { previews.push(input); return request({ revision: 3 }); } }));
  await act(async () => { renderer.root.findByProps({ name: "apiProtocol" }).props.onChange({ target: { value: second! } }); });
  assert.equal(renderer.root.findByProps({ name: "apiVariant" }).props.value, DEFAULT_MODEL_API_VARIANT[second!]);
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(previews, [{ expectedRevision: 2, values: { apiProtocol: second, apiVariant: DEFAULT_MODEL_API_VARIANT[second!] } }]);
  await act(async () => { renderer.unmount(); });
});



function choiceRequest(overrides: Partial<ConfigurationRequestView> = {}): ConfigurationRequestView {
  return request({ protocolVersion: 3, capabilityId: "connector.enable", selectedOptionId: "save", fields: [], options: [
    { id: "save", kind: "persisted_apply", label: "Save for this session", description: "Future tasks can use PubMed.", available: true },
    { id: "once", kind: "run_overlay", label: "Use for this task", description: "Session settings stay unchanged.", available: true },
    { id: "web", kind: "alternative", label: "Use Web search", description: "Use the existing Web tool.", available: true },
    { id: "dismiss", kind: "dismiss", label: "Do not configure", description: "Return the choice to the task.", available: true },
  ], ...overrides });
}

test("CFG-T30 option changes preview on the server before allowing the exact selected choice", async () => {
  const previews: unknown[] = [];
  const decisions: unknown[] = [];
  const updates: ConfigurationRequestView[] = [];
  const next = choiceRequest({ revision: 3, selectedOptionId: "once", previewDigest: "sha256:once" });
  const api = actions({ preview: async input => { previews.push(input); return next; }, decide: async input => { decisions.push(input); return choiceRequest({ state: "applied" }); } });
  const renderer = await mount(choiceRequest(), api, value => updates.push(value));
  const once = renderer.root.findAllByType("input").find(input => input.props.type === "radio" && input.props.value === "once")!;
  await act(async () => { once.props.onChange(); });
  assert.deepEqual(previews, [{ expectedRevision: 2, values: {}, selectedOptionId: "once" }]);
  assert.equal(button(renderer, "Confirm choice and continue").props.disabled, true);
  assert.equal(updates[0]?.selectedOptionId, "once");
  await act(async () => renderer.update(createElement(ConfigurationRequestCard, { request: next, actions: api, onUpdate() {} })));
  await act(async () => { button(renderer, "Confirm choice and continue").props.onClick(); });
  assert.deepEqual(decisions, [{ revision: 3, previewDigest: "sha256:once", decision: "apply", selectedOptionId: "once" }]);
  await act(async () => renderer.unmount());
});

test("CFG single available path is a scope-correct summary without changing the server selection", async () => {
  const options = choiceRequest().options!.filter(option => option.id === "save" || option.id === "dismiss");
  for (const [scope, label] of [
    [{ kind: "session", id: "s1" }, "当前会话"], [{ kind: "project", id: "p1" }, "当前项目"], [{ kind: "global" }, "全局设置"],
  ] as const) {
    const renderer = await mount(choiceRequest({ options, scope, activation: { mode: "next_run", state: "not_requested" } }), actions(), () => undefined, "zh");
    assert.equal(renderer.root.findAllByType("input").filter(input => input.props.type === "radio").length, 0);
    assert.ok(renderer.root.findAllByType("strong").some(item => item.children.join("") === `保存配置后继续 · ${label} · 后续运行生效`));
    assert.ok(button(renderer, "暂不配置，返回任务"));
    await act(async () => renderer.unmount());
  }
  const calls: unknown[] = [];
  const restored = await mount(choiceRequest({ options, selectedOptionId: "dismiss" }), actions({ preview: async input => { calls.push(input); return choiceRequest(); } }));
  assert.deepEqual(calls, [], "rendering a single path must not select or preview it automatically");
  assert.equal(button(restored, "Confirm choice and continue").props.disabled, true);
  await act(async () => { button(restored, "Select this path and refresh").props.onClick(); });
  assert.deepEqual(calls, [{ expectedRevision: 2, values: {}, selectedOptionId: "save" }]);
  await act(async () => restored.unmount());
});

test("CFG simplified paths retain alternatives and disabled reasons without inventing an available choice", async () => {
  const base = choiceRequest().options!;
  for (const id of ["once", "web"]) {
    const renderer = await mount(choiceRequest({ options: base.filter(option => option.id === id || option.id === "dismiss"), selectedOptionId: id }), actions());
    assert.equal(renderer.root.findAllByType("input").filter(input => input.props.type === "radio").length, 0);
    assert.match(JSON.stringify(renderer.toJSON()), id === "once" ? /Session settings stay unchanged/ : /Use the existing Web tool/);
    assert.equal(button(renderer, "Confirm choice and continue").props.disabled, false);
    await act(async () => renderer.unmount());
  }
  for (const available of [0, 1, 2]) {
    const options = base.map((option, index) => option.kind === "dismiss" || index < available ? option : { ...option, available: false, unavailableReason: `Unavailable ${option.id}` });
    const calls: unknown[] = [];
    const renderer = await mount(choiceRequest({ options }), actions({ decide: async input => { calls.push(input); return choiceRequest(); } }));
    const radios = renderer.root.findAllByType("input").filter(input => input.props.type === "radio");
    assert.equal(radios.length, available > 1 ? 3 : 0);
    for (const option of options.filter(option => !option.available)) assert.ok(JSON.stringify(renderer.toJSON()).includes(option.unavailableReason!));
    assert.equal(button(renderer, "Confirm choice and continue").props.disabled, available === 0);
    assert.equal(button(renderer, "Do not configure · return to task").props.disabled, false);
    if (!available) {
      assert.match(JSON.stringify(renderer.toJSON()), /No configuration path is currently available/);
      await act(async () => { button(renderer, "Confirm choice and continue").props.onClick(); });
      assert.deepEqual(calls, []);
    } else if (available > 1) assert.equal(radios.filter(radio => radio.props.disabled).length, 1);
    await act(async () => renderer.unmount());
  }
});

test("CFG single-path edits require an explicit refresh before the exact revision can be confirmed", async () => {
  let latest = choiceRequest({ options: choiceRequest().options!.filter(option => option.id === "save" || option.id === "dismiss"),
    fields: [{ id: "level", kind: "enum", label: "Review level", required: true, value: "quick", choices: [{ id: "quick", label: "quick" }, { id: "deep", label: "deep" }] }] });
  const previews: unknown[] = []; const decisions: unknown[] = []; let renderer: ReactTestRenderer;
  const api = actions({ preview: async input => { previews.push(input); return { ...latest, revision: 3, previewDigest: "sha256:refreshed", fields: [{ ...latest.fields[0]!, value: "deep" }] }; },
    decide: async input => { decisions.push(input); return { ...latest, state: "applied", allowedActions: [] }; } });
  const draw = () => createElement(ConfigurationRequestCard, { request: latest, actions: api, onUpdate: (value: ConfigurationRequestView) => { latest = value; renderer.update(draw()); } });
  await act(async () => { renderer = create(draw()); });
  await act(async () => { renderer.root.findByType("select").props.onChange({ target: { value: "deep" } }); });
  assert.deepEqual(previews, []);
  assert.equal(button(renderer!, "Confirm choice and continue").props.disabled, true);
  assert.match(JSON.stringify(renderer!.toJSON()), /Fields changed.*not applied until confirmation/);
  assert.ok(button(renderer!, "Refresh proposed changes"));
  await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  assert.deepEqual(previews, [{ expectedRevision: 2, values: { level: "deep" }, selectedOptionId: "save" }]);
  assert.equal(button(renderer!, "Confirm choice and continue").props.disabled, false);
  await act(async () => { button(renderer!, "Confirm choice and continue").props.onClick(); });
  assert.deepEqual(decisions, [{ revision: 3, previewDigest: "sha256:refreshed", decision: "apply", selectedOptionId: "save" }]);
  await act(async () => renderer!.unmount());
});

test("CFG-T32 refusal is a single footer action while configuration paths remain selectable", async () => {
  for (const locale of ["en", "zh"] as const) {
    const calls: unknown[] = [];
    const api = actions({ preview: async input => { calls.push(input); return choiceRequest({ revision: 3, selectedOptionId: "dismiss", previewDigest: "sha256:dismiss" }); },
      decide: async input => { calls.push(input); return choiceRequest({ state: "dismissed" }); } });
    const renderer = await mount(choiceRequest(), api, () => undefined, locale);
    assert.deepEqual(renderer.root.findAllByType("input").filter(input => input.props.type === "radio").map(input => input.props.value), ["save", "once", "web"]);
    const decline = button(renderer, locale === "zh" ? "暂不配置，返回任务" : "Do not configure · return to task");
    assert.ok(decline);
    assert.equal(decline.props.type, "button");
    assert.equal(decline.props.disabled, false);
    assert.notEqual(decline.props.tabIndex, -1);
    assert.deepEqual(calls, [], "rendering must not preview or decide");
    await act(async () => { decline.props.onClick(); });
    assert.deepEqual(calls, [
      { expectedRevision: 2, values: {}, selectedOptionId: "dismiss" },
      { revision: 3, previewDigest: "sha256:dismiss", decision: "dismiss", selectedOptionId: "dismiss" },
    ]);
    await act(async () => renderer.unmount());
  }
});

test("CFG-T32 a restored refusal preview cannot be confirmed through a hidden choice", async () => {
  const calls: unknown[] = [];
  const view = choiceRequest({ revision: 3, selectedOptionId: "dismiss", previewDigest: "sha256:dismiss" });
  const renderer = await mount(view, actions({ preview: async input => { calls.push(input); return view; },
    decide: async input => { calls.push(input); return choiceRequest({ state: "dismissed" }); } }));
  assert.equal(renderer.root.findAllByType("input").filter(input => input.props.type === "radio" && input.props.checked).length, 0);
  const confirm = button(renderer, "Confirm choice and continue");
  assert.equal(confirm.props.disabled, true);
  await act(async () => { confirm.props.onClick(); });
  assert.deepEqual(calls, []);
  await act(async () => { button(renderer, "Do not configure · return to task").props.onClick(); });
  assert.deepEqual(calls, [{ revision: 3, previewDigest: "sha256:dismiss", decision: "dismiss", selectedOptionId: "dismiss" }]);
  await act(async () => renderer.unmount());
});

test("CFG-T32 explicit close previews refusal and returns it; unmount does not decide", async () => {
  const calls: unknown[] = [];
  const api = actions({ preview: async input => { calls.push(input); return choiceRequest({ revision: 3, selectedOptionId: "dismiss", previewDigest: "sha256:dismiss" }); },
    decide: async input => { calls.push(input); return choiceRequest({ state: "dismissed" }); } });
  const renderer = await mount(choiceRequest(), api);
  await act(async () => { renderer.root.findAllByType("button").find(button => button.props["aria-label"] === "Close without configuring and return to the task")!.props.onClick(); });
  assert.deepEqual(calls, [
    { expectedRevision: 2, values: {}, selectedOptionId: "dismiss" },
    { revision: 3, previewDigest: "sha256:dismiss", decision: "dismiss", selectedOptionId: "dismiss" },
  ]);
  await act(async () => renderer.unmount());
  const idle = await mount(choiceRequest(), api);
  await act(async () => idle.unmount());
  assert.equal(calls.length, 2);
});

test("CFG-T31/32 collapsed receipts distinguish temporary use and alternatives from saved settings", async () => {
  for (const kind of ["run_overlay", "alternative"] as const) {
    const renderer = await mount(choiceRequest({ state: kind === "alternative" ? "dismissed" : "applied", allowedActions: [],
      choiceReceipt: { optionId: kind, kind, label: kind, configurationWritten: false, scope: kind === "run_overlay" ? "run" : "none" },
      resumption: { state: "started", runId: "r1" } }));
    const summary = renderer.root.findByType("summary");
    assert.doesNotMatch(summary.children.join(""), /Saved/);
    assert.match(JSON.stringify(renderer.toJSON()), /No persistent settings changed/);
    assert.equal(renderer.root.findAllByType("input").length, 0);
    await act(async () => renderer.unmount());
  }
});

test("CFG P1 saved next-run receipts describe future activation without implying an unfinished original task", async () => {
  const saved = choiceRequest({ capabilityId: "thinking.configure", state: "applied", runId: undefined, allowedActions: [],
    choiceReceipt: { optionId: "save", kind: "persisted_apply", label: "Save configuration", configurationWritten: true, scope: "session" },
    activation: { mode: "next_run", state: "needs_user_action" }, resumption: { state: "not_requested" } });
  const renderer = await mount(saved, actions(), () => undefined, "zh");
  const label = () => renderer.root.findByProps({ className: "record-label" }).children.join("");
  assert.equal(label(), "调整思考配置 · 已保存 · 后续运行生效");
  assert.equal(renderer.root.findByType("details").props.open, false);
  assert.match(JSON.stringify(renderer.toJSON()), /等待后续运行/);
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /需要用户处理/);
  await act(async () => renderer.update(createElement(LocaleProvider, { initialLocale: "zh" }, createElement(ConfigurationRequestCard, {
    request: { ...saved, activation: { mode: "requires_restart", state: "needs_user_action" } }, actions: actions(), onUpdate() {},
  }))));
  assert.match(JSON.stringify(renderer.toJSON()), /需要重启/);
  assert.match(JSON.stringify(renderer.toJSON()), /需要用户处理/);
  assert.doesNotMatch(label(), /后续运行生效/);
  await act(async () => renderer.update(createElement(LocaleProvider, { initialLocale: "zh" }, createElement(ConfigurationRequestCard, {
    request: { ...saved, runId: "r1", activation: { mode: "same_run", state: "active" }, resumption: { state: "started", runId: "r1" } },
    actions: actions(), onUpdate() {},
  }))));
  assert.equal(label(), "调整思考配置 · 保存配置后继续 · 原任务继续运行中");
  await act(async () => renderer.unmount());
});

test("CFG-T33 multiselect fields send only selected IDs through the preview values", async () => {
  const previews: unknown[] = [];
  const renderer = await mount(request({ capabilityId: "skill.select", fields: [{ id: "enabledSkillIds", label: "Skills", kind: "multiselect", required: false,
    value: ["skill-a"], choices: [{ id: "skill-a", label: "A" }, { id: "skill-b", label: "B" }] }] }), actions({ preview: async input => { previews.push(input); return request(); } }));
  await act(async () => renderer.root.findByType("select").props.onChange({ target: { selectedOptions: [{ value: "skill-b" }] } }));
  await act(async () => renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(previews, [{ expectedRevision: 2, values: { enabledSkillIds: ["skill-b"] } }]);
  await act(async () => renderer.unmount());
});

test("CFG stopped and archived decisions block mutations rather than suggesting a stale-preview retry", async () => {
  for (const code of ["SESSION_NOT_WRITABLE", "CONTINUATION_STOPPED"]) {
    const renderer = await mount(request(), actions({ decide: async () => { throw new ApiRequestError("raw-provider-secret", 409, code); } }));
    await act(async () => { button(renderer, "Confirm this change").props.onClick(); });
    assert.equal(button(renderer, "Confirm this change").props.disabled, true);
    assert.equal(button(renderer, "Refresh proposed changes").props.disabled, true);
    assert.equal(button(renderer, "Decline").props.disabled, true);
    assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /raw-provider-secret|preview changed/);
    assert.match(JSON.stringify(renderer.toJSON()), code === "CONTINUATION_STOPPED" ? /original task was stopped/ : /read-only/);
    await act(async () => { renderer.unmount(); });
  }
});

test("CFG invalid fields retain other input and identify the field without echoing a server diagnostic", async () => {
  const renderer = await mount(request({ capabilityId: "model.connect", fields: [
    { id: "baseUrl", label: "Endpoint", kind: "url", required: true, value: "https://keep-input.test" },
    { id: "name", label: "Name", kind: "text", required: true, value: "Keep this name" },
  ] }), actions({ preview: async () => { throw new ApiRequestError("do-not-echo", 400, "INVALID_CONFIGURATION_INPUT", { field: "baseUrl" }); } }));
  await act(async () => { renderer.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
  assert.equal(renderer.root.findByProps({ name: "baseUrl" }).props["aria-invalid"], true);
  assert.equal(renderer.root.findByProps({ name: "name" }).props.value, "Keep this name");
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /do-not-echo/);
  await act(async () => { renderer.unmount(); });
});

test("CFG a missing request removes the obsolete card's actions through the owning session callback", async () => {
  let removed = 0;
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ConfigurationRequestCard, { request: request(), actions: actions({
    decide: async () => { throw new ApiRequestError("not found", 404, "CONFIGURATION_REQUEST_NOT_FOUND"); },
  }), onUpdate: () => undefined, onUnavailable: () => { removed++; } })); });
  await act(async () => { button(renderer!, "Confirm this change").props.onClick(); });
  assert.equal(removed, 1);
  assert.equal(button(renderer!, "Confirm this change").props.disabled, true);
  await act(async () => { renderer!.unmount(); });
});

test("CFG credential double submission creates only one draft", async () => {
  let finishTarget!: (value: ConfigurationRequestView) => void;
  let uploads = 0;
  const target = new Promise<ConfigurationRequestView>((resolve) => { finishTarget = resolve; });
  const credentialView = (revision: number) => request({ capabilityId: "model.repair_credential", revision,
    fields: [{ id: "apiToken", label: "Key", kind: "credential", required: true, status: "missing" }] });
  const renderer = await mount(credentialView(2), actions({
    preview: async (input) => input.credentialHandle ? credentialView(4) : target,
    credential: async () => { uploads++; return { handle: "single-draft", expiresAt: "2099-01-01T00:00:00Z" }; },
  }));
  await act(async () => { renderer.root.findByType("input").props.onChange({ target: { value: "credential" } }); });
  await act(async () => {
    const submit = renderer.root.findByType("form").props.onSubmit;
    submit({ preventDefault() {} }); submit({ preventDefault() {} });
  });
  await act(async () => { finishTarget(credentialView(3)); await target; });
  assert.equal(uploads, 1);
  await act(async () => { renderer.unmount(); });

});

test("CFG resolved generic requests move to their persisted notice without a second composer or legacy receipt", () => {
  const saved = request({ state: "applied" });
  const pending = request({ id: "pending", state: "awaiting_confirmation" });
  const foreign = request({ id: "foreign", sessionId: "other-session", state: "applied" });
  const notices = new Map([["notice", { requestId: saved.id }], ["duplicate", { requestId: saved.id }], ["foreign-notice", { requestId: foreign.id }]]);
  const messages = ["notice", "duplicate", "foreign-notice"].map((id) => ({ id, kind: "configuration_notice" } as ChatMessage));
  const result = genericConfigurationPresentation([saved, pending, foreign], messages, notices, "s1");
  assert.equal(result.byNoticeId.get("notice")?.id, saved.id);
  assert.deepEqual(result.visibleRequests.map((item) => item.id), ["pending"]);
  assert.ok(result.suppressedNoticeIds.has("duplicate"));
  assert.equal(result.byNoticeId.has("foreign-notice"), false);
  const withoutNotice = genericConfigurationPresentation([saved], [], notices, "s1");
  assert.equal(withoutNotice.visibleRequests[0]?.id, saved.id, "Keep the collapsed record visible until its notice is persisted");
});

test("CFG generic pre-authorized card shows the server deadline and cancels through the versioned dismiss action", async () => {
  const decisions: unknown[] = [];
  const deadline = new Date(Date.now() + 30_000).toISOString();
  const renderer = await mount(request({ capabilityId: "connector.enable", autoApplyAt: deadline }), actions({ decide: async (input) => {
    decisions.push(input); return request({ state: "dismissed", decisionSource: "user", allowedActions: [] });
  } }));
  assert.match(JSON.stringify(renderer.toJSON()), /applies automatically in 30s/);
  assert.equal(renderer.root.findAllByType("time").some((node) => node.props.dateTime === deadline), true);
  assert.equal(renderer.root.findByType("select").props.disabled, true, "The scheduled preview stays fixed until cancelled");
  assert.deepEqual(decisions, [], "Rendering a countdown cannot approve the request");
  await act(async () => { button(renderer, "Cancel this change").props.onClick(); });
  assert.deepEqual(decisions, [{ revision: 2, previewDigest: "sha256:preview-2", decision: "dismiss" }]);
  await act(async () => { renderer.unmount(); });
});

test("CFG only server DTOs drive countdown removal and automatic decision provenance", async () => {
  const decisions: unknown[] = [];
  const expiredDeadline = new Date(Date.now() - 1_000).toISOString();
  const api = actions({ decide: async (input) => { decisions.push(input); return request(); } });
  const renderer = await mount(request({ capabilityId: "connector.enable", autoApplyAt: expiredDeadline }), api);
  assert.match(JSON.stringify(renderer.toJSON()), /Waiting for the server to review/);
  assert.deepEqual(decisions, [], "A browser at zero seconds must not call apply");
  await act(async () => { renderer.update(createElement(ConfigurationRequestCard, { request: request({ capabilityId: "connector.enable", stateVersion: 4 }), actions: api, onUpdate: () => undefined })); });
  assert.doesNotMatch(JSON.stringify(renderer.toJSON()), /Scheduled server review|Waiting for the server to review|applies automatically/);
  assert.equal(renderer.root.findByType("select").props.disabled, false, "Removing the authorization reopens the ordinary preview controls");
  const updatedAt = "2026-10-19T15:01:00Z";
  await act(async () => { renderer.update(createElement(ConfigurationRequestCard, { request: request({ capabilityId: "connector.enable", state: "applied",
    decisionSource: "auto", stateVersion: 5, updatedAt, allowedActions: [] }), actions: api, onUpdate: () => undefined })); });
  assert.equal(renderer.root.findByType("details").props.open, false);
  assert.match(JSON.stringify(renderer.toJSON()), /Automatic · pre-authorized/);
  assert.match(JSON.stringify(renderer.toJSON()), /Last updated/);
  assert.equal(renderer.root.findAllByType("time").some((node) => node.props.dateTime === updatedAt), true);
  assert.deepEqual(decisions, []);
  await act(async () => { renderer.unmount(); });
});

test("CFG an expired same-target draft can be replaced through target preview, secure upload, and a fresh provided snapshot", async () => {
  // GET may still expose the previous provided status until the ordinary
  // preview detects expiry; neither representation can trap the user in a
  // retry loop or require the browser to recover the old opaque handle.
  for (const oldStatus of ["provided", "expired"] as const) {
    const freshSecret = `replacement-secret-${oldStatus}`;
    const freshHandle = `replacement-handle-${oldStatus}`;
    const expiredSecret = "expired-secret-must-not-be-reused";
    const expiredHandle = "expired-handle-must-not-be-reused";
    const calls: Array<{ operation: string; input: unknown }> = [];
    const updates: ConfigurationRequestView[] = [];
    const repairView = (revision: number, status: "provided" | "missing" | "expired", state: ConfigurationRequestView["state"]) => request({
      capabilityId: "model.repair_credential", scope: { kind: "global" }, revision, state,
      previewDigest: `sha256:repair-${revision}`, fields: [
        { id: "modelId", label: "Existing model", kind: "enum", required: true, value: "a", choices: [{ id: "a", label: "Model A" }] },
        { id: "apiToken", label: "Replacement key", kind: "credential", required: true, status },
      ], allowedActions: state === "awaiting_confirmation" ? ["preview", "apply", "dismiss"] : ["preview", "dismiss"],
    });
    const api = actions({
      preview: async (input) => {
        calls.push({ operation: "preview", input });
        if (calls.length === 1) {
          assert.equal(input.credentialHandle, undefined, "A normal target preview must not send an old handle");
          // Backend clears only the expired isolated draft, preserving the
          // authoritative model/provider credential, and returns a new basis.
          return repairView(9, "missing", "collecting_input");
        }
        assert.equal(input.credentialHandle, freshHandle);
        return repairView(10, "provided", "awaiting_confirmation");
      },
      credential: async (input) => {
        calls.push({ operation: "credential", input });
        return { handle: freshHandle, expiresAt: "2099-01-01T00:00:00Z" };
      },
      query: async () => { assert.fail("Replacing an expired isolated draft must not require a refresh loop"); },
    });
    let renderer: ReactTestRenderer;
    const draw = (view: ConfigurationRequestView) => createElement(ConfigurationRequestCard, { key: view.id,
      request: view, actions: api, onUpdate: (next: ConfigurationRequestView) => { updates.push(next); renderer.update(draw(next)); } });
    await act(async () => { renderer = create(draw(repairView(8, oldStatus, "awaiting_confirmation"))); });
    await act(async () => { renderer!.root.findByProps({ name: "apiToken" }).props.onChange({ target: { value: freshSecret } }); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    assert.deepEqual(calls, [
      { operation: "preview", input: { expectedRevision: 8, values: { modelId: "a" } } },
      { operation: "credential", input: { expectedRevision: 9, fieldId: "apiToken", secret: freshSecret } },
      { operation: "preview", input: { expectedRevision: 9, values: { modelId: "a" }, credentialHandle: freshHandle } },
    ]);
    assert.doesNotMatch(JSON.stringify(calls), new RegExp(`${expiredSecret}|${expiredHandle}`));
    assert.equal(updates.length, 2);
    assert.equal(updates[0]?.revision, 9);
    assert.equal(updates[1]?.revision, 10);
    assert.equal(updates[1]?.fields.find((field) => field.kind === "credential")?.status, "provided");
    assert.doesNotMatch(JSON.stringify(updates), new RegExp(`${freshSecret}|${freshHandle}|${expiredSecret}|${expiredHandle}`));
    const credentialInput = renderer!.root.findByProps({ name: "apiToken" });
    assert.equal(credentialInput.props.value, "");
    assert.match(credentialInput.props.placeholder, /Credential provided/);
    assert.match(JSON.stringify(renderer!.toJSON()), /Credential provided/);
    assert.equal(button(renderer!, "Confirm this change").props.disabled, false);
    await act(async () => { renderer!.unmount(); });
  }
});

test("CFG-R04 intermediate previews preserve same-target credential input and allow a failed upload to retry at the accepted revision", async () => {
  const fields = [{ id: "modelId", kind: "enum" as const, label: "Model", required: true, value: "a", choices: [{ id: "a", label: "A" }, { id: "b", label: "B" }] },
    { id: "apiToken", kind: "credential" as const, label: "Key", required: true, status: "missing" as const }];
  let latest = request({ capabilityId: "model.repair_credential", fields });
  let renderer: ReactTestRenderer;
  const revisions: number[] = [];
  const uploads: number[] = [];
  const api = actions({
    preview: async input => { revisions.push(input.expectedRevision); return { ...latest, revision: input.expectedRevision + 1,
      fields: fields.map(field => field.kind === "credential" && input.credentialHandle ? { ...field, status: "provided" } : field) }; },
    credential: async input => { uploads.push(input.expectedRevision); if (uploads.length === 1) throw new Error("offline sensitive-secret");
      return { handle: "new-private-handle", expiresAt: "2099-01-01T00:00:00Z" }; },
  });
  const render = () => createElement(ConfigurationRequestCard, { request: latest, actions: api, onUpdate: (next: ConfigurationRequestView) => { latest = next; renderer.update(render()); } });
  await act(async () => { renderer = create(render()); });
  const input = renderer!.root.findByProps({ name: "apiToken" });
  await act(async () => input.props.onChange({ target: { value: "sensitive-secret" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.equal(latest.revision, 3);
  assert.equal(renderer!.root.findByProps({ name: "apiToken" }), input, "same native input survives accepted revision");
  assert.equal(input.props.value, "sensitive-secret");
  assert.equal(button(renderer!, "Refresh proposed changes").props.disabled, false);
  assert.doesNotMatch(renderer!.root.findByProps({ role: "alert" }).children.join(""), /sensitive-secret/);
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.deepEqual(revisions, [2, 3, 4]);
  assert.deepEqual(uploads, [3, 4]);
  assert.equal(latest.revision, 5);
  assert.equal(input.props.value, "");
  await act(async () => input.props.onChange({ target: { value: "replacement-secret" } }));
  await act(async () => renderer!.root.findByProps({ name: "modelId" }).props.onChange({ target: { value: "b" } }));
  assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 0, "changing destination hides the previously authorized credential field");
  await act(async () => renderer!.root.findByProps({ name: "modelId" }).props.onChange({ target: { value: "a" } }));
  assert.equal(renderer!.root.findByProps({ name: "apiToken" }).props.value, "", "returning to the previous destination cannot recover the cleared secret");
  await act(async () => renderer!.unmount());
});

test("CFG-R02 custom endpoints require a separate user destination approval before credentials are collected", async () => {
  let latest = request({ capabilityId: "model.connect", fields: [{ id: "baseUrl", kind: "url", label: "URL", required: true, value: "https://custom.example/v1" },
    { id: "apiToken", kind: "credential", label: "Key", required: true, status: "missing" }],
    endpointAuthorization: { endpointTarget: "https://custom.example/v1|openai", host: "custom.example", classification: "public_https", status: "required", revision: 2 } });
  let renderer: ReactTestRenderer;
  const consents: unknown[] = [];
  let uploads = 0;
  const api = actions({ consent: async input => { consents.push(input); return { ...latest, stateVersion: latest.stateVersion + 1,
    endpointAuthorization: { ...latest.endpointAuthorization!, status: "confirmed" } }; }, credential: async () => { uploads++; return { handle: "x", expiresAt: "2099-01-01T00:00:00Z" }; } });
  const render = () => createElement(ConfigurationRequestCard, { request: latest, actions: api, onUpdate: (next: ConfigurationRequestView) => { latest = next; renderer.update(render()); } });
  await act(async () => { renderer = create(render()); });
  assert.match(JSON.stringify(renderer!.toJSON()), /custom.example/);
  assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 0);
  assert.equal(button(renderer!, "Confirm this change").props.disabled, true);
  await act(async () => button(renderer!, "Allow this exact endpoint").props.onClick());
  assert.deepEqual(consents, [{ revision: 2, endpointTarget: "https://custom.example/v1|openai" }]);
  assert.equal(uploads, 0, "consent never uploads or probes");
  assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 1);
  await act(async () => renderer!.root.findByProps({ name: "apiToken" }).props.onChange({ target: { value: "private" } }));
  await act(async () => renderer!.root.findByProps({ name: "baseUrl" }).props.onChange({ target: { value: "https://different.example/v1" } }));
  assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 0, "old approval is unusable after editing the destination");
  assert.equal(button(renderer!, "Allow this exact endpoint"), undefined);
  await act(async () => { latest = { ...latest, endpointAuthorization: { ...latest.endpointAuthorization!, classification: "public_http", status: "confirmed" } }; renderer!.update(render()); });
  assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 0, "remote cleartext endpoint never collects a credential");
  await act(async () => renderer!.unmount());
});

test("CFG-R02 a model card with no destination cannot collect a key before its first target preview", async () => {
  const renderer = await mount(request({ capabilityId: "model.connect", endpointAuthorization: undefined, state: "collecting_input",
    fields: [{ id: "baseUrl", kind: "url", label: "API URL", required: true, value: "" }, { id: "apiToken", kind: "credential", label: "Key", required: true, status: "missing" }] }));
  assert.equal(renderer.root.findAllByProps({ type: "password" }).length, 0);
  assert.match(JSON.stringify(renderer.toJSON()), /approve the destination before entering credentials/);
  await act(async () => renderer.unmount());
});

test("CFG-R04 a background same-target revision retains the private draft without approving its unsubmitted credential", async () => {
  const view = request({ capabilityId: "model.repair_credential", fields: [{ id: "apiToken", kind: "credential", label: "Key", required: true, status: "provided" }] });
  const api = actions();
  let renderer: ReactTestRenderer;
  const draw = (next: ConfigurationRequestView) => createElement(ConfigurationRequestCard, { request: next, actions: api, onUpdate() {} });
  await act(async () => { renderer = create(draw(view)); });
  const input = renderer!.root.findByProps({ name: "apiToken" });
  await act(async () => input.props.onChange({ target: { value: "unsubmitted-private-key" } }));
  await act(async () => renderer!.update(draw({ ...view, revision: 3, stateVersion: 4, previewDigest: "sha256:new-preview" })));
  assert.equal(renderer!.root.findByProps({ name: "apiToken" }), input);
  assert.equal(input.props.value, "unsubmitted-private-key");
  assert.equal(button(renderer!, "Confirm this change").props.disabled, true);
  await act(async () => renderer!.unmount());
});

test("CFG-R05 expired task requests disclose the paused task and offer an explicit Stop", async () => {
  let stopped = 0;
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ConfigurationRequestCard, { request: request({ state: "expired", allowedActions: ["query"] }), actions: actions(), onUpdate() {}, onStopTask: async () => { stopped++; } })); });
  assert.match(JSON.stringify(renderer!.toJSON()), /original task is still paused/);
  await act(async () => button(renderer!, "Stop original task").props.onClick());
  assert.equal(stopped, 1);
  assert.equal(renderer!.root.findAllByType("form").length, 0);
  await act(async () => renderer!.unmount());
});

test("CFG-R09 old list responses retain locally created requests and durable receipts without a task run", () => {
  const recent = request({ id: "recent", revision: 4, stateVersion: 10 });
  const older = request({ id: "other", revision: 1 });
  const merged = mergeConfigurationRequests([recent], [older, { ...recent, revision: 3, stateVersion: 20 }]);
  assert.equal(merged.find(item => item.id === "recent"), recent);
  assert.equal(mergeConfigurationRequests(merged, [older]).length, 2);
  const saved = request({ id: "pure-setting", capabilityId: "thinking.configure", state: "applied", runId: undefined });
  const message: ChatMessage = { id: "configuration:pure-setting", role: "system", kind: "configuration_notice", content: "", createdAt: saved.createdAt, configurationRequestId: saved.id };
  const result = genericConfigurationPresentation([saved], [message, { ...message, id: "duplicate" }], new Map(), "s1");
  assert.equal(result.byNoticeId.get(message.id), saved);
  assert.equal(result.visibleRequests.length, 0);
  assert.ok(result.suppressedNoticeIds.has("duplicate"));
});

test("CFG-R11 Chinese alternatives retain their distinct destinations", async () => {
  const options = [
    { id: "web", kind: "alternative" as const, alternativeId: "web-search", label: "Use Web search", description: "Web", available: true },
    { id: "installed", kind: "alternative" as const, alternativeId: "installed", label: "Local library", description: "Library", available: true },
  ];
  const renderer = await mount(choiceRequest({ options }), actions(), () => undefined, "zh");
  const labels = renderer.root.findAllByType("strong").map(item => item.children.join(""));
  assert.ok(labels.includes("改用可用的替代路径 · 使用现有网页检索"));
  assert.ok(labels.includes("改用可用的替代路径 · Local library"));
  await act(async () => renderer.unmount());
});

test("CFG-R04 a repair target changed by intermediate preview clears the old key and never uploads it, even to a trusted preset", async () => {
  let latest = request({ capabilityId: "model.repair_credential", fields: [{ id: "modelId", kind: "text", label: "Model", required: true, value: "same-model" },
    { id: "apiToken", kind: "credential", label: "Key", required: true, status: "missing" }] });
  let renderer: ReactTestRenderer;
  let uploads = 0;
  const api = actions({ preview: async input => ({ ...latest, revision: input.expectedRevision + 1,
    endpointAuthorization: { ...latest.endpointAuthorization!, endpointTarget: "https://new-trusted.example/v1/chat/completions", host: "new-trusted.example", status: "trusted" } }),
    credential: async () => { uploads++; return { handle: "must-not-exist", expiresAt: "2099-01-01T00:00:00Z" }; } });
  const draw = () => createElement(ConfigurationRequestCard, { request: latest, actions: api, onUpdate: (next: ConfigurationRequestView) => { latest = next; renderer.update(draw()); } });
  await act(async () => { renderer = create(draw()); });
  await act(async () => renderer!.root.findByProps({ name: "apiToken" }).props.onChange({ target: { value: "belongs-to-old-destination" } }));
  await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
  assert.equal(uploads, 0);
  assert.equal(latest.revision, 3);
  assert.equal(renderer!.root.findByProps({ name: "apiToken" }).props.value, "");
  assert.match(JSON.stringify(renderer!.toJSON()), /destination changed during preview/);
  assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /belongs-to-old-destination/);
  assert.equal(button(renderer!, "Confirm this change").props.disabled, true);
  await act(async () => renderer!.unmount());
});

test("CFG-R02 local and private HTTP gateways disclose plaintext risk and collect credentials only after exact user consent", async () => {
  for (const locale of ["en", "zh"] as const) for (const destination of [
    { baseUrl: "http://127.0.0.1:4550/v1", host: "127.0.0.1:4550", classification: "loopback" as const },
    { baseUrl: "http://192.168.20.30:4550/v1", host: "192.168.20.30:4550", classification: "private_network" as const },
  ]) {
    const endpointTarget = JSON.stringify(["openai-chat-completions", "openai", destination.baseUrl + "/chat/completions"]);
    let latest = request({ capabilityId: "model.connect", fields: [
      { id: "baseUrl", kind: "url", label: "API URL", required: true, value: destination.baseUrl },
      { id: "apiToken", kind: "credential", label: "API key", required: true, status: "missing" },
    ], endpointAuthorization: { endpointTarget, host: destination.host, classification: destination.classification, status: "required", revision: 2 } });
    let renderer: ReactTestRenderer;
    const consents: unknown[] = [];
    let uploads = 0, previews = 0, decisions = 0;
    const api = actions({
      consent: async input => { consents.push(input); return { ...latest, stateVersion: latest.stateVersion + 1,
        endpointAuthorization: { ...latest.endpointAuthorization!, status: "confirmed" } }; },
      credential: async () => { uploads++; assert.fail("Consent and local typing must not upload a credential"); },
      preview: async () => { previews++; assert.fail("Consent and local typing must not start a preview or probe"); },
      decide: async () => { decisions++; assert.fail("Consent is not approval to apply the configuration"); },
    });
    const draw = () => createElement(LocaleProvider, { initialLocale: locale }, createElement(ConfigurationRequestCard, {
      request: latest, actions: api, onUpdate: (next: ConfigurationRequestView) => { latest = next; renderer.update(draw()); },
    }));
    await act(async () => { renderer = create(draw()); });
    const riskText = JSON.stringify(renderer!.toJSON());
    assert.ok(riskText.includes(destination.host), "The exact destination is visible alongside the risk disclosure");
    assert.match(riskText, locale === "zh" ? /不等于可信/ : /does not mean trusted/);
    assert.match(riskText, locale === "zh" ? /HTTP 不加密/ : /HTTP is not encrypted/);
    assert.match(riskText, locale === "zh" ? /明文/ : /plaintext/);
    assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 0, "Private address alone never authorizes key entry");
    assert.equal(button(renderer!, locale === "zh" ? "确认此项变更" : "Confirm this change").props.disabled, true);
    assert.deepEqual(consents, []);
    await act(async () => button(renderer!, locale === "zh" ? "允许此精确端点" : "Allow this exact endpoint").props.onClick());
    assert.deepEqual(consents, [{ revision: 2, endpointTarget }], "Dedicated user consent binds the displayed exact destination and revision");
    assert.equal(latest.revision, 2, "Consent does not replace the configuration preview");
    assert.equal(renderer!.root.findAllByProps({ type: "password" }).length, 1, "An explicitly approved local gateway retains compatibility");
    assert.match(JSON.stringify(renderer!.toJSON()), locale === "zh" ? /明文/ : /plaintext/, "The risk stays visible after consent");
    await act(async () => renderer!.root.findByProps({ name: "apiToken" }).props.onChange({ target: { value: "memory-only-gateway-key" } }));
    assert.equal(button(renderer!, locale === "zh" ? "确认此项变更" : "Confirm this change").props.disabled, true, "Key input still requires a separate reviewed preview");
    assert.deepEqual([uploads, previews, decisions], [0, 0, 0], "The endpoint consent action cannot send a probe, upload a key, or apply settings");
    await act(async () => renderer!.unmount());
  }
});

test("CFG-R09 continuation receipt polling survives pending to started until the durable completed receipt arrives", () => {
  const saved = request({ state: "applied", activation: { mode: "same_run", state: "active" }, resumption: { state: "pending" }, stateVersion: 4 });
  const started = { ...saved, stateVersion: 5, resumption: { state: "started" as const, runId: "r1" } };
  const completed = { ...saved, stateVersion: 6, resumption: { state: "completed" as const, runId: "r1" } };
  let snapshots: ConfigurationRequestView[] = [];
  const watchedIds = [saved, started, completed].map(snapshot => {
    snapshots = mergeConfigurationRequests(snapshots, [snapshot]);
    return snapshots.filter(shouldPollConfigurationRequest).map(item => item.id);
  });
  assert.deepEqual(watchedIds, [[saved.id], [saved.id], []], "A first read returning started after run completion must still schedule the next receipt read");
  snapshots = mergeConfigurationRequests(snapshots, [started]);
  assert.deepEqual(snapshots.filter(shouldPollConfigurationRequest), [], "An older started response cannot revive polling after the final receipt was observed");
  assert.equal(snapshots[0]!.resumption.state, "completed");
});

test("CFG-R09 a saved next-run setting stops polling once activation needs a subsequent user run", () => {
  const saved = request({ runId: undefined, state: "applied", activation: { mode: "next_run", state: "needs_user_action" }, resumption: { state: "not_requested" } });
  assert.equal(shouldPollConfigurationRequest(saved), false, "A future-run setting must not keep an idle session polling");
  assert.equal(shouldPollConfigurationRequest({ ...saved, activation: { mode: "next_run", state: "pending" } }), true, "Pending activation still receives the existing finite reconciliation polling");
  assert.equal(shouldPollConfigurationRequest({ ...saved, activation: { mode: "next_run", state: "active" } }), false);
});

test("CFG-R09 run-bound waiting cards reconcile until Stop is durably observed", () => {
  const waiting = request({ runId: "run-1", state: "awaiting_confirmation", autoApplyAt: undefined,
    activation: { mode: "same_run", state: "not_requested" }, resumption: { state: "not_requested" } });
  assert.equal(shouldPollConfigurationRequest(waiting), true);
  // A cancellation receipt may persist later than any single fixed-delay read.
  for (let attempt = 0; attempt < 4; attempt++) assert.equal(shouldPollConfigurationRequest({ ...waiting, stateVersion: attempt + 1 }), true);
  const cancelled = { ...waiting, state: "cancelled" as const, stateVersion: 5, resumption: { state: "suppressed" as const } };
  const current = mergeConfigurationRequests([waiting], [cancelled]);
  assert.equal(shouldPollConfigurationRequest(current[0]!), false);
  assert.equal(mergeConfigurationRequests(current, [waiting])[0]!.state, "cancelled");
  assert.equal(shouldPollConfigurationRequest({ ...waiting, runId: undefined }), false);
});

test("Jiuwen live-wait card is actionable while its original run remains running; ordinary running cards stay fenced", async () => {
  for (const liveWait of [false, true]) {
    let renderer!: ReactTestRenderer;
    await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: "en" }, createElement(ConfigurationRequestCard, {
      request: request({ liveWait }), actions: actions(), onUpdate: () => undefined, runActive: true,
    }))); });
    assert.equal(button(renderer, "Confirm this change").props.disabled, !liveWait);
    assert.equal(button(renderer, "Decline").props.disabled, !liveWait);
    await act(async () => renderer.unmount());
  }
});
