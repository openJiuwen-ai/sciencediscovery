// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { mcpConfigurationText, mcpConfigurationChoiceLabel, mcpConfigurationChangeText } from "../src/configuration/mcp-copy.js";
const registered = {
  "source": {
    "mcp.delete": {
      "resourceLocation": "Encrypted custom MCP configuration and local OAuth/reference stores",
      "effectiveScope": "Every Global, Project, Session and Specialist reference to this custom server",
      "message": "Independent manual confirmation required. Delete this custom server, its local OAuth state and saved selection references. Other servers remain. The deletion journal recovers interrupted local cleanup without replaying tools. This action has no automatic undo and does not revoke remote credentials. Saving performs no discovery, MCP/network request or process start/stop. Existing connections or already running work may continue until later ordinary catalog/reconnect cleanup; future calls cannot use this removed server. A bound original configuration wait may continue normally; no old tool/task is replayed."
    },
    "mcp.header_credential": {
      "resourceLocation": "Encrypted custom MCP configuration",
      "effectiveScope": "This shared server's saved credential header"
    }
  },
  "headerPrefix": "Independent manual confirmation and separate recipient approval are required. Recipient: ",
  "headerSuffix": ". The saved path/query may contain secrets and is hidden but bound to this approval; review it in the formal editor first. Replace all case aliases with one header. Other headers, OAuth, URL, transport, enabled state, timeout, proxy and Session/tool/network permissions remain. Saving performs no probe, RPC, network request or process operation. Old discovery is invalidated; later ordinary connection/testing uses the replacement and may interrupt old work. Existing connections may retain the old value until reconnect. This is not remote credential revocation or verified authentication. A bound original configuration wait may continue normally; no old tool/task is replayed.",
  "credentialDescription": "Printable ASCII only, no outer spaces, controls or leading $ environment reference. Use removal to delete a header."
} as const;
function fixture(capabilityId: "mcp.delete" | "mcp.header_credential" = "mcp.delete"): ConfigurationRequestView {
  return {
    id: "copy", projectId: "project", sessionId: "session", revision: 2, stateVersion: 2, schemaVersion: 1, adapterVersion: 1,
    capabilityId, state: "awaiting_confirmation", reason: { code: "CONFIGURATION_REQUIRED", message: "A configuration change is required" },
    scope: { kind: "global" }, fields: capabilityId === "mcp.delete" ? [
      { id: "serverId", kind: "enum", label: "Existing custom MCP server", required: true, value: "custom-owned", choices: [{ id: "custom-owned", label: "User supplied 名称" }] },
      { id: "confirmDelete", kind: "boolean", label: "Delete this shared server and its saved references", required: true, value: true },
    ] : [
      { id: "serverId", kind: "enum", label: "Existing HTTP/SSE custom MCP server", required: true, value: "custom-owned", choices: [{ id: "custom-owned", label: "User supplied 名称" }] },
      { id: "headerName", kind: "enum", label: "Existing credential header", required: true, value: "authorization", choices: [{ id: "authorization", label: "authorization · 2 stored name(s)" }] },
      { id: "apiToken", kind: "credential", label: "Replacement header value", required: true, status: "provided", description: registered.credentialDescription },
    ], changes: [], impact: { ...registered.source[capabilityId], message: capabilityId === "mcp.delete" ? registered.source["mcp.delete"].message : registered.headerPrefix + "http://127.0.0.1:12345" + registered.headerSuffix },
    verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, previewDigest: "sha256:unchanged",
    activation: { mode: "next_invocation", state: "not_requested" }, resumption: { state: "not_requested" },
    allowedActions: ["preview", "apply", "dismiss"], createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z",
  };
}

test("MCP copy translates registered deletion risks without losing irreversibility or scope", () => {
  const view = fixture();
  assert.equal(mcpConfigurationText("zh-CN", view, "reason", view.reason.message), "需要变更配置");
  assert.match(mcpConfigurationText("zh-CN", view, "effectiveScope", view.impact.effectiveScope), /全局、项目、会话及专家/);
  const message = mcpConfigurationText("zh-CN", view, "message", view.impact.message);
  for (const phrase of ["独立手动确认", "无法自动撤销", "不会撤销远端凭据", "启动/停止进程", "未来调用", "不会重放"]) {
    assert.ok(message.includes(phrase === "未来调用" ? "后续调用" : phrase));
  }
  assert.equal(mcpConfigurationChangeText("zh-CN", view, "serverId", "before", "User supplied 名称 · custom-owned"), "User supplied 名称 · custom-owned");
  assert.match(mcpConfigurationChangeText("zh-CN", view, "serverId", "after", "Deleted, including local OAuth state and saved references; no automatic undo")!, /无法自动撤销/);
});

