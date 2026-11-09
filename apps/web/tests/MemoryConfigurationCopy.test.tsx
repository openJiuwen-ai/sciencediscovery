// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { ConfigurationRequestCard, type ConfigurationRequestActions } from "../src/configuration/ConfigurationRequestCard.js";
import { LocaleProvider, type Locale } from "../src/i18n/index.js";
import { memoryConfigurationCopy } from "../src/configuration/memory-copy.js";

globalThis.IS_REACT_ACT_ENVIRONMENT = true;

const reason = "A configuration change is required";
const impact = {
  resourceLocation: "Deployment MemoryGraph settings",
  effectiveScope: "Every session using the workbench memory graph",
  message: "Local backend only; manual confirmation required. Enabling permits subsequent research-memory operations to use the existing local graph. Disabling stops subsequent gated operations; in-flight requests may finish and stored graph data is retained. This does not disable every Agent's independent memory, change backend or credentials, install a service or verify readiness. If the MemoryGraph service is unavailable, start it separately and restart the API if required by the deployment; saving does not start or restart services.",
};
const translated = {
  reason: "需要更改配置",
  resourceLocation: "部署级 MemoryGraph 设置",
  effectiveScope: "所有使用工作台记忆图谱的会话",
  message: "仅支持本地后端，必须手动确认。启用后，后续研究记忆操作可使用现有本地图谱。停用后将阻止后续受此开关控制的操作；正在进行的请求可能完成，已存储的图谱数据会保留。这不会关闭各个 Agent 的独立记忆，也不会更改后端或凭据、安装服务或验证服务就绪状态。如果 MemoryGraph 服务不可用，需要另行启动，并按部署要求重启 API；保存配置不会启动或重启服务。",
};
function request(overrides: Partial<ConfigurationRequestView> = {}): ConfigurationRequestView {
  return {
    id: "memory-copy", projectId: "project-copy", sessionId: "session-copy", revision: 7, stateVersion: 4,
    capabilityId: "memory.enable", adapterVersion: 1, schemaVersion: 1, protocolVersion: 3,
    reason: { code: "CONFIGURATION_REQUIRED", message: reason }, scope: { kind: "global" },
    state: "awaiting_confirmation", previewDigest: "sha256:unchanged-memory-preview",
    fields: [{ id: "enabled", label: "Enable workbench memory graph", kind: "boolean", required: true, value: true }],
    changes: [{ field: "enabled", before: "Disabled", after: "Enabled" }], impact: { ...impact },
    verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false },
    activation: { mode: "next_request", state: "not_requested" }, resumption: { state: "not_requested" },
    options: [
      { id: "save", kind: "persisted_apply", label: "Save", description: "Save the change", available: true },
      { id: "dismiss", kind: "dismiss", label: "Decline", description: "Do not save", available: true },
    ], selectedOptionId: "save", allowedActions: ["preview", "apply", "dismiss"],
    createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z", ...overrides,
  };
}
function freeze<T>(value: T): T {
  if (value && typeof value === "object") {
    for (const child of Object.values(value)) freeze(child);
    Object.freeze(value);
  }
  return value;
}
const originalCopy = (view: ConfigurationRequestView) => ({ reason: view.reason.message, ...view.impact });

test("CFG-X04a: exact local Memory disclosures translate without changing a frozen request", () => {
  const view = freeze(request());
  const snapshot = JSON.stringify(view);
  for (const locale of ["zh-CN", "zh"]) assert.deepEqual(memoryConfigurationCopy(view, locale), translated);
  assert.deepEqual(memoryConfigurationCopy(request({ protocolVersion: undefined }), "zh-CN"), translated);
  assert.equal(JSON.stringify(view), snapshot);
  // Intentionally bind this fixture to the full adapter disclosure, not fragments.
  const adapter = readFileSync(new URL("../../../services/api/src/configuration/memory-enable-adapter.ts", import.meta.url), "utf8");
  for (const value of Object.values(impact)) assert.ok(adapter.includes(JSON.stringify(value)));
});

test("CFG-X04a: English and unknown locales, capabilities, versions and scopes retain the exact source", () => {
  for (const locale of ["en", "en-US", "fr", "zh-TW", "zh-HK", "zh-CN-x-new", "ZH-CN", "", "constructor", "__proto__"]) {
    const view = freeze(request());
    assert.deepEqual(memoryConfigurationCopy(view, locale), originalCopy(view), locale);
  }
  for (const overrides of [
    { capabilityId: "reviewer.enable" }, { capabilityId: "memory.future" },
    { adapterVersion: 0 }, { adapterVersion: 2 }, { adapterVersion: "1" },
    { schemaVersion: 0 }, { schemaVersion: 2 }, { schemaVersion: "1" },
    { protocolVersion: 4 }, { protocolVersion: null },
    { scope: { kind: "session", id: "same text" } }, { scope: { kind: "project", id: "same text" } },
    { scope: { kind: "future" } },
  ]) {
    const view = freeze(request(overrides as unknown as Partial<ConfigurationRequestView>));
    assert.deepEqual(memoryConfigurationCopy(view, "zh-CN"), originalCopy(view), JSON.stringify(overrides));
  }
});

test("CFG-X04a: custom reasons and changed or extended disclosures are never normalized or truncated", () => {
  const variants = (text: string) => ["", ` ${text}`, `${text} `, `${text}\n`, `${text} Additional safety warning.`,
    `Additional warning: ${text}`, text.slice(0, -1), text.toLowerCase(), "constructor", "__proto__", "用户自定义原因与警告"];
  for (const text of variants(reason)) {
    const view = freeze(request({ reason: { code: "CONFIGURATION_REQUIRED", message: text } }));
    assert.equal(memoryConfigurationCopy(view, "zh-CN").reason, text);
  }
  for (const code of ["CUSTOM_REASON", "", "configuration_required", "CONFIGURATION_REQUIRED "]) {
    assert.equal(memoryConfigurationCopy(request({ reason: { code, message: reason } }), "zh-CN").reason, reason);
  }
  for (const field of ["resourceLocation", "effectiveScope", "message"] as const) for (const text of variants(impact[field])) {
    const view = freeze(request({ impact: { ...impact, [field]: text } }));
    assert.equal(memoryConfigurationCopy(view, "zh-CN")[field], text, `${field}: ${text}`);
    assert.equal(view.impact[field], text);
  }
});

async function mount(view: ConfigurationRequestView, locale: Locale, overrides: Partial<ConfigurationRequestActions> = {}) {
  const actions: ConfigurationRequestActions = {
    preview: async () => view, credential: async () => { throw new Error("No credentials belong to memory.enable"); },
    decide: async () => view, query: async () => view, continue: async () => view, reversal: async () => view, ...overrides,
  };
  let renderer: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(LocaleProvider, { initialLocale: locale },
    createElement(ConfigurationRequestCard, { request: view, actions, onUpdate() {} }))); });
  return renderer!;
}

test("CFG-X04a: pending and saved cards retain every disclosure in both languages and both toggle directions", async () => {
  for (const locale of ["en", "zh-CN"] as const) for (const state of ["awaiting_confirmation", "applied"] as const) for (const enabled of [true, false]) {
    const view = freeze(request({ state,
      fields: [{ id: "enabled", label: "Enable workbench memory graph", kind: "boolean", required: true, value: enabled }],
      changes: [{ field: "enabled", before: enabled ? "Disabled" : "Enabled", after: enabled ? "Enabled" : "Disabled" }],
      ...(state === "applied" ? { activation: { mode: "next_request", state: "needs_user_action" }, allowedActions: [] } : {}),
    }));
    const renderer = await mount(view, locale);
    try {
      const output = JSON.stringify(renderer.toJSON());
      for (const text of Object.values(locale === "en" ? originalCopy(view) : translated)) assert.ok(output.includes(text), text);
      assert.ok(output.includes(locale === "en" ? "readiness unverified" : "服务就绪未验证"));
      assert.doesNotMatch(output, /Verified active|已核对生效/);
      assert.equal(renderer.root.findAllByType("button").some(node => node.children.join("") === (locale === "en" ? "Confirm choice and continue" : "确认选择并继续")), state !== "applied");
    } finally { await act(async () => renderer.unmount()); }
  }
});

test("CFG-X04a: localized confirmation preserves revision, digest, choice and values with no automatic mutation", async () => {
  for (const locale of ["en", "zh-CN"] as const) {
    const view = freeze(request());
    const snapshot = JSON.stringify(view);
    const decisions: unknown[] = [];
    const previews: unknown[] = [];
    const renderer = await mount(view, locale, {
      preview: async input => { previews.push(input); return view; },
      decide: async input => { decisions.push(input); return view; },
    });
    try {
      assert.deepEqual(decisions, []); assert.deepEqual(previews, []);
      const confirm = renderer.root.findAllByType("button").find(node => node.children.join("") === (locale === "en" ? "Confirm choice and continue" : "确认选择并继续"))!;
      assert.ok(confirm); assert.equal(confirm.props.disabled, false);
      await act(async () => confirm.props.onClick());
      assert.deepEqual(decisions, [{ revision: 7, previewDigest: "sha256:unchanged-memory-preview", decision: "apply", selectedOptionId: "save" }]);
      assert.deepEqual(previews, []);
      assert.equal(JSON.stringify(view), snapshot);
    } finally { await act(async () => renderer.unmount()); }
  }
});

test("CFG-X04a: rendered unknown warnings, targets and reasons remain visible verbatim", async () => {
  const view = freeze(request({
    reason: { code: "CONFIGURATION_REQUIRED", message: "  A user-provided reason  " },
    impact: { resourceLocation: " Deployment MemoryGraph settings ", effectiveScope: "Every session using the workbench memory graph\nAdditional scope", message: impact.message + " Additional safety warning." },
    verificationPlan: { targets: ["https://example.test/exact/path?x=1"], actions: ["Preserve this verification warning"], maxRequests: 1, mayCharge: true },
    error: { code: "EXTRA_WARNING", message: "New server warning must remain visible", retryable: false },
  }));
  const renderer = await mount(view, "zh-CN");
  try {
    const output = JSON.stringify(renderer.toJSON());
    for (const text of [...Object.values(originalCopy(view)), ...view.verificationPlan.targets, ...view.verificationPlan.actions, view.error!.message]) {
      assert.ok(output.includes(JSON.stringify(text).slice(1, -1)), text);
    }
  } finally { await act(async () => renderer.unmount()); }
});