test("MCP header copy preserves each origin verbatim and all credential warnings", () => {
  const view = fixture("mcp.header_credential");
  for (const origin of ["http://127.0.0.1:12345", "https://Gateway.EXAMPLE:443", "http://[::1]:4567"]) {
    const source = registered.headerPrefix + origin + registered.headerSuffix;
    const translated = mcpConfigurationText("zh-CN", view, "message", source);
    assert.ok(translated.includes(origin));
    for (const phrase of ["独立手动确认", "另行批准", "路径/查询参数", "绑定于本次批准", "大小写别名", "会话/工具/网络权限", "RPC", "旧发现结果将失效", "旧值", "不是远端凭据撤销", "认证已验证", "不会重放"]) assert.ok(translated.includes(phrase), phrase);
  }
  assert.match(mcpConfigurationText("zh-CN", view, "message", registered.headerPrefix + "select a saved server/header" + registered.headerSuffix), /请选择已保存的服务\/请求头/);
});

test("unknown warning text and unrecognized recipients never get partially overwritten", () => {
  const view = fixture("mcp.header_credential");
  for (const origin of ["http://user:secret@host.test", "https://host.test/path", "https://host.test?private=1", "a custom recipient", "https://host.test\nNew warning"]) {
    const source = registered.headerPrefix + origin + registered.headerSuffix;
    assert.equal(mcpConfigurationText("zh-CN", view, "message", source), source);
  }
  for (const source of [view.impact.message + " New risk", "New risk: " + view.impact.message, view.impact.message.replace("Old discovery", "New discovery")]) assert.equal(mcpConfigurationText("zh-CN", view, "message", source), source);
});

test("English, unrelated capabilities, unknown versions and custom reasons remain unchanged", () => {
  const view = fixture();
  for (const slot of ["resourceLocation", "effectiveScope", "message"] as const) {
    const value = view.impact[slot];
    for (const [locale, request] of [["en", view], ["zh-CN", { ...view, adapterVersion: 2 }], ["zh-CN", { ...view, schemaVersion: 2 }], ["zh-CN", { ...view, capabilityId: "mcp.timeout" }], ["zh-CN", { ...view, scope: { kind: "session", id: view.sessionId } }]] as const) assert.equal(mcpConfigurationText(locale, request, slot, value), value);
    assert.equal(mcpConfigurationText("zh-CN", view, slot, "toString"), "toString");
  }
  assert.equal(mcpConfigurationText("zh-CN", { ...view, reason: { code: "CUSTOM", message: view.reason.message } }, "reason", view.reason.message), view.reason.message);
  assert.equal(mcpConfigurationText("zh-CN", view, "reason", "User authored reason"), "User authored reason");
});

test("header aliases and hidden-value diff require exact field, choice and side binding", () => {
  const view = fixture("mcp.header_credential"), label = "authorization · 2 stored name(s)";
  assert.equal(mcpConfigurationChoiceLabel("zh-CN", view, "headerName", "authorization", label), "authorization · 2 个已保存名称");
  for (const field of ["serverId", "apiToken"]) assert.equal(mcpConfigurationChoiceLabel("zh-CN", view, field, "authorization", label), label);
  assert.equal(mcpConfigurationChoiceLabel("zh-CN", view, "headerName", "authorization", "authorization · 9 stored name(s)"), "authorization · 9 stored name(s)");
  assert.equal(mcpConfigurationChangeText("zh-CN", view, "headerName", "before", label + "; values hidden"), "authorization · 2 个已保存名称；值已隐藏");
  assert.equal(mcpConfigurationChangeText("zh-CN", view, "headerName", "after", "Replace via secure input; authentication unverified"), "通过安全输入替换；认证尚未验证");
  assert.equal(mcpConfigurationChangeText("zh-CN", view, "headerName", "after", "Different warning"), "Different warning");
  assert.equal(mcpConfigurationChangeText("zh-CN", view, "serverId", "after", "Replace via secure input; authentication unverified"), "Replace via secure input; authentication unverified");
  assert.equal(mcpConfigurationChangeText("zh-CN", view, "headerName", "before", undefined), undefined);
});

test("credential character requirements preserve exactness and do not touch request authorization data", () => {
  const view = fixture("mcp.header_credential");
  view.endpointAuthorization = { endpointTarget: "opaque-recipient-query-digest", host: "127.0.0.1", status: "confirmed", classification: "loopback", revision: view.revision };
  const before = JSON.stringify(view);
  assert.match(mcpConfigurationText("zh-CN", view, "credentialDescription", registered.credentialDescription), /首尾空格、控制字符或以 \$ 开头/);
  assert.equal(mcpConfigurationText("zh-CN", view, "credentialDescription", "New credential requirement"), "New credential requirement");
  mcpConfigurationText("zh-CN", view, "message", view.impact.message);
  mcpConfigurationChangeText("zh-CN", view, "headerName", "after", "Replace via secure input; authentication unverified");
  assert.equal(JSON.stringify(view), before);
});
