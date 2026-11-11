// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { memoryConfigurationCopy } from "@sciencediscovery/configuration-ui";
import type { ConfigurationRequestView } from "@sciencediscovery/schema";
import { ApiClient } from "../src/api/client.js";
import { emptyRunStream } from "../src/run-stream/model.js";
import { Conversation } from "../src/views/Conversation.js";
import { getLanguage, setLanguage } from "../src/text.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

(globalThis as { IS_REACT_ACT_ENVIRONMENT?: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function request(overrides: Partial<ConfigurationRequestView> = {}): ConfigurationRequestView {
  return {
    id: "cfg", sessionId: "session", projectId: "project", revision: 1, stateVersion: 1, schemaVersion: 1, adapterVersion: 1,
    capabilityId: "model.select", state: "awaiting_confirmation", reason: { code: "MODEL_REQUIRED", message: "Review the model change" },
    scope: { kind: "session", id: "session" }, fields: [{ id: "modelId", label: "Task model", kind: "enum", required: true, choices: [{ id: "model", label: "Model" }], value: "model" }],
    changes: [{ field: "modelId", before: "old", after: "model" }],
    impact: { resourceLocation: "Model registry", effectiveScope: "This session", message: "No other sessions change" },
    verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: false }, previewDigest: "sha256:preview",
    activation: { mode: "next_run", state: "not_requested" }, resumption: { state: "not_requested" },
    allowedActions: ["preview", "apply", "dismiss"], createdAt: "2026-11-09T00:00:00Z", updatedAt: "2026-11-09T00:00:00Z", ...overrides,
  };
}
function render(options: { request?: ConfigurationRequestView; notices?: boolean; emptyNotice?: boolean; error?: boolean; readOnly?: boolean; run?: ReturnType<typeof emptyRunStream> } = {}) {
  const card = options.request ?? request();
  return renderToStaticMarkup(<Conversation client={new ApiClient("test")} loading={false} run={options.run ?? emptyRunStream()}
    detail={{ id: "session", messages: options.notices ? [
      { id: "notice-1", kind: "configuration_notice", configurationRequestId: "cfg", content: options.emptyNotice ? "" : "raw receipt one", role: "assistant", createdAt: card.updatedAt },
      { id: "notice-2", kind: "configuration_notice", configurationRequestId: "cfg", content: options.emptyNotice ? "" : "raw receipt two", role: "assistant", createdAt: card.updatedAt },
    ] : [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
    configurationReadOnly={options.readOnly}
    configuration={{ requests: [card], legacyRequests: [], loading: false, error: options.error ?? false, refresh: async () => {}, update: () => {}, remove: () => {} }} />);
}

test("desktop shows a pending card even without a conversation message", () => {
  setLanguage("en");
  const html = render();
  assert.match(html, /id="configuration-request-cfg"/);
  assert.match(html, /Confirm/);
  assert.match(html, /This session · Subsequent runs/);
  assert.doesNotMatch(html, /No other sessions change|<details/);
});
test("a standalone configuration does not mistake two missing run IDs for an active run", () => {
  setLanguage("en");
  const html = render();
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Refresh proposed changes/);
  assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>Confirm/);
  assert.doesNotMatch(html, /Waiting for the current tool batch/);
});
test("compact omits default and authored reasons instead of hiding long prose in details", () => {
  for (const language of ["zh", "en"]) {
    setLanguage(language);
    for (const message of ["A configuration change is required", "Keep this authored explanation"]) {
      const html = render({ request: request({ reason: { code: "CONFIGURATION_REQUIRED", message } }) });
      assert.ok(!html.includes(message));
      assert.doesNotMatch(html, /<details|configuration-more/);
    }
  }
});
test("a matching active source run blocks configuration until its safe pause boundary", () => {
  const run = { ...emptyRunStream(), runId: "run" };
  const pending = render({ request: request({ runId: "run" }), run });
  assert.match(pending, /<button[^>]*disabled=""[^>]*>Confirm/);
  const paused = render({ request: request({ runId: "run", liveWait: true }), run });
  assert.doesNotMatch(paused, /<button[^>]*disabled=""[^>]*>Refresh proposed changes/);
});
test("resolved configuration renders one expandable receipt at its notice", () => {
  const html = render({ request: request({ state: "applied", allowedActions: ["query"] }), notices: true });
  assert.equal((html.match(/<details /g) ?? []).length, 1);
  assert.match(html, /desktop-configuration-record/);
  assert.match(html, /msg-collapse tool-card/);
  assert.match(html, /<span aria-hidden="true" class="collapse-chev">/);
  assert.match(html, /class="configuration-record-body"/);
  assert.doesNotMatch(html, /raw receipt one|raw receipt two|id="configuration-request-cfg"/);
});
test("pending cards replace their empty API anchors without a duplicate notice row", () => {
  setLanguage("en");
  const html = render({ notices: true, emptyNotice: true });
  assert.equal((html.match(/id="configuration-request-cfg"/g) ?? []).length, 1);
  assert.doesNotMatch(html, /is-notice|configuration_notice|Configuration update/);
});
test("nonempty configuration notices keep their content and a localized label", () => {
  setLanguage("zh-CN");
  const html = render({ notices: true });
  assert.match(html, /raw receipt one/);
  assert.match(html, /配置更新/);
  assert.doesNotMatch(html, /configuration_notice/);
  setLanguage("en");
});
test("desktop preserves its selected language in the shared card", () => {
  setLanguage("zh-CN");
  assert.match(render(), /选择任务模型/);
  setLanguage("en");
  assert.match(render(), /Choose a task model/);
});
test("a failed request refresh blocks writes and gives a retry without hiding the card", () => {
  setLanguage("en");
  const html = render({ error: true });
  assert.match(html, /id="configuration-request-cfg"/);
  assert.match(html, /could not refresh/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm/);
  assert.match(html, />Retry<\/button>/);
});
test("archived or evidence-only sessions cannot approve configuration changes", () => {
  const html = render({ readOnly: true });
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm/);
  assert.match(html, /<select[^>]*disabled=""/);
});

test("configuration refresh failure and retry update on a mounted language switch", async () => {
  const previousLanguage = getLanguage();
  let renderer: ReactTestRenderer | undefined;
  let refreshes = 0;
  try {
    setLanguage("en");
    await act(async () => {
      renderer = create(<Conversation client={new ApiClient("test")} loading={false} run={emptyRunStream()}
        detail={{ id: "session", messages: [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
        configuration={{ requests: [], legacyRequests: [], loading: false, error: true,
          refresh: async () => { refreshes++; }, update: () => {}, remove: () => {} }} />);
    });
    for (const [language, message, retry] of [
      ["en", "Configuration requests could not refresh.", "Retry"],
      ["zh-CN", "配置请求未能刷新。", "重试"],
      ["en", "Configuration requests could not refresh.", "Retry"],
    ] as const) {
      await act(async () => { setLanguage(language); });
      const alert = renderer!.root.findByProps({ role: "alert" });
      assert.ok(JSON.stringify(renderer!.toJSON()).includes(message));
      const button = alert.findByType("button");
      assert.deepEqual(button.children, [retry]);
      await act(async () => { (button.props.onClick as () => void)(); });
    }
    assert.equal(refreshes, 3);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    setLanguage(previousLanguage);
  }
});

test("compact single-value requests expose only the changed field", () => {
  const html = render({ request: request({ capabilityId: "timeouts.configure", scope: { kind: "global" },
    fields: ["runnerExecTimeoutMs", "gatewayIdleTimeoutMs"].map(id => ({ id, label: id, kind: "number", required: false, value: 90000 })),
    changes: [{ field: "runnerExecTimeoutMs", before: "60000", after: "90000" }] }) });
  assert.match(html, /name="runnerExecTimeoutMs"/);
  assert.doesNotMatch(html, /name="gatewayIdleTimeoutMs"/);
  assert.doesNotMatch(html, /configuration-more|<details/);
});

test("unsupported complex capabilities do not expose an editor or apply", () => {
  setLanguage("en");
  const html = render({ request: request({ capabilityId: "provider.connection" as never,
    fields: [{ id: "apiToken", label: "Key", kind: "credential", required: true, status: "missing" }] }) });
  assert.match(html, /Not supported here yet/g);
  assert.doesNotMatch(html, /type="password"|Confirm|Open settings/);
  assert.match(html, /Close/);
});

test("settings navigation passes only the group without calling a mutation", async () => {
  setLanguage("en");
  let renderer: ReactTestRenderer | undefined;
  const calls: unknown[] = [];
  const card = request({ capabilityId: "model.connect", fields: [] });
  try {
    await act(async () => { renderer = create(<Conversation client={new ApiClient("test")} loading={false} run={emptyRunStream()}
      detail={{ id: "session", messages: [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
      onOpenConfigurationSettings={(...args) => calls.push(args)}
      configuration={{ requests: [card], legacyRequests: [], loading: false, error: false, refresh: async () => {}, update: () => { throw new Error("Navigation must not mutate"); }, remove: () => {} }} />); });
    const buttons = renderer!.root.findAllByType("button");
    assert.ok(!buttons.some(button => button.children.includes("Confirm")));
    const open = buttons.find(button => button.children.includes("Open settings"))!;
    await act(async () => { (open.props.onClick as () => void)(); });
    assert.deepEqual(calls, [["models"]]);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test("session model selection rejects a request carrying another scope", () => {
  setLanguage("en");
  const html = render({ request: request({ scope: { kind: "global" } }) });
  assert.match(html, /Not supported here yet/g);
  assert.doesNotMatch(html, /name="modelId"|Confirm/);
});

test("complex supported requests use the existing settings pane", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  assert.deepEqual(desktopConfigurationPresentation(request({ capabilityId: "model.repair_credential" })), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation(request({ capabilityId: "timeouts.configure", fields: [
    { id: "a", kind: "number", label: "A", required: true, value: 1 },
    { id: "b", kind: "number", label: "B", required: true, value: 2 },
  ], changes: [{ field: "a", after: "1" }, { field: "b", after: "2" }] })), { settingsGroup: "timeouts" });
});

test("one changed field never hides required inputs or credential targets", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const missing = request({ capabilityId: "quotas.configure", fields: [
    { id: "limit", kind: "number", label: "Limit", required: true, value: 1 },
    { id: "required", kind: "text", label: "Required", required: true },
  ], changes: [{ field: "limit", after: "1" }] });
  assert.deepEqual(desktopConfigurationPresentation(missing), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation({ ...missing, fields: [{ id: "token", label: "Token", required: true, kind: "credential", status: "missing" }] }), { unsupported: true });
});

test("settings navigation preserves the original model page and add button", async () => {
  setLanguage("en");
  const { SystemSettingsDialog } = await import("../src/views/SystemSettingsDialog.js");
  const html = renderToStaticMarkup(<SystemSettingsDialog group="models" client={new ApiClient("test")}
    actions={{} as never} state={{ models: [], providers: [] } as never} onClose={() => {}} onGroupChange={() => {}} onShowGuide={() => {}} />);
  assert.match(html, /Add model/);
  assert.doesNotMatch(html, /configuration-settings-context|configuration-settings-request|Back to conversation|Request-only editor/);
});

test("MCP toggles retain the bound target while destructive actions remain unsupported", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const toggle = request({ capabilityId: "mcp.availability" as never, scope: { kind: "global" }, activation: { mode: "next_invocation" as never, state: "not_requested" }, fields: [
    { id: "serverId", kind: "enum", label: "Server", required: true, value: "custom-000000000abc", choices: [{ id: "custom-000000000abc", label: "arXiv" }] },
    { id: "enabled", kind: "boolean", label: "Enable", required: true, value: true },
  ], changes: [{ field: "enabled", before: "false", after: "true" }] });
  assert.deepEqual(desktopConfigurationPresentation(toggle), { fieldIds: ["enabled"], targetLabel: "arXiv (custom-000000000abc)" });
  assert.deepEqual(desktopConfigurationPresentation({ ...toggle, capabilityId: "mcp.delete" as never }), { unsupported: true });
});

test("compact model selection previews automatically but applies only after explicit confirmation", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  let renderer: ReactTestRenderer | undefined;
  const previews: unknown[] = [];
  const decisions: unknown[] = [];
  const initial = request();
  const next = { ...initial, revision: 2, previewDigest: "sha256:new", fields: initial.fields.map(field => ({ ...field, value: "second" })) } as ConfigurationRequestView;
  function Harness() {
    const [current, update] = React.useState(initial);
    return <ConfigurationRequestCard request={current} locale="en" compact={{}} ApiRequestError={ApiRequestError}
      ProcessRecord={({ children }) => <div>{children}</div>} onUpdate={update}
      actions={{ preview: async (input: unknown) => { previews.push(input); return next; },
        decide: async (input: unknown) => { decisions.push(input); return { ...next, state: "applied" }; } } as never} />;
  }
  try {
    await act(async () => { renderer = create(<Harness />); });
    await act(async () => { await renderer!.root.findByType("select").props.onChange({ target: { value: "second" } }); });
    assert.deepEqual(previews, [{ expectedRevision: 1, values: { modelId: "second" } }]);
    assert.deepEqual(decisions, []);
    const confirm = renderer!.root.findAllByType("button").find(button => button.children.includes("Confirm"))!;
    assert.equal(confirm.props.disabled, false);
    await act(async () => { confirm.props.onClick(); });
    assert.deepEqual(decisions, [{ revision: 2, previewDigest: "sha256:new", decision: "apply" }]);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test("historical model metadata no longer exposes even isolated edits", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const metadata = request({ capabilityId: "model.metadata" as never, scope: { kind: "global" }, fields: [
    { id: "modelId", kind: "enum", label: "Model", required: true, value: "profile", choices: [{ id: "profile", label: "Shared profile" }] },
    { id: "operation", kind: "enum", label: "Operation", required: true, value: "update" },
    { id: "vision", kind: "boolean", label: "Vision", required: false, value: true },
  ], changes: [{ field: "vision", before: "false", after: "true" }] });
  assert.deepEqual(desktopConfigurationPresentation(metadata), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation({ ...metadata, changes: [...metadata.changes, { field: "thinkingEffort", after: "high" }] }), { unsupported: true });
});

test("unsupported model metadata exposes only a close action in both locales", () => {
  const impact = "Long backend explanation of facts, pricing, stale snapshots, endpoint exclusions and continuation.";
  const metadata = request({ capabilityId: "model.metadata" as never, scope: { kind: "global" }, fields: [
    { id: "modelId", kind: "enum", label: "Model", required: true, value: "profile", choices: [{ id: "profile", label: "Shared profile" }] },
    { id: "operation", kind: "enum", label: "Operation", required: true, value: "update" },
    { id: "vision", kind: "boolean", label: "Vision", required: false, value: true },
  ], changes: [{ field: "vision", before: "false", after: "true" }],
  impact: { resourceLocation: "Model registry", effectiveScope: "Every session in this deployment", message: impact } });
  for (const locale of ["en", "zh"] as const) {
    setLanguage(locale);
    const html = render({ request: metadata });
    assert.equal(html.split(impact).length - 1, 0);
    assert.doesNotMatch(html, /<details|configuration-more/);
    const visible = html.replace(/<details[^>]*>[\s\S]*?<\/details>/g, "");
    assert.doesNotMatch(visible, /Long backend explanation/);
    assert.match(visible, locale === "en" ? /Not supported here yet/ : /暂不支持/);
    assert.match(visible, locale === "en" ? />Close</ : />关闭</);
    assert.doesNotMatch(visible, /<input|<select|>Confirm<|>Open settings</);
  }
});

test("simple security policy choices stay inline without dropping the independent consent gate", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const policy = request({ capabilityId: "security.approval_mode" as never,
    fields: [{ id: "approvalMode", label: "Approval", kind: "enum", required: true, value: "always_allow", choices: [{ id: "always_allow", label: "Always allow" }] }],
    changes: [{ field: "approvalMode", after: "always_allow" }],
    ...{ securityConsent: { revision: 1, targetDigest: "policy", status: "required", statement: "Future session actions may run without asking." } } });
  assert.deepEqual(desktopConfigurationPresentation(policy), {});
  setLanguage("en");
  const html = render({ request: policy });
  assert.match(html, /<select/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm/);
});

test("unknown capabilities and empty schemas never acquire Apply by field count", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  assert.deepEqual(desktopConfigurationPresentation(request({ capabilityId: "future.dangerous" as never, fields: [] })), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation(request({ capabilityId: "future.dangerous" as never })), { unsupported: true });
});

test("simple default proxy choice preserves security consent while routing locks its recipient", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const policy = request({ capabilityId: "proxy.default" as never, scope: { kind: "global" },
    fields: [{ id: "defaultPolicy", label: "Proxy", kind: "enum", required: true, value: "none", choices: [{ id: "none", label: "Direct" }] }],
    changes: [{ field: "defaultPolicy", after: "none" }],
    ...{ securityConsent: { revision: 1, targetDigest: "route", status: "required", statement: "Future inheriting traffic, including credentials, uses this route." } } });
  assert.deepEqual(desktopConfigurationPresentation(policy), {});
  const routing = request({ capabilityId: "proxy.provider" as never, scope: { kind: "global" }, fields: [
    { id: "providerId", label: "Provider", kind: "enum", required: true, value: "provider", choices: [{ id: "provider", label: "Shared provider" }] },
    { id: "proxyPolicy", label: "Proxy", kind: "enum", required: true, value: "none" },
  ], changes: [{ field: "proxyPolicy", after: "none" }] });
  assert.deepEqual(desktopConfigurationPresentation(routing), { fieldIds: ["proxyPolicy"], targetLabel: "Shared provider (provider)" });
});

test("proxy resource renames follow the actual custom URL, environment and system schemas", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const resource = (kind: string): ConfigurationRequestView => request({
    capabilityId: "proxy.resources" as never, scope: { kind: "global" },
    activation: { mode: "next_connection", state: "not_requested" },
    fields: [
      { id: "operation", label: "Operation", kind: "enum", required: true, value: "update", choices: [{ id: "update", label: "update" }] },
      { id: "proxyId", label: "Existing proxy resource", kind: "enum", required: true, value: "proxy", choices: [{ id: "proxy", label: "Shared proxy" }] },
      { id: "name", label: "Proxy name", kind: "text", required: true, value: "Renamed proxy" },
      { id: "kind", label: "Proxy type", kind: "enum", required: true, value: kind, choices: ["custom_url", "environment", "system"].map(id => ({ id, label: id })) },
      ...(kind === "custom_url" ? [{ id: "replaceUrl", label: "Replace stored proxy URL", kind: "boolean" as const, required: false, value: false }] : []),
    ],
    changes: [{ field: "name", before: "Shared proxy", after: "Renamed proxy" }],
    impact: { resourceLocation: "Shared proxy registry", effectiveScope: "Every session using this proxy", message: "Existing connections are not rebound; reachability remains unverified" },
  });
  for (const kind of ["custom_url", "environment", "system"]) {
    const pending = resource(kind);
    assert.deepEqual(desktopConfigurationPresentation(pending), { fieldIds: ["name"], targetLabel: "Shared proxy (proxy)" });
    const html = render({ request: pending });
    assert.match(html, /name="name"/);
    assert.doesNotMatch(html, /name="(?:proxyId|kind|replaceUrl)"/);
    assert.match(html, /Every session using this proxy/);
    assert.match(html, /[Rr]eachability remains unverified/);
    assert.deepEqual(desktopConfigurationPresentation({ ...pending, changes: [...pending.changes, { field: "kind", before: "system", after: "environment" }] }), { unsupported: true });
    assert.deepEqual(desktopConfigurationPresentation({ ...pending, fields: [...pending.fields, { id: "proxyUrl", label: "URL", kind: "credential", required: true, status: "missing" }] }), { unsupported: true });
    assert.deepEqual(desktopConfigurationPresentation({ ...pending, fields: pending.fields.map(field => field.id === "proxyId" && field.kind === "enum" ? { ...field, value: "unknown" } : field) }), { unsupported: true });
  }
  const custom = resource("custom_url");
  assert.deepEqual(desktopConfigurationPresentation({ ...custom, fields: custom.fields.filter(field => field.id !== "replaceUrl") }), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation({ ...custom, fields: custom.fields.map(field => field.id === "replaceUrl" && field.kind === "boolean" ? { ...field, value: true } : field) }), { unsupported: true });
  const system = resource("system");
  assert.deepEqual(desktopConfigurationPresentation({ ...system, fields: [...system.fields, { id: "replaceUrl", label: "Unexpected flag", kind: "boolean", required: false, value: false }] }), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation(resource("future_proxy")), { unsupported: true });
});


test("closing the settings host during a preview never reopens it or applies the late result", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  let renderer: ReactTestRenderer | undefined;
  let close!: () => void;
  let resolvePreview!: (request: ConfigurationRequestView) => void;
  let updates = 0, decisions = 0;
  function Host() {
    const [open, setOpen] = React.useState(true);
    close = () => setOpen(false);
    return open ? <div role="dialog"><ConfigurationRequestCard request={request()} locale="en"
      ApiRequestError={ApiRequestError} ProcessRecord={({ children }) => <div>{children}</div>} onUpdate={() => { updates++; }}
      actions={{ preview: () => new Promise(resolve => { resolvePreview = resolve; }), decide: async () => { decisions++; return request(); } } as never} /></div> : null;
  }
  try {
    await act(async () => { renderer = create(<Host />); });
    await act(async () => { renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }); });
    await act(async () => close());
    await act(async () => resolvePreview(request({ revision: 2 })));
    assert.equal(renderer!.root.findAllByProps({ role: "dialog" }).length, 0);
    assert.equal(updates, 0);
    assert.equal(decisions, 0);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

function mcpTarget() {
  return { id: "serverId", label: "Existing custom MCP server", kind: "enum" as const, required: true,
    value: "custom-123456789abc", choices: [{ id: "custom-123456789abc", label: "Shared MCP" }] };
}

test("existing MCP settings accepts only a valid bound server for header credentials and complex metadata", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const header = request({ capabilityId: "mcp.header_credential" as never, scope: { kind: "global" }, fields: [mcpTarget(),
    { id: "headerName", label: "Header", kind: "enum", required: true, value: "authorization", choices: [{ id: "authorization", label: "authorization" }] },
    { id: "apiToken", label: "Replacement", kind: "credential", required: true, status: "missing" },
  ] });
  assert.deepEqual(desktopConfigurationPresentation(header), { settingsGroup: "mcp", targetLabel: "Shared MCP (custom-123456789abc)" });
  assert.deepEqual(desktopConfigurationPresentation({ ...header, fields: [{ ...mcpTarget(), value: "deleted" }, ...header.fields.slice(1)] }), { unsupported: true });
  const metadata = request({ capabilityId: "mcp.metadata" as never, scope: { kind: "global" }, fields: [mcpTarget(),
    { id: "name", label: "Name", kind: "text", required: true, value: "New name" },
    { id: "description", label: "Description", kind: "text", required: false, value: "New description" },
  ], changes: [{ field: "name", after: "New name" }, { field: "description", after: "New description" }] });
  assert.equal(desktopConfigurationPresentation(metadata).settingsGroup, "mcp");

});

test("long real MCP timeout projections navigate to the original MCP pane without applying", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  // Projection shape and text from #773's createMcpTimeoutAdapter, not a
  // shortened fixture that misses the production card-length fallback.
  const impact = "Save a 1–600 second call timeout for this shared MCP server. Subsequent MCP invocations read this cap; calls already admitted retain limits they already read, and an earlier broker limit may remain stricter. This does not change a whole Run's frozen settings. Existing connections and in-flight requests are retained. No catalog refresh, discovery, network request, STDIO process, OAuth flow, retry or permission grant starts. A bound original configuration wait may continue normally; this is not proof of new runtime tools.";
  const view = request({ id: "mcp-timeout-real-shape", capabilityId: "mcp.timeout" as never, scope: { kind: "global" },
    fields: [mcpTarget(), { id: "timeoutSeconds", label: "Call timeout (seconds)", kind: "number", required: true,
      description: "Integer seconds, from 1 to 600", value: 45 }],
    changes: [{ field: "timeoutSeconds", before: "37", after: "45" }],
    impact: { resourceLocation: "Encrypted custom MCP configuration", effectiveScope: "This shared custom MCP server's subsequent calls", message: impact },
    activation: { mode: "next_invocation" as never, state: "not_requested" },
  });
  assert.equal(impact.length, 525);
  assert.deepEqual(desktopConfigurationPresentation(view), { settingsGroup: "mcp" });
  for (const invalid of [
    { scope: { kind: "session", id: view.sessionId } },
    { fields: view.fields.slice(1) },
    { fields: [...view.fields, { id: "apiToken", label: "Key", kind: "credential", required: true, status: "missing" }] },
    { autoApplyAt: "2099-01-01T00:00:00Z" },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...invalid } as ConfigurationRequestView), { unsupported: true });
  const previousLanguage = getLanguage();
  let renderer: ReactTestRenderer | undefined;
  try {
    for (const locale of ["en", "zh-CN"]) {
      setLanguage(locale);
      const navigation: unknown[] = [];
      await act(async () => { renderer = create(<Conversation client={new ApiClient("test")} loading={false} run={emptyRunStream()}
        detail={{ id: view.sessionId, messages: [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
        onOpenConfigurationSettings={(...args) => navigation.push(args)}
        configuration={{ requests: [{ ...view, id: `${view.id}-${locale}` }], legacyRequests: [], loading: false, error: false,
          refresh: async () => {}, update: () => { throw new Error("Navigation must not mutate"); }, remove: () => { throw new Error("Navigation must not settle"); } }} />); });
      const buttons = renderer!.root.findAllByType("button");
      assert.equal(buttons.length, 1);
      assert.deepEqual(buttons[0]!.children, [locale === "en" ? "Open settings" : "前往设置"]);
      assert.equal(renderer!.root.findAllByType("input").length, 0);
      assert.ok(!JSON.stringify(renderer!.toJSON()).includes(impact));
      assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Not supported here yet|暂不支持/);
      await act(async () => buttons[0]!.props.onClick());
      assert.deepEqual(navigation, [["mcp"]]);
      assert.equal(view.state, "awaiting_confirmation");
      assert.match(JSON.stringify(renderer!.toJSON()), locale === "en" ? /Have you finished changing these settings/ : /是否已完成修改/);
      assert.equal(renderer!.root.findAllByType("details").length, 0);
      await act(async () => renderer!.unmount()); renderer = undefined;
    }
  } finally {
    if (renderer) await act(async () => renderer!.unmount());
    setLanguage(previousLanguage);
  }
});

test("MCP request editor locks its server and uploads secrets only through the dedicated credential action", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const inputs: unknown[] = [], uploads: unknown[] = [], decisions: unknown[] = [];
  let renderer: ReactTestRenderer | undefined;
  const initial = request({ capabilityId: "mcp.header_credential" as never, scope: { kind: "global" }, fields: [mcpTarget(),
    { id: "headerName", label: "Header", kind: "enum", required: true, value: "authorization", choices: [{ id: "authorization", label: "authorization" }] },
    { id: "apiToken", label: "Replacement", kind: "credential", required: true, status: "missing" },
  ], endpointAuthorization: { endpointTarget: "https://mcp.example.test/", host: "mcp.example.test", classification: "public_https", status: "confirmed" } as never });
  function Host() {
    const [current, update] = React.useState(initial);
    return <ConfigurationRequestCard request={current} lockedFieldIds={["serverId"]} locale="en" ApiRequestError={ApiRequestError}
      ProcessRecord={({ children }) => <div>{children}</div>} onUpdate={update}
      actions={{ preview: async (input: unknown) => { inputs.push(input); return initial; },
        credential: async (input: unknown) => { uploads.push(input); return { handle: "opaque", expiresAt: "2099-01-01T00:00:00Z" }; },
        decide: async (input: unknown) => { decisions.push(input); return initial; } } as never} />;
  }
  try {
    await act(async () => { renderer = create(<Host />); });
    const server = renderer!.root.findAllByType("select").find(select => select.props.name === "serverId")!;
    assert.equal(server.props.disabled, true);
    await act(async () => server.props.onChange({ target: { value: "another-server" } }));
    await act(async () => renderer!.root.findByProps({ type: "password" }).props.onChange({ target: { value: "test-replacement-only" } }));
    await act(async () => {
      renderer!.root.findByType("form").props.onCompositionStartCapture();
      await renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} });
    });
    assert.equal(inputs.length, 0, "IME submit does not bind or preview a credential target");
    assert.equal(uploads.length, 0, "IME submit never uploads the partially composed secret");
    await act(async () => renderer!.root.findByType("form").props.onCompositionEndCapture());
    await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.equal(uploads.length, 1);
    assert.equal(JSON.stringify(inputs).includes("test-replacement-only"), false);
    assert.equal(JSON.stringify(inputs).includes("another-server"), false);
    assert.equal(JSON.stringify(inputs).includes("opaque"), true);
    assert.equal(decisions.length, 0);
    await act(async () => renderer!.unmount()); renderer = undefined;
    assert.equal(decisions.length, 0, "closing does not apply or invoke ordinary MCP Save/probe");
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test("destructive names stay exact and foreign or missing names cannot become confirmation cards", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  for (const [capabilityId, name, value] of [["mcp.remove_header", "headerName", "authorization"], ["mcp.remove_env", "envName", "Mixed_Case"]] as const) {
    const view = request({ capabilityId: capabilityId as never, scope: { kind: "global" }, fields: [mcpTarget(),
      { id: name, label: name, kind: "enum", required: true, value, choices: [{ id: value, label: value }] }], changes: [{ field: name, after: "Removed" }] });
    const result = desktopConfigurationPresentation(view);
    assert.equal(result.destructive, true);
    assert.deepEqual(result.fieldIds, []);
    assert.ok(result.targetLabel!.includes(value));
    assert.deepEqual(desktopConfigurationPresentation({ ...view, fields: [mcpTarget(), { ...view.fields[1]!, value: "unknown" } as never] }), { unsupported: true });
  }
});

test("server deletion is never prechecked even if a proposal supplies confirmDelete true", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const view = request({ capabilityId: "mcp.delete" as never, scope: { kind: "global" }, fields: [mcpTarget(),
    { id: "confirmDelete", label: "Delete this shared server", kind: "boolean", required: true, value: true }], changes: [{ field: "serverId", after: "Deleted; no automatic undo" }] });
  let renderer: ReactTestRenderer | undefined;
  try {
    await act(async () => { renderer = create(<ConfigurationRequestCard request={view} compact={{ destructive: true, fieldIds: ["confirmDelete"] }}
      locale="en" ApiRequestError={ApiRequestError} ProcessRecord={({ children }) => <div>{children}</div>} onUpdate={() => {}} actions={{} as never} />); });
    assert.equal(renderer!.root.findByProps({ name: "confirmDelete" }).props.checked, false);
    assert.equal(renderer!.root.findAllByType("button").find(button => button.children.includes("Confirm"))!.props.disabled, true);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test("real MCP collecting_input deletion exposes only the unchecked explicit confirmation", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const view = request({ capabilityId: "mcp.delete" as never, state: "collecting_input", previewDigest: undefined,
    scope: { kind: "global" }, fields: [mcpTarget(),
      { id: "confirmDelete", label: "Delete this shared server", kind: "boolean", required: true, value: false }],
    changes: [], activation: { mode: "next_invocation", state: "not_requested" }, allowedActions: ["preview", "dismiss"] });
  assert.deepEqual(desktopConfigurationPresentation(view), { fieldIds: ["confirmDelete"], destructive: true, targetLabel: "Shared MCP (custom-123456789abc)" });
  const html = render({ request: view });
  assert.match(html, /name="confirmDelete"/);
  assert.doesNotMatch(html, /checked=""|Confirm<\/button>/);
  assert.match(html, /Review<\/button>/);
});

test("provider credential removal and clearing model facts are separate destructive confirmations", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const provider = request({ capabilityId: "provider.remove_credential" as never, scope: { kind: "global" }, fields: [
    { id: "providerId", label: "Provider", kind: "enum", required: true, value: "provider", choices: [{ id: "provider", label: "Provider" }] },
  ], changes: [{ field: "providerCredential", after: "Removed; token-free provider declaration" }] });
  assert.equal(desktopConfigurationPresentation(provider).destructive, true);
  const facts = request({ capabilityId: "model.metadata" as never, scope: { kind: "global" }, fields: [
    { id: "modelId", label: "Model", kind: "enum", required: true, value: "model", choices: [{ id: "model", label: "Model" }] },
    { id: "operation", label: "Operation", kind: "enum", required: true, value: "clear_facts", choices: [{ id: "clear_facts", label: "Clear all user fact overrides" }] },
  ], changes: [{ field: "contextWindow", before: "10000", after: "No user override" }] });
  assert.deepEqual(desktopConfigurationPresentation(facts), { unsupported: true });
  assert.deepEqual(desktopConfigurationPresentation({ ...facts, changes: [{ field: "vision", after: "false" }] }), { unsupported: true });
});

test("destructive acknowledgment alone does not apply and a background revision invalidates it", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const initial = request({ capabilityId: "provider.remove_credential" as never, scope: { kind: "global" }, fields: [
    { id: "providerId", label: "Provider", kind: "enum", required: true, value: "provider", choices: [{ id: "provider", label: "Provider" }] },
  ], changes: [{ field: "providerCredential", after: "Removed" }] });
  let renderer: ReactTestRenderer | undefined;
  let decisions = 0;
  const props = { compact: { destructive: true, fieldIds: [] }, locale: "en", ApiRequestError,
    ProcessRecord: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, onUpdate() {},
    actions: { decide: async () => { decisions++; return { ...initial, state: "applied" }; } } as never };
  try {
    await act(async () => { renderer = create(<ConfigurationRequestCard {...props} request={initial} />); });
    const confirm = () => renderer!.root.findAllByType("button").find(button => button.children.includes("Confirm"))!;
    assert.equal(confirm().props.disabled, true);
    await act(async () => renderer!.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
    assert.equal(decisions, 0);
    assert.equal(confirm().props.disabled, false);
    const firstCommit: boolean[] = [];
    // Profiler runs in commit, before passive effects: inspect the first
    // committed props rather than letting act flush away a stale enabled frame.
    const wrap = (view: ConfigurationRequestView) => <React.Profiler id="ack" onRender={() => {
      if (renderer) firstCommit.push(Boolean(confirm().props.disabled));
    }}><ConfigurationRequestCard {...props} request={view} /></React.Profiler>;
    // Preserve the component across the tested update (adding a wrapper remounts).
    await act(async () => renderer!.update(wrap(initial)));
    await act(async () => renderer!.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
    const currentOldClick = confirm().props.onClick;
    firstCommit.length = 0;
    await act(async () => renderer!.update(wrap({ ...initial, revision: 2, previewDigest: "changed" })));
    assert.equal(firstCommit[0], true);
    await act(async () => currentOldClick());
    assert.equal(decisions, 0);
    assert.equal(confirm().props.disabled, true);
    assert.equal(renderer!.root.findByProps({ type: "checkbox" }).props.checked, false);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test("MCP credential navigation passes only group and request id and cannot approve an unconfirmed recipient", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const header = request({ capabilityId: "mcp.header_credential" as never, scope: { kind: "global" }, fields: [mcpTarget(),
    { id: "headerName", label: "Header", kind: "enum", required: true, value: "authorization", choices: [{ id: "authorization", label: "authorization" }] },
    { id: "apiToken", label: "Replacement", kind: "credential", required: true, status: "missing" },
  ], endpointAuthorization: { endpointTarget: "https://mcp.example.test/", host: "mcp.example.test", classification: "public_https", status: "required" } as never });
  const html = renderToStaticMarkup(<ConfigurationRequestCard request={header} lockedFieldIds={["serverId"]} locale="en"
    ApiRequestError={ApiRequestError} ProcessRecord={({ children }) => <div>{children}</div>} onUpdate={() => {}} actions={{} as never} />);
  assert.doesNotMatch(html, /type="password"/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm this change/);
  let renderer: ReactTestRenderer | undefined;
  const navigation: unknown[] = [];
  try {
    setLanguage("en");
    await act(async () => { renderer = create(<Conversation client={{} as never} loading={false} run={emptyRunStream()}
      detail={{ id: "session", messages: [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
      onOpenConfigurationSettings={(...args) => navigation.push(args)}
      configuration={{ requests: [header], legacyRequests: [], loading: false, error: false, refresh: async () => {}, update: () => { throw new Error("Navigation must not save"); }, remove: () => {} }} />); });
    await act(async () => renderer!.root.findAllByType("button").find(button => button.children.includes("Open settings"))!.props.onClick());
    assert.deepEqual(navigation, [["mcp"]]);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

test("configuration receipts distinguish saved values, future activation and pending task continuation", () => {
  setLanguage("en");
  const html = render({ request: request({ state: "applied", allowedActions: ["query"],
    activation: { mode: "next_run", state: "needs_user_action" }, resumption: { state: "pending" } }) });
  assert.match(html, /Saved/);
  assert.match(html, /Applies to subsequent runs/);
  assert.match(html, /Waiting for a subsequent run/);
  assert.match(html, /Continuation pending/);
  assert.doesNotMatch(html, /type="submit"|Confirm/);
  // The presentation never invokes a new Run or a permission decision merely
  // because a model configuration has been saved. Frozen run snapshots and
  // tool execution authorization remain owned by their existing backend paths.
});

test("configuration forms do not preview while an IME owns submission, but ordinary Enter and submit still work", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  for (const compact of [undefined, {}]) {
    let renderer: ReactTestRenderer | undefined;
    let previews = 0;
    const view = request({ capabilityId: "timeouts.configure", fields: [{ id: "runnerExecTimeoutMs", label: "Timeout", kind: "number", required: false, value: 90000 }] });
    try {
      function Harness() {
        const [current, update] = React.useState(view);
        return <ConfigurationRequestCard request={current} compact={compact} locale="en" ApiRequestError={ApiRequestError}
          ProcessRecord={({ children }) => <div>{children}</div>} onUpdate={update}
          actions={{ preview: async () => { previews++; return { ...current, revision: current.revision + 1 }; } } as never} />;
      }
      await act(async () => { renderer = create(<Harness />); });
      const form = () => renderer!.root.findByType("form");
      await act(async () => {
        form().props.onCompositionStartCapture?.();
        await form().props.onSubmit({ preventDefault() {} });
      });
      assert.equal(previews, 0, "an active composition must not reach preview");
      await act(async () => form().props.onCompositionEndCapture?.());
      for (const event of [
        { key: "Enter", keyCode: 13, nativeEvent: { isComposing: true } },
        { key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } },
      ]) {
        await act(async () => {
          form().props.onKeyDownCapture?.(event);
          await form().props.onSubmit({ preventDefault() {} });
        });
        assert.equal(previews, 0, "IME Enter after compositionend must not become an implicit submit");
      }
      await act(async () => {
        form().props.onKeyDownCapture?.({ key: "Enter", keyCode: 13, nativeEvent: { isComposing: false } });
        await form().props.onSubmit({ preventDefault() {} });
      });
      assert.equal(previews, 1, "normal Enter still previews");
      await act(async () => {
        form().props.onKeyDownCapture?.({ key: "Enter", keyCode: 229, nativeEvent: { isComposing: false } });
        await new Promise(resolve => setTimeout(resolve, 0));
      });
      await act(async () => form().props.onSubmit({ preventDefault() {} }));
      assert.equal(previews, 2, "an explicit submit is not left blocked");
    } finally { if (renderer) await act(async () => renderer!.unmount()); }
  }
});

test("inherit scalar overrides require a complete locked preview and explicit destructive confirmation", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const inherit = request({ capabilityId: "settings.inherit", fields: [{ id: "selectedFields", label: "Ordinary settings to inherit", kind: "multiselect", required: true, value: ["modelId"], choices: [{ id: "modelId", label: "Task model" }] }],
    changes: [{ field: "modelId", before: "model", after: "Inherit (global): model" }],
    impact: { resourceLocation: "Ordinary runtime setting overrides", effectiveScope: "Project project and its inheriting Sessions", message: "Even an equal explicit value becomes inherited. Project changes affect inheriting Sessions. Already queued/frozen runs stay unchanged." } });
  assert.deepEqual(desktopConfigurationPresentation(inherit), { fieldIds: [], destructive: true });
  assert.deepEqual(desktopConfigurationPresentation({ ...inherit, scope: { kind: "project", id: "project" } }), { fieldIds: [], destructive: true });
  const html = render({ request: inherit });
  assert.match(html, /Inherit \(global\): model/);
  assert.match(html, /future runs inherit the value/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>Confirm/);
  assert.doesNotMatch(html, /<select/);
  for (const invalid of [
    { state: "awaiting_input" }, { previewDigest: undefined }, { scope: { kind: "global" } }, { scope: { kind: "session", id: "other" } },
    { changes: [] }, { changes: [{ field: "modelId", before: "model", after: "model" }] },
    ...[[], ["modelId", "reviewModelId"], ["enabledConnectorIds"], ["skillSelectionMode"], ["unknown"]].map(value => ({ fields: [{ ...inherit.fields[0], value }] })),
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...inherit, ...invalid } as ConfigurationRequestView), { unsupported: true });
  for (const id of ["reviewModelId", "semanticReviewEnabled", "thinkingMode", "thinkingEffort"])
    assert.deepEqual(desktopConfigurationPresentation({ ...inherit, fields: [{ ...inherit.fields[0], value: [id], choices: [{ id, label: id }] } as never], changes: [{ field: id, before: "same", after: "Inherit (project): same" }] }), { fieldIds: [], destructive: true });
});

test("Web scalar cards preserve backend support, paid-provider impact and restart boundaries", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const common: ConfigurationRequestView["fields"] = [
    { id: "deepseekEnabled", label: "deepseekEnabled", kind: "boolean", required: false, value: true },
    { id: "fetchProvider", label: "fetchProvider", kind: "enum", required: false, value: "jina", choices: [{ id: "jina", label: "jina" }, { id: "deepseek", label: "deepseek" }] },
    { id: "freeSearchEngines", label: "freeSearchEngines", kind: "multiselect", required: false, value: ["bing"], choices: [{ id: "bing", label: "bing" }] },
    { id: "paidSearchProviders", label: "paidSearchProviders", kind: "multiselect", required: false, value: [], choices: [{ id: "deepseek", label: "deepseek" }] },
  ];
  const native = request({ capabilityId: "web.configure", scope: { kind: "global" }, fields: [...common,
    { id: "searchCacheTtlSeconds", label: "searchCacheTtlSeconds", kind: "number", required: false, value: 60 },
    { id: "fetchCacheTtlSeconds", label: "fetchCacheTtlSeconds", kind: "number", required: false, value: 60 },
    { id: "proxyPolicy", label: "proxyPolicy", kind: "enum", required: false, value: "inherit", choices: [{ id: "inherit", label: "inherit" }] },
  ], changes: [{ field: "deepseekEnabled", before: "false", after: "true" }], impact: { resourceLocation: "Deployment Web settings", effectiveScope: "Every session using the Web backend", message: "Paid providers can incur charges when later used. No search, fetch, connection test or model call is performed." } });
  for (const field of ["deepseekEnabled", "fetchProvider", "searchCacheTtlSeconds", "fetchCacheTtlSeconds", "proxyPolicy"])
    assert.deepEqual(desktopConfigurationPresentation({ ...native, changes: [{ field, before: "old", after: "new" }] }), { fieldIds: [field] });
  assert.match(render({ request: native }), /Paid providers may charge/);
  const swarm = { ...native, fields: common, activation: { mode: "requires_restart", state: "not_requested" },
    impact: { ...native.impact, message: "JiuwenSwarm: saved locally only. Restart the API; remote activation is not verified by this receipt. Paid providers can incur charges." } } as ConfigurationRequestView;
  assert.match(render({ request: swarm }), /Remote activation is unverified/);
  for (const field of ["deepseekEnabled", "fetchProvider"])
    assert.deepEqual(desktopConfigurationPresentation({ ...swarm, changes: [{ field, before: "old", after: "new" }] }), { fieldIds: [field] });
  for (const invalid of [
    { ...native, state: "awaiting_input" }, { ...native, previewDigest: undefined }, { ...native, scope: { kind: "session", id: "session" } },
    { ...native, fields: common }, { ...swarm, fields: native.fields },
    { ...swarm, changes: [{ field: "searchCacheTtlSeconds", after: "60" }] },
    { ...swarm, changes: [...swarm.changes, { field: "fetchProvider", before: "tavily", after: "jina" }] },
    { ...native, changes: [{ field: "paidSearchProviders", after: "deepseek" }] },
    { ...native, fields: [...native.fields, { id: "apiKey", kind: "credential", status: "present" }] },
    { ...native, fields: [...native.fields, { id: "endpoint", kind: "url", value: "https://example.com" }] },
  ]) assert.deepEqual(desktopConfigurationPresentation(invalid as ConfigurationRequestView), { unsupported: true });
});

test("MCP deletion carries explicit acknowledgment only through its own preview before manual Apply", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const initial = request({ capabilityId: "mcp.delete" as never, state: "collecting_input", previewDigest: undefined, scope: { kind: "global" },
    fields: [mcpTarget(), { id: "confirmDelete", label: "Delete", kind: "boolean", required: true, value: false }], changes: [], allowedActions: ["preview", "dismiss"] });
  const next = { ...initial, revision: 2, state: "awaiting_confirmation", previewDigest: "delete-preview", allowedActions: ["preview", "apply", "dismiss"],
    fields: [mcpTarget(), { ...initial.fields[1], value: true }], changes: [{ field: "serverId", after: "Deleted; no automatic undo" }] } as ConfigurationRequestView;
  let renderer: ReactTestRenderer | undefined;
  let previews = 0, decisions = 0;
  const props = { compact: { destructive: true, fieldIds: ["confirmDelete"] }, locale: "en", ApiRequestError,
    ProcessRecord: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
    onUpdate(view: ConfigurationRequestView) { renderer!.update(<ConfigurationRequestCard {...props} request={view} />); },
    actions: { preview: async (input: { values: Record<string, unknown> }) => { previews++; assert.equal(input.values.confirmDelete, true); return next; },
      decide: async (input: { revision: number; previewDigest: string }) => { decisions++; assert.equal(input.revision, 2); assert.equal(input.previewDigest, "delete-preview"); return { ...next, state: "applied" }; } } as never };
  try {
    await act(async () => { renderer = create(<ConfigurationRequestCard {...props} request={initial} />); });
    await act(async () => renderer!.root.findByProps({ name: "confirmDelete" }).props.onChange({ target: { checked: true } }));
    assert.equal(previews, 0); assert.equal(decisions, 0);
    await act(async () => renderer!.root.findByType("form").props.onSubmit({ preventDefault() {} }));
    assert.equal(previews, 1); assert.equal(decisions, 0);
    const button = renderer!.root.findAllByType("button").find(button => button.children.includes("Confirm"))!;
    assert.equal(button.props.disabled, false);
    await act(async () => button.props.onClick());
    assert.equal(decisions, 1);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});

function timeoutRequest(): ConfigurationRequestView {
  return request({ capabilityId: "timeouts.configure", scope: { kind: "global" },
    reason: { code: "CONFIGURATION_REQUIRED", message: "A configuration change is required" },
    fields: [
      { id: "runnerExecTimeoutMs", label: "Runner execution timeout (ms)", kind: "number", required: false, value: 90000, description: "0 disables the runner execution limit." },
      { id: "gatewayIdleTimeoutMs", label: "Gateway idle timeout (ms)", kind: "number", required: false, value: 120000 },
    ], changes: [{ field: "runnerExecTimeoutMs", before: "0", after: "90000" }],
    impact: { resourceLocation: "Deployment system settings", effectiveScope: "Every session in this deployment", message: "Existing runs retain their frozen timeouts." },
  });
}

test("compact timeout has no hidden details while oldWeb retains the full explanation", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const props = { request: timeoutRequest(), locale: "en", ApiRequestError,
    ProcessRecord: ({ children }: { children: React.ReactNode }) => <div>{children}</div>, onUpdate() {}, actions: {} as never };
  const compact = renderToStaticMarkup(<ConfigurationRequestCard {...props} compact={{ fieldIds: ["runnerExecTimeoutMs"] }} />);
  const visible = compact.replace(/<details\b[\s\S]*?<\/details>/g, "");
  assert.match(visible, /All sessions · Subsequent runs/);
  assert.match(visible, /name="runnerExecTimeoutMs"[^>]*value="90000"/);
  assert.match(visible, />Confirm<\/button>/); assert.match(visible, />Cancel<\/button>/);
  assert.doesNotMatch(visible, /eyebrow|Waiting for confirmation|A configuration change is required|configuration-diff|0 disables|Refresh proposed changes|Fields changed|Existing runs retain/);
  assert.doesNotMatch(compact, /<details|Existing runs retain their frozen timeouts|0 disables the runner execution limit/);
  const full = renderToStaticMarkup(<ConfigurationRequestCard {...props} />);
  assert.match(full, /Configuration request/); assert.match(full, /Refresh proposed changes/);
  assert.match(full, /name="gatewayIdleTimeoutMs"/); assert.match(full, /0 disables/);
  assert.doesNotMatch(full, /configuration-request-compact/);
  const zero = { ...props.request, fields: props.request.fields.map(field => field.id === "runnerExecTimeoutMs" ? { ...field, value: 0 } : field) } as ConfigurationRequestView;
  assert.match(renderToStaticMarkup(<ConfigurationRequestCard {...props} request={zero} compact={{ fieldIds: ["runnerExecTimeoutMs"] }} />).replace(/<details\b[\s\S]*?<\/details>/g, ""), /No timeout limit/);
});

test("compact warnings stay visible outside details, including costs, routing and restart", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const view = request({ capabilityId: "proxy.provider" as never, activation: { mode: "requires_restart", state: "not_requested" },
    verificationPlan: { targets: [], actions: [], maxRequests: 1, mayCharge: true },
    impact: { resourceLocation: "Provider", effectiveScope: "All sessions using this provider", message: "Routes future requests through this exact proxy." } });
  const html = renderToStaticMarkup(<ConfigurationRequestCard request={view} compact={{ targetLabel: "Exact provider" }} locale="en" ApiRequestError={ApiRequestError}
    ProcessRecord={({ children }) => <div>{children}</div>} actions={{} as never} onUpdate={() => {}} />).replace(/<details\b[\s\S]*?<\/details>/g, "");
  for (const content of ["Restart required", "Verification may consume API credits", "New connections use this route", "Exact provider", "All sessions using this provider"])
    assert.ok(html.includes(content), content);
});

async function mountCompactScalar(options: { classify?: boolean; compact?: boolean; readOnly?: boolean; runActive?: boolean;
  preview?: (input: { expectedRevision: number; values: Record<string, unknown> }) => Promise<ConfigurationRequestView>;
  decide?: () => Promise<ConfigurationRequestView>; query?: () => Promise<ConfigurationRequestView> } = {}) {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  let current = timeoutRequest(), readOnly = options.readOnly ?? false, runActive = options.runActive ?? false;
  let renderer!: ReactTestRenderer;
  const previews: Array<{ expectedRevision: number; values: Record<string, unknown> }> = [];
  const decisions: unknown[] = [], updates: ConfigurationRequestView[] = [];
  const actions = { preview: async (input: { expectedRevision: number; values: Record<string, unknown> }) => {
    previews.push(input);
    if (options.preview) return options.preview(input);
    return { ...current, revision: current.revision + 1, previewDigest: `preview:${current.revision + 1}`,
      fields: current.fields.map(field => field.kind !== "credential" ? { ...field, value: input.values[field.id] } : field) } as ConfigurationRequestView;
  }, decide: async (input: unknown) => { decisions.push(input); return options.decide ? options.decide() : { ...current, state: "applied" }; }, query: async () => options.query ? options.query() : current };
  const draw = () => <ConfigurationRequestCard request={current} compact={options.compact === false ? undefined : options.classify ? { ...desktopConfigurationPresentation(current), unsupported: desktopConfigurationPresentation(current).unsupported || Boolean(desktopConfigurationPresentation(current).settingsGroup) } : { fieldIds: ["runnerExecTimeoutMs"] }}
    locale="en" ApiRequestError={ApiRequestError} readOnly={readOnly} runActive={runActive} ProcessRecord={({ children }) => <div>{children}</div>} actions={actions as never}
    onUpdate={next => { current = next; updates.push(next); renderer.update(draw()); }} />;
  await act(async () => { renderer = create(draw()); });
  return { renderer, previews, decisions, updates,
    input: () => renderer.root.findByProps({ name: "runnerExecTimeoutMs" }),
    confirm: () => renderer.root.findAllByType("button").find(button => button.children.includes(options.compact === false ? "Confirm this change" : "Confirm"))!,
    replace: (next: ConfigurationRequestView) => { current = next; renderer.update(draw()); },
    readOnly: () => { readOnly = true; renderer.update(draw()); },
    runActive: () => { runActive = true; renderer.update(draw()); },
  };
}
const waitForCompactPreview = () => new Promise(resolve => setTimeout(resolve, 340));

test("compact scalar debounces the latest edit with full server values and never applies automatically", async () => {
  const h = await mountCompactScalar();
  try {
    const staleConfirm = h.confirm().props.onClick;
    await act(async () => h.input().props.onChange({ target: { value: "91000" } }));
    await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
    assert.equal(h.confirm().props.disabled, true);
    await act(async () => staleConfirm());
    assert.equal(h.decisions.length, 0, "an old enabled click cannot apply an edited preview");
    await act(waitForCompactPreview);
    assert.deepEqual(h.previews, [{ expectedRevision: 1, values: { runnerExecTimeoutMs: 92000, gatewayIdleTimeoutMs: 120000 } }]);
    assert.equal(h.decisions.length, 0); assert.equal(h.confirm().props.disabled, false);
    assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()), /Fields changed|Refresh proposed changes/);
    await act(async () => h.confirm().props.onClick());
    assert.deepEqual(h.decisions, [{ revision: 2, previewDigest: "preview:2", decision: "apply" }]);
  } finally { await act(async () => h.renderer.unmount()); }
});

test("compact scalar waits for IME composition and complete numbers, while oldWeb still needs explicit preview", async () => {
  for (const compact of [true, false]) {
    const h = await mountCompactScalar({ compact });
    try {
      await act(async () => h.renderer.root.findByType("form").props.onCompositionStartCapture());
      await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
      await act(waitForCompactPreview); assert.equal(h.previews.length, 0);
      await act(async () => h.renderer.root.findByType("form").props.onCompositionEndCapture());
      await act(async () => h.input().props.onChange({ target: { value: "" } }));
      await act(waitForCompactPreview); assert.equal(h.previews.length, 0);
      await act(async () => h.input().props.onChange({ target: { value: "93000" } }));
      await act(waitForCompactPreview); assert.equal(h.previews.length, compact ? 1 : 0);
      assert.equal(h.decisions.length, 0);
    } finally { await act(async () => h.renderer.unmount()); }
  }
});

test("compact scalar never sends a preview after readOnly, a running task or unmount", async () => {
  for (const stop of ["readOnly", "runActive", "unmount"] as const) {
    const h = await mountCompactScalar();
    await act(async () => h.input().props.onChange({ target: { value: "91000" } }));
    await act(async () => stop === "unmount" ? h.renderer.unmount() : h[stop]());
    await act(waitForCompactPreview);
    assert.equal(h.previews.length, 0, stop); assert.equal(h.decisions.length, 0);
    if (stop !== "unmount") await act(async () => h.renderer.unmount());
  }
});

test("compact preview failures retain the input and do not repeatedly retry", async () => {
  const { ApiRequestError } = await import("../src/api/client.js");
  for (const status of [400, 409, 429, 500]) {
    const h = await mountCompactScalar({ preview: async () => { throw new ApiRequestError("private error", status); } });
    try {
      await act(async () => h.input().props.onChange({ target: { value: "91000" } }));
      await act(waitForCompactPreview); await act(waitForCompactPreview);
      assert.equal(h.previews.length, 1); assert.equal(h.input().props.value, "91000");
      assert.equal(h.confirm().props.disabled, true); assert.equal(h.decisions.length, 0);
      assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()), /private error/);
    } finally { await act(async () => h.renderer.unmount()); }
  }
});

test("new background revisions cancel pending scalar previews and stale responses cannot overwrite them", async () => {
  let resolve!: (view: ConfigurationRequestView) => void;
  const h = await mountCompactScalar({ preview: () => new Promise(done => { resolve = done; }) });
  try {
    await act(async () => h.input().props.onChange({ target: { value: "91000" } }));
    await act(waitForCompactPreview); assert.equal(h.previews.length, 1);
    const newer = { ...timeoutRequest(), revision: 4, previewDigest: "latest", fields: timeoutRequest().fields.map(field => field.id === "runnerExecTimeoutMs" ? { ...field, value: 94000 } : field) } as ConfigurationRequestView;
    await act(async () => h.replace(newer));
    await act(async () => resolve({ ...timeoutRequest(), revision: 2, previewDigest: "late" }));
    assert.equal(h.updates.length, 0); assert.equal(h.input().props.value, "91000");
    assert.equal(h.confirm().props.disabled, true, "unowned background revisions require refresh, not partial confirmation");
    await act(waitForCompactPreview); assert.equal(h.previews.length, 1); assert.equal(h.decisions.length, 0);
  } finally { await act(async () => h.renderer.unmount()); }
});

test("unmounted compact cards ignore in-flight preview success and failure", async () => {
  for (const reject of [false, true]) {
    let finish!: () => void;
    const h = await mountCompactScalar({ preview: () => new Promise((resolve, fail) => { finish = () => reject ? fail(new Error("late")) : resolve({ ...timeoutRequest(), revision: 2 }); }) });
    await act(async () => h.input().props.onChange({ target: { value: "91000" } }));
    await act(waitForCompactPreview);
    await act(async () => h.renderer.unmount());
    await act(async () => finish());
    assert.equal(h.updates.length, 0); assert.equal(h.decisions.length, 0);
  }
});

test("even a queued obsolete debounce callback cannot submit old values under a new edit generation", async () => {
  const original = globalThis.setTimeout;
  const callbacks: Array<() => void> = [];
  globalThis.setTimeout = ((callback: (...args: unknown[]) => void, delay: number, ...args: unknown[]) => {
    if (delay === 300) { callbacks.push(() => callback(...args)); return original(() => {}, 60000); }
    return original(callback, delay, ...args);
  }) as typeof setTimeout;
  let h: Awaited<ReturnType<typeof mountCompactScalar>> | undefined;
  try {
    h = await mountCompactScalar();
    await act(async () => h!.input().props.onChange({ target: { value: "91000" } }));
    assert.equal(callbacks.length, 1);
    await act(async () => {
      h!.input().props.onChange({ target: { value: "92000" } });
      callbacks[0]!(); // New edit has happened; React has not cleaned the old effect yet.
    });
    assert.equal(h.previews.length, 0);
    await act(async () => callbacks.at(-1)!());
    assert.equal(h.previews.length, 1);
    assert.equal(h.previews[0]!.values.runnerExecTimeoutMs, 92000);
  } finally {
    if (h) await act(async () => h!.renderer.unmount());
    globalThis.setTimeout = original;
  }
});

test("a compact no-change preview retains only its own already-classified scalar editor", async () => {
  const h = await mountCompactScalar({ classify: true, preview: async input => ({ ...timeoutRequest(), revision: input.expectedRevision + 1,
    fields: timeoutRequest().fields.map(field => ({ ...field, value: input.values[field.id] })),
    state: input.values.runnerExecTimeoutMs === 0 ? "collecting_input" : "awaiting_confirmation",
    allowedActions: input.values.runnerExecTimeoutMs === 0 ? ["preview", "dismiss"] : ["preview", "apply", "dismiss"],
    changes: input.values.runnerExecTimeoutMs === 0 ? [] : [{ field: "runnerExecTimeoutMs", before: "0", after: String(input.values.runnerExecTimeoutMs) }],
    previewDigest: `preview:${input.expectedRevision + 1}`,
  }) as ConfigurationRequestView });
  try {
    await act(async () => h.input().props.onChange({ target: { value: "0" } }));
    await act(waitForCompactPreview);
    assert.equal(h.input().props.value, "0"); assert.equal(h.confirm().props.disabled, true);
    assert.match(JSON.stringify(h.renderer.toJSON()), /Already set/);
    await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
    await act(waitForCompactPreview);
    assert.equal(h.previews[1]!.expectedRevision, 2); assert.equal(h.input().props.value, "92000");
    assert.equal(h.confirm().props.disabled, false); assert.equal(h.decisions.length, 0);
    // Retention is local to the exact returned view, never a permission for a
    // different request or schema, even with the same scalar field name.
    await act(async () => h.replace({ ...timeoutRequest(), id: "another", revision: 2, state: "collecting_input", changes: [], allowedActions: ["preview", "dismiss"] }));
    assert.equal(h.renderer.root.findAllByProps({ name: "runnerExecTimeoutMs" }).length, 0);
  } finally { await act(async () => h.renderer.unmount()); }
});

test("compact zero quotas and future thinking or review costs remain visible without verification charges", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  for (const [capabilityId, id, warning] of [["quotas.configure", "runnerMaxOutputBytes", "Removes this size limit"],
    ["thinking.configure", "thinkingMode", "May increase model token usage and cost"],
    ["review.configure", "level", "May increase model token usage and cost"]] as const) {
    const view = request({ capabilityId, fields: [{ id, label: id, kind: "number", required: false, value: 0 }], changes: [{ field: id, before: "1", after: "0" }] });
    const html = renderToStaticMarkup(<ConfigurationRequestCard request={view} compact={{ fieldIds: [id] }} locale="en" ApiRequestError={ApiRequestError}
      ProcessRecord={({ children }) => <div>{children}</div>} actions={{} as never} onUpdate={() => {}} />).replace(/<details\b[\s\S]*?<\/details>/g, "");
    assert.ok(html.includes(warning), capabilityId);
  }
});

function scalarPreview(input: { expectedRevision: number; values: Record<string, unknown> }): ConfigurationRequestView {
  return { ...timeoutRequest(), revision: input.expectedRevision + 1, previewDigest: `preview:${input.expectedRevision + 1}`,
    fields: timeoutRequest().fields.map(field => ({ ...field, value: input.values[field.id] })),
    changes: [{ field: "runnerExecTimeoutMs", before: "0", after: String(input.values.runnerExecTimeoutMs) }],
  } as ConfigurationRequestView;
}

test("slow automatic previews keep typing enabled and serialize only the newest draft with advanced CAS", async () => {
  const finish: Array<() => void> = [];
  const h = await mountCompactScalar({ preview: input => new Promise(resolve => { finish.push(() => resolve(scalarPreview(input))); }) });
  try {
    const input = h.input(), id = input.props.id;
    const oldConfirm = h.confirm().props.onClick;
    await act(async () => h.input().props.onChange({ target: { value: "92" } }));
    await act(waitForCompactPreview);
    assert.equal(h.previews.length, 1); assert.equal(h.input().props.disabled, false);
    assert.equal(h.renderer.root.findAllByType("button").find(button => button.children.includes("Cancel"))!.props.disabled, true,
      "Cancel waits for the in-flight server revision rather than racing its CAS");
    await act(async () => {
      for (const value of ["920", "9200", "92000"]) h.input().props.onChange({ target: { value } });
      oldConfirm();
    });
    assert.equal(h.input().props.value, "92000"); assert.equal(h.confirm().props.disabled, true);
    await act(waitForCompactPreview); assert.equal(h.previews.length, 1);
    await act(async () => finish[0]!());
    assert.equal(h.input(), input, "same host input instance, without a disable/remount focus interruption");
    assert.equal(h.input().props.id, id); assert.equal(h.input().props.value, "92000");
    assert.equal(h.input().props.disabled, false); assert.equal(h.confirm().props.disabled, true);
    await act(waitForCompactPreview);
    assert.deepEqual(h.previews, [
      { expectedRevision: 1, values: { runnerExecTimeoutMs: 92, gatewayIdleTimeoutMs: 120000 } },
      { expectedRevision: 2, values: { runnerExecTimeoutMs: 92000, gatewayIdleTimeoutMs: 120000 } },
    ]);
    assert.equal(h.input().props.disabled, false); assert.equal(h.confirm().props.disabled, true);
    await act(async () => finish[1]!());
    assert.equal(h.confirm().props.disabled, false); assert.equal(h.decisions.length, 0);
    await act(async () => h.confirm().props.onClick());
    assert.deepEqual(h.decisions, [{ revision: 3, previewDigest: "preview:3", decision: "apply" }]);
  } finally { await act(async () => h.renderer.unmount()); }
});

test("a poll arriving before its automatic preview response preserves typing and must match before rebasing", async () => {
  for (const ownResponse of [true, false]) {
    let finish!: () => void;
    const h = await mountCompactScalar({ preview: input => new Promise(resolve => { finish = () => resolve(scalarPreview(input)); }) });
    try {
      await act(async () => h.input().props.onChange({ target: { value: "92" } }));
      await act(waitForCompactPreview);
      await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
      const polled = scalarPreview(h.previews[0]!);
      await act(async () => h.replace(ownResponse ? polled : { ...polled, revision: 4, previewDigest: "external" }));
      assert.equal(h.input().props.value, "92000"); assert.equal(h.input().props.disabled, false);
      assert.equal(h.confirm().props.disabled, true);
      await act(async () => h.input().props.onChange({ target: { value: "93000" } }));
      await act(async () => finish());
      assert.equal(h.input().props.value, "93000"); assert.equal(h.confirm().props.disabled, true);
      await act(waitForCompactPreview);
      assert.equal(h.previews.length, ownResponse ? 2 : 1);
      if (ownResponse) {
        assert.equal(h.previews[1]!.expectedRevision, 2); assert.equal(h.previews[1]!.values.runnerExecTimeoutMs, 93000);
        await act(async () => finish());
        assert.equal(h.confirm().props.disabled, false);
      } else {
        assert.equal(h.updates.length, 0);
        assert.match(JSON.stringify(h.renderer.toJSON()), /Refresh status before retrying/);
      }
      assert.equal(h.decisions.length, 0);
    } finally { await act(async () => h.renderer.unmount()); }
  }
});

test("queued automatic drafts respect IME and incomplete numbers after the first response", async () => {
  let finish!: () => void;
  const h = await mountCompactScalar({ preview: input => new Promise(resolve => { finish = () => resolve(scalarPreview(input)); }) });
  try {
    await act(async () => h.input().props.onChange({ target: { value: "92" } }));
    await act(waitForCompactPreview);
    await act(async () => {
      h.renderer.root.findByType("form").props.onCompositionStartCapture();
      h.input().props.onChange({ target: { value: "92000" } });
    });
    await act(async () => finish());
    await act(waitForCompactPreview);
    assert.equal(h.previews.length, 1); assert.equal(h.input().props.value, "92000");
    await act(async () => {
      h.renderer.root.findByType("form").props.onCompositionEndCapture();
      h.input().props.onChange({ target: { value: "" } });
    });
    await act(waitForCompactPreview); assert.equal(h.previews.length, 1);
    await act(async () => h.input().props.onChange({ target: { value: "93000" } }));
    await act(waitForCompactPreview);
    assert.equal(h.previews.length, 2); assert.equal(h.previews[1]!.expectedRevision, 2);
    assert.equal(h.previews[1]!.values.runnerExecTimeoutMs, 93000);
    await act(async () => finish());
  } finally { await act(async () => h.renderer.unmount()); }
});

test("a failed in-flight preview preserves newer typing without automatically retrying the queued draft", async () => {
  const { ApiRequestError } = await import("../src/api/client.js");
  let fail!: () => void;
  const h = await mountCompactScalar({ preview: () => new Promise((_, reject) => { fail = () => reject(new ApiRequestError("private", 400)); }) });
  try {
    await act(async () => h.input().props.onChange({ target: { value: "92" } }));
    await act(waitForCompactPreview);
    await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
    await act(async () => fail());
    await act(waitForCompactPreview); await act(waitForCompactPreview);
    assert.equal(h.previews.length, 1); assert.equal(h.input().props.value, "92000");
    assert.equal(h.confirm().props.disabled, true); assert.equal(h.decisions.length, 0);
  } finally { await act(async () => h.renderer.unmount()); }
});

test("automatic-preview capability never unlocks inputs during Apply or query operations", async () => {
  for (const operation of ["apply", "query"] as const) {
    const { ApiRequestError } = await import("../src/api/client.js");
    let finish!: () => void;
    const wait = () => new Promise<ConfigurationRequestView>(resolve => { finish = () => resolve(timeoutRequest()); });
    const h = await mountCompactScalar(operation === "apply" ? { decide: wait } : {
      preview: async () => { throw new ApiRequestError("private", 500); }, query: wait,
    });
    try {
      if (operation === "apply") await act(async () => h.confirm().props.onClick());
      else {
        await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
        await act(waitForCompactPreview);
        await act(async () => h.renderer.root.findAllByType("button").find(button => button.children.includes("Refresh current state"))!.props.onClick());
      }
      const value = h.input().props.value;
      assert.equal(h.input().props.disabled, true);
      await act(async () => h.input().props.onChange({ target: { value: "93000" } }));
      assert.equal(h.input().props.value, value);
      await act(async () => finish());
    } finally { await act(async () => h.renderer.unmount()); }
  }
});

test("a no-change poll cannot remove the focused scalar editor before its own preview responds", async () => {
  const finish: Array<() => void> = [];
  let first!: ConfigurationRequestView;
  const h = await mountCompactScalar({ classify: true, preview: input => new Promise(resolve => {
    const next = input.values.runnerExecTimeoutMs === 0
      ? { ...scalarPreview(input), changes: [], state: "collecting_input", allowedActions: ["preview", "dismiss"] } as ConfigurationRequestView
      : scalarPreview(input);
    if (!first) first = next;
    finish.push(() => resolve(next));
  }) });
  try {
    const input = h.input();
    await act(async () => h.input().props.onChange({ target: { value: "0" } }));
    await act(waitForCompactPreview);
    await act(async () => h.input().props.onChange({ target: { value: "92000" } }));
    await act(async () => h.replace(first));
    assert.equal(h.input(), input); assert.equal(h.input().props.disabled, false);
    assert.equal(h.input().props.value, "92000"); assert.equal(h.confirm().props.disabled, true);
    assert.doesNotMatch(JSON.stringify(h.renderer.toJSON()), /Not supported here yet/g);
    await act(async () => h.input().props.onChange({ target: { value: "93000" } }));
    await act(async () => finish[0]!());
    assert.equal(h.input(), input); assert.equal(h.input().props.value, "93000");
    assert.equal(h.confirm().props.disabled, true);
    await act(waitForCompactPreview);
    assert.equal(h.previews.length, 2); assert.equal(h.previews[1]!.expectedRevision, 2);
    assert.equal(h.previews[1]!.values.runnerExecTimeoutMs, 93000);
    await act(async () => finish[1]!());
    assert.equal(h.input().props.value, "93000"); assert.equal(h.confirm().props.disabled, false);
    assert.equal(h.decisions.length, 0);
  } finally { await act(async () => h.renderer.unmount()); }
});


test("compact rejects long risks, exact targets, unknown schemas and external verification without hiding them", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const security = request({ capabilityId: "security.default_approval" as never, scope: { kind: "global" },
    fields: [{ id: "defaultApprovalMode", label: "Default approval", kind: "enum", required: true, value: "always_allow", choices: [{ id: "always_allow", label: "Always allow" }] }],
    changes: [{ field: "defaultApprovalMode", after: "always_allow" }],
    ...{ securityConsent: { revision: 1, targetDigest: "exact-target", status: "required", statement: "New sessions only; existing sessions and pending tools stay unchanged." } } });
  assert.deepEqual(desktopConfigurationPresentation(security), {});
  for (const extra of [
    { securityConsent: { ...(security as unknown as { securityConsent: Record<string, unknown> }).securityConsent, statement: "Long security consequence. ".repeat(20) } },
    { securityConsent: { ...(security as unknown as { securityConsent: Record<string, unknown> }).securityConsent, revision: 2 } },
    { scope: { kind: "session", id: "session" } }, { adapterVersion: 2 },
    { fields: [...security.fields, { id: "futurePermission", label: "Other", kind: "boolean", value: true }] },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...security, ...extra } as ConfigurationRequestView), { unsupported: true });
  const longRisk = request({ ...security, ...{ securityConsent: { ...(security as unknown as { securityConsent: Record<string, unknown> }).securityConsent, statement: "Long security consequence. ".repeat(20) } } });
  const html = render({ request: longRisk });
  assert.doesNotMatch(html, /Long security consequence|<details|<input|<select|>Confirm</);
  assert.match(html, /Not supported here yet/);
  assert.deepEqual(desktopConfigurationPresentation({ ...timeoutRequest(), verificationPlan: { targets: ["https://example.test"], actions: ["connect"], maxRequests: 1, mayCharge: true } }), { settingsGroup: "timeouts" });
});

test("compact security shows the exact server statement once and keeps independent revision-bound approval", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  for (const locale of ["en", "zh"]) {
    const statement = locale === "en" ? "Future inheriting traffic, including credentials, uses this route." : "后续继承默认策略的流量（含凭据）使用此路由。";
    let current = request({ capabilityId: "proxy.default" as never, scope: { kind: "global" },
      fields: [{ id: "defaultPolicy", label: "Proxy", kind: "enum", required: true, value: "none", choices: [{ id: "none", label: "Direct" }] }],
      changes: [{ field: "defaultPolicy", after: "none" }], impact: { resourceLocation: "Proxy settings", effectiveScope: "All sessions", message: statement },
      ...{ securityConsent: { revision: 1, targetDigest: "exact-route", status: "required", statement } } });
    let tree!: ReactTestRenderer; const approvals: unknown[] = []; let decisions = 0;
    const props = { locale, compact: {}, ApiRequestError, ProcessRecord: ({ children }: { children: React.ReactNode }) => <div>{children}</div>,
      onUpdate(next: ConfigurationRequestView) { current = next; tree.update(<ConfigurationRequestCard {...props} request={current} />); },
      actions: { securityConsent: async (input: unknown) => { approvals.push(input); return { ...current, securityConsent: { ...(current as unknown as { securityConsent: Record<string, unknown> }).securityConsent, status: "confirmed" } }; },
        decide: async () => { decisions++; return { ...current, state: "applied" }; } } as never };
    const html = renderToStaticMarkup(<ConfigurationRequestCard {...props} request={current} />);
    assert.equal(html.split(statement).length - 1, 1);
    assert.doesNotMatch(html, /<details|configuration-more|independently confirmed|已独立确认/);
    assert.ok((html.match(/<p(?: |>|\b)/g) ?? []).length <= 3);
    await act(async () => { tree = create(<ConfigurationRequestCard {...props} request={current} />); });
    const button = (label: string) => tree.root.findAllByType("button").find(node => node.children.includes(label))!;
    const confirm = locale === "en" ? "Confirm" : "确认";
    const authorize = locale === "en" ? "Approve policy" : "授权此策略";
    assert.equal(button(confirm).props.disabled, true);
    assert.equal(button(authorize).props.disabled, true);
    await act(async () => tree.root.findByProps({ type: "checkbox" }).props.onChange({ target: { checked: true } }));
    assert.equal(decisions, 0); assert.equal(button(confirm).props.disabled, true);
    await act(async () => button(authorize).props.onClick());
    assert.deepEqual(approvals, [{ revision: 1, targetDigest: "exact-route", acknowledged: true }]);
    assert.equal(decisions, 0); assert.equal(button(confirm).props.disabled, false);
    await act(async () => tree.unmount());
  }
});


test("compact failure states never restore long backend prose", () => {
  setLanguage("en");
  for (const state of ["stale", "needs_fix"] as const) {
    const html = render({ request: request({ state, error: { code: "VALIDATION_FAILED", message: "Long backend paragraph. ".repeat(100) } }) });
    assert.doesNotMatch(html, /Long backend paragraph|<details/);
    assert.match(html, /Refresh status before retrying/);
    assert.ok((html.match(/<p(?: |>|\b)/g) ?? []).length <= 3);
  }
});


test("an unsupported compact request still exposes an existing server countdown and cancellation", () => {
  setLanguage("en");
  const html = render({ request: request({ autoApplyAt: new Date(Date.now() + 60_000).toISOString() }) });
  assert.match(html, /configuration-auto-apply/);
  assert.match(html, />Cancel<\/button>/);
  assert.doesNotMatch(html, /<details|>Confirm<|<select/);
});


test("model metadata has no original settings fallback for any field", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  for (const field of ["name", "vision", "contextWindow", "maxOutputTokens"]) {
    const view = request({ capabilityId: "model.metadata" as never, scope: { kind: "global" }, fields: [
      { id: "modelId", label: "Model", kind: "enum", required: true, value: "profile", choices: [{ id: "profile", label: "Long target ".repeat(20) }] },
      { id: field, label: field, kind: "text", required: false, value: "new" },
    ], changes: [{ field, before: "old", after: "new" }] });
    assert.deepEqual(desktopConfigurationPresentation(view), { unsupported: true });
  }
});


test("compact navigation candidates keep existing scheduled actions visible and cancellable", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  setLanguage("en");
  for (const view of [timeoutRequest(), request({ capabilityId: "model.connect", fields: [], changes: [] })]) {
    const scheduled = { ...view, autoApplyAt: new Date(Date.now() + 60_000).toISOString() };
    assert.deepEqual(desktopConfigurationPresentation(scheduled), { unsupported: true });
    const html = render({ request: scheduled });
    assert.match(html, /configuration-auto-apply/);
    assert.match(html, />Cancel<\/button>/);
    assert.doesNotMatch(html, />Open settings<|<details/);
  }
});

test("compact action styles are content-width and right-aligned without changing original settings", () => {
  const css = readFileSync(new URL("../src/styles/configuration.css", import.meta.url), "utf8");
  const compact = css.slice(css.indexOf("/* Conversation-only density."));
  assert.match(compact, /configuration-request-compact \{ gap: 8px; padding: 10px 12px; \}/);
  assert.match(compact, /conversation-configuration-actions > button \{\s*flex: 0 0 auto;\s*width: auto;\s*min-height: 32px;/);
  assert.match(compact, /conversation-configuration-actions \{\s*justify-content: flex-end;/);
  assert.match(compact, /@media \(pointer: coarse\)/);
  assert.match(compact, /min-height: 44px/);
  assert.doesNotMatch(compact, /flex: 1 1/);
});


test("desktop memory receipt uses localized memory states without the Reviewer label", () => {
  const previousLanguage = getLanguage();
  try {
    for (const locale of ["en", "zh-CN"]) {
      setLanguage(locale);
      const html = render({ request: request({ capabilityId: "memory.enable", state: "applied", fields: [],
        scope: { kind: "global" }, activation: { mode: "next_request", state: "needs_user_action" },
        changes: [{ field: "enabled", before: "Disabled", after: "Enabled" }], allowedActions: ["query"] }) });
      if (locale === "zh-CN") {
        assert.match(html, /启用本地工作台记忆图谱/); assert.match(html, /已停用/); assert.match(html, /已启用/);
        assert.doesNotMatch(html, /Disabled|Enabled|启用全局审阅专家/);
      } else {
        assert.match(html, /Enable local workbench memory graph/); assert.match(html, /Disabled/); assert.match(html, /Enabled/);
        assert.doesNotMatch(html, /Enable global Reviewer Specialist/);
      }
      assert.doesNotMatch(html, /<strong>enabled<\/strong>/);
    }
  } finally { setLanguage(previousLanguage); }
});


test("settings navigation keeps a pending confirmation card across remount and isolates revisions", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const previousLanguage = getLanguage();
  const stored = new Map<string, string>();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, value: {
    getItem: (key: string) => stored.get(key) ?? null, setItem: (key: string, value: string) => stored.set(key, value),
  } });
  let renderer: ReactTestRenderer | undefined;
  let view = request({ id: "settings-marker", capabilityId: "model.connect", fields: [] });
  const calls: unknown[] = [];
  const draw = () => <Conversation client={new ApiClient("test")} loading={false} run={emptyRunStream()}
    detail={{ id: view.sessionId, messages: [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
    onOpenConfigurationSettings={(...args) => calls.push(args)}
    configuration={{ requests: [view], legacyRequests: [], loading: false, error: false, refresh: async () => {},
      update: () => { throw new Error("Navigation must not mutate"); }, remove: () => { throw new Error("Navigation must not remove the card"); } }} />;
  try {
    setLanguage("en");
    await act(async () => { renderer = create(draw()); });
    await act(async () => { renderer!.root.findAllByType("button").find(b => b.children.includes("Open settings"))!.props.onClick(); });
    assert.deepEqual(calls, [["models"]]);
    assert.match(JSON.stringify(renderer!.toJSON()), /Have you finished changing these settings/);
    assert.equal(renderer!.root.findAllByType("details").length, 0);
    assert.equal(renderer!.root.findAllByType("button").length, 2);
    assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Saved|Confirmed/);
    assert.equal(view.state, "awaiting_confirmation");
    await act(async () => { renderer!.unmount(); renderer = create(draw()); });
    assert.match(JSON.stringify(renderer!.toJSON()), /Have you finished changing these settings/);
    await act(async () => { setLanguage("zh-CN"); });
    assert.match(JSON.stringify(renderer!.toJSON()), /是否已完成修改/);
    assert.match(JSON.stringify(renderer!.toJSON()), /模型设置/);
    for (const change of [{ id: "different-request" }, { sessionId: "different-session" }, { revision: 2 }, { capabilityId: "mcp.header_credential" }]) {
      view = request({ id: "settings-marker", capabilityId: "model.connect", fields: [], ...change } as Partial<ConfigurationRequestView>);
      await act(async () => { renderer!.update(draw()); });
      assert.ok(!JSON.stringify(renderer!.toJSON()).includes("是否已完成修改"));
    }
    assert.equal(stored.size, 1);
    assert.equal([...stored.values()][0], "1");
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    setLanguage(previousLanguage);
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("blocked storage does not block settings navigation and a failed open is not recorded", async () => {
  const previousStorage = Object.getOwnPropertyDescriptor(globalThis, "sessionStorage");
  const previousLanguage = getLanguage();
  Object.defineProperty(globalThis, "sessionStorage", { configurable: true, get: () => { throw new Error("Storage unavailable"); } });
  let renderer: ReactTestRenderer | undefined;
  let fail = true;
  try {
    setLanguage("en");
    await act(async () => { renderer = create(<Conversation client={new ApiClient("test")} loading={false} run={emptyRunStream()}
      detail={{ id: "session", messages: [] } as never} replays={[]} workspaceFiles={[]} onDecidePermission={async () => {}}
      onOpenConfigurationSettings={() => { if (fail) throw new Error("Open failed"); }}
      configuration={{ requests: [request({ capabilityId: "model.connect", fields: [] })], legacyRequests: [], loading: false,
        error: false, refresh: async () => {}, update: () => { throw new Error("Navigation must not mutate"); }, remove: () => {} }} />); });
    const open = () => renderer!.root.findAllByType("button").find(b => b.children.includes("Open settings"))!;
    assert.throws(() => open().props.onClick(), /Open failed/);
    assert.ok(!JSON.stringify(renderer!.toJSON()).includes("Settings opened"));
    fail = false;
    await act(async () => { open().props.onClick(); });
    assert.match(JSON.stringify(renderer!.toJSON()), /Have you finished changing these settings/);
  } finally {
    if (renderer) await act(async () => { renderer!.unmount(); });
    setLanguage(previousLanguage);
    if (previousStorage) Object.defineProperty(globalThis, "sessionStorage", previousStorage);
    else Reflect.deleteProperty(globalThis, "sessionStorage");
  }
});

test("Chinese proxy resource cards and saved receipts translate exact impact without changing warnings", () => {
  const impact = { resourceLocation: "Shared proxy registry", effectiveScope: "Every session using this proxy",
    message: "Manual confirmation required. Creating a proxy does not select a route. Editing a used proxy affects later connections, possibly within an active run. Existing connections are not rebound. URL syntax is checked without connecting; reachability and proxy authentication remain unverified." };
  const proxy = request({ capabilityId: "proxy.resources", scope: { kind: "global" },
    fields: [
      { id: "operation", kind: "enum", label: "Operation", required: true, value: "update", choices: [{ id: "update", label: "update" }] },
      { id: "proxyId", kind: "enum", label: "Existing proxy resource", required: true, value: "proxy", choices: [{ id: "proxy", label: "Research proxy" }] },
      { id: "name", kind: "text", label: "Proxy name", required: true, value: "New name" },
      { id: "kind", kind: "enum", label: "Proxy type", required: true, value: "custom_url", choices: [{ id: "custom_url", label: "custom_url" }] },
      { id: "replaceUrl", kind: "boolean", label: "Replace stored proxy URL", required: false, value: false },
    ], changes: [{ field: "name", before: "Old name", after: "New name" }], impact, activation: { mode: "next_connection", state: "needs_user_action" } });
  const previous = getLanguage();
  try {
    setLanguage("zh-CN");
    assert.match(render({ request: proxy }), /所有使用此代理的会话/);
    const receipt = render({ request: { ...proxy, state: "applied", allowedActions: ["query"] } });
    assert.match(receipt, /共享代理注册表/);
    assert.match(receipt, /需要手动确认/);
    assert.match(receipt, /尚未验证可达性和代理认证/);
    assert.doesNotMatch(receipt, /Every session using this proxy|Manual confirmation required/);
    setLanguage("en");
    assert.match(render({ request: proxy }), /Every session using this proxy/);
  } finally { setLanguage(previous); }
});

// Fixed v1 strings captured from the registered #770/#773 adapter previews.
const memoryToggleImpact = "Local backend only; manual confirmation required. Enabling permits subsequent research-memory operations to use the existing local graph. Disabling stops subsequent gated operations; in-flight requests may finish and stored graph data is retained. This does not disable every Agent's independent memory, change backend or credentials, install a service or verify readiness. If the MemoryGraph service is unavailable, start it separately and restart the API if required by the deployment; saving does not start or restart services.";
const mcpToggleImpact = "This shared service switch requires its own manual confirmation. It does not select the connector for a Session or grant tool, network or command permissions. Review the server's saved connection/execution settings before enabling it. Saving starts no discovery, connection, STDIO process or OAuth flow. Later ordinary discovery/use may contact its stored endpoint or launch its stored STDIO program. An untested service is not verified ready. Disabling rejects subsequent calls; it does not immediately cancel already sent work, but a later catalog refresh may close its old connection and interrupt that work. Re-enabling never replays an old task/tool. Run records stay unchanged; a bound original configuration wait may continue normally.";
function realToggle(capability: "memory.enable" | "mcp.availability", enabled: boolean): ConfigurationRequestView {
  const mcp = capability === "mcp.availability", serverId = "custom-000000000abc";
  return request({ capabilityId: capability as never, scope: { kind: "global" },
    fields: [...(mcp ? [{ id: "serverId", kind: "enum" as const, label: "Existing custom MCP server", required: true, value: serverId,
      choices: [{ id: serverId, label: `arXiv · http · ${serverId}` }] }] : []),
      { id: "enabled", kind: "boolean", label: mcp ? "Available globally" : "Enable local workbench memory graph", required: true, value: enabled }],
    changes: [{ field: "enabled", before: mcp ? String(!enabled) : enabled ? "Disabled" : "Enabled", after: mcp ? String(enabled) : enabled ? "Enabled" : "Disabled" }],
    impact: { resourceLocation: mcp ? "Encrypted custom MCP configuration" : "Deployment MemoryGraph settings",
      effectiveScope: mcp ? "Shared MCP availability across all Sessions · http" : "Every session using the workbench memory graph",
      message: mcp ? mcpToggleImpact : memoryToggleImpact },
    activation: { mode: (mcp ? "next_invocation" : "next_request") as never, state: "not_requested" },
  });
}
test("real MemoryGraph and global MCP previews show short bilingual explicit confirmation cards", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const previous = getLanguage();
  try {
    for (const language of ["en", "zh-CN"]) for (const capability of ["memory.enable", "mcp.availability"] as const) for (const enabled of [true, false]) {
      setLanguage(language);
      const view = realToggle(capability, enabled), html = render({ request: view });
      assert.equal(desktopConfigurationPresentation(view).unsupported, undefined);
      assert.match(html, /type="checkbox"/);
      assert.match(html, language === "en" ? /Confirm/ : /确认/);
      assert.ok(!html.includes(view.impact.message), "registered full prose must not return on the short pending card");
      assert.doesNotMatch(html, /configuration-diff|configuration-more|<details|Open settings|next_invocation/);
      if (capability === "memory.enable") assert.match(html, language === "en" ? /Agent memory/ : /Agent 独立记忆/);
      else {
        assert.match(html, language === "en" ? /Session choice unchanged/ : /会话选择不变/);
        assert.match(html, language === "en" ? enabled ? /Permissions apply/ : /interrupt it/ : enabled ? /权限独立/ : /中断任务/);
        assert.equal((html.match(/arXiv · http · custom-000000000abc/g) ?? []).length, 1);
      }
      const receipt = render({ request: { ...view, state: "applied", allowedActions: ["query"] } });
      assert.match(receipt, /desktop-configuration-record/);
      const fullWarning = memoryConfigurationCopy(view, language).message;
      assert.ok(receipt.includes(fullWarning.replaceAll("'", "&#x27;")), "saved receipt retains the full localized warning");
      if (capability === "memory.enable" && language === "zh-CN") {
        assert.match(receipt, /正在进行的请求可能完成，已存储的图谱数据会保留/);
        assert.match(receipt, /保存配置不会启动或重启服务/);
      }
    }
  } finally { setLanguage(previous); }
});
test("toggle summaries do not conceal unknown warnings, additional inputs or changed protocol", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  for (const capability of ["memory.enable", "mcp.availability"] as const) {
    const view = realToggle(capability, true);
    for (const patch of [
      { impact: { ...view.impact, message: `${view.impact.message} NEW RISK` } },
      { impact: { ...view.impact, resourceLocation: "Another registry" } },
      { impact: { ...view.impact, effectiveScope: "Changed scope" } },
      { adapterVersion: 2 }, { schemaVersion: 2 }, { scope: { kind: "session", id: "session" } },
      { fields: [...view.fields, { id: "extra", kind: "boolean", label: "Extra", value: true }] },
      { fields: view.fields.map(field => field.id === "enabled" ? { ...field, value: "true" } : field) },
      { changes: [] }, { changes: [{ field: "enabled", before: "unknown", after: "true" }] },
      { autoApplyAt: "2026-11-09T00:00:01Z" },
      { verificationPlan: { targets: [], actions: ["connect"], maxRequests: 1, mayCharge: false } },
    ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...patch } as ConfigurationRequestView), { unsupported: true });
  }
});
test("known toggle summary follows pending edits without applying or changing the server warning", async () => {
  const { configurationCompactToggleCopy } = await import("@sciencediscovery/configuration-ui");
  const view = realToggle("mcp.availability", true), before = JSON.stringify(view);
  assert.match(configurationCompactToggleCopy(view, "en", false)!.description, /interrupt it/);
  assert.match(configurationCompactToggleCopy(view, "en", true)!.description, /Permissions apply/);
  assert.equal(JSON.stringify(view), before);
});
test("proven Session connector addition shows its chosen target rather than the full unchanged list", () => {
  const view = request({ capabilityId: "connector.enable", fields: [{ id: "connectorId", kind: "enum", label: "Connector", required: true,
    value: "custom-000000000abc", choices: [{ id: "custom-000000000abc", label: "arXiv" }] }],
    changes: [{ field: "enabledConnectorIds", before: "custom-000000000001, custom-000000000002, custom-000000000003", after: "custom-000000000001, custom-000000000002, custom-000000000003, custom-000000000abc" }],
    impact: { resourceLocation: "Session settings", effectiveScope: "This session only", message: "Other sessions stay unchanged. Tool calls retain their own approval policy." },
  });
  setLanguage("en");
  const html = render({ request: view });
  assert.match(html, /arXiv|Confirm/);
  assert.doesNotMatch(html, /configuration-diff|custom-000000000001|custom-000000000002/);
  assert.equal(view.changes[0]!.after!.length, 82);
});

const connectorAdditions = JSON.parse(readFileSync(new URL("../../../test/fixtures/configuration-connector-summarized-addition.json", import.meta.url), "utf8")) as Array<{ kind: string; view: ConfigurationRequestView }>;
test("a Session with more than ten enabled connectors still confirms its addition instead of only refusing it", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  // The API integration test produces and verifies this view through a real
  // proposal: eleven enabled connectors plus the requested UniProt connector,
  // so the adapter summarizes both sides of the diff (#1100).
  assert.deepEqual(connectorAdditions.map(fixture => fixture.kind), ["summarizedAddition"]);
  const view = connectorAdditions[0]!.view;
  const previous = getLanguage();
  try {
    for (const language of ["en", "zh-CN"]) {
      setLanguage(language);
      assert.deepEqual(desktopConfigurationPresentation(view), { connectorAddition: true, targetLabel: "uniprot" });
      const html = render({ request: view });
      assert.match(html, /uniprot/);
      assert.match(html, language === "en" ? /Confirm/ : /确认/);
      assert.doesNotMatch(html, /Not supported here yet|暂不支持/);
      assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>(Confirm|确认)/);
      assert.doesNotMatch(html, /11 connectors|12 connectors/);
      const saved = render({ request: { ...view, state: "applied", allowedActions: ["query"] } });
      assert.match(saved, /desktop-configuration-record/);
    }
  } finally { setLanguage(previous); }
});

// The API test produces and verifies these complete views through real
// previewReversal/preview/apply. No fake V3 options or restoration values.
const connectorReversals = JSON.parse(readFileSync(new URL("../../../test/fixtures/configuration-connector-reversal.json", import.meta.url), "utf8")) as Array<{ kind: string; view: ConfigurationRequestView }>;
test("real connector reversal projections retain a short locked confirmation and accurate receipt", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const previous = getLanguage();
  try {
    for (const language of ["en", "zh-CN"]) for (const fixture of connectorReversals) {
      setLanguage(language);
      assert.deepEqual(desktopConfigurationPresentation(fixture.view), { fieldIds: [], connectorRestoration: true, targetLabel: "pubmed" });
      const html = render({ request: fixture.view });
      assert.match(html, /uniprot, pubmed/);
      assert.match(html, language === "en" ? /Restore connector selection/ : /恢复连接器选择/);
      assert.match(html, language === "en" ? /Confirm/ : /确认/);
      assert.doesNotMatch(html, /<select|name="connectorId"|restoreConnectorIds|restoreInheritance/);
      if (fixture.kind === "restoreInheritance") assert.match(html, language === "en" ? /Inherit parent selection/ : /继承上级选择/);
      assert.doesNotMatch(html, /<button[^>]*disabled=""[^>]*>(Confirm|确认)/);
      const saved = render({ request: { ...fixture.view, state: "applied", allowedActions: ["query"] } });
      assert.match(saved, /desktop-configuration-record/);
      assert.match(saved, language === "en" ? /Restore connector selection/ : /恢复连接器选择/);
    }
  } finally { setLanguage(previous); }
});
test("connector reversal confirmation sends only its bound revision/digest, without a destructive re-preview", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const { ApiRequestError } = await import("../src/api/client.js");
  for (const { view } of connectorReversals) {
    const decisions: unknown[] = [];
    let renderer: ReactTestRenderer | undefined;
    try {
      await act(async () => { renderer = create(<ConfigurationRequestCard request={view} compact={desktopConfigurationPresentation(view)}
        locale="en" ProcessRecord={({ children }) => <div>{children}</div>} ApiRequestError={ApiRequestError} onUpdate={() => {}}
        actions={{ preview: async () => { assert.fail("locked reversal must retain server-only restoration input"); },
          decide: async (input: unknown) => { decisions.push(input); return { ...view, state: "applied" }; } } as never} />); });
      assert.equal(decisions.length, 0);
      assert.equal(renderer!.root.findAllByType("select").length, 0);
      const confirm = renderer!.root.findAllByType("button").find(button => button.children.join("") === "Confirm")!;
      assert.equal(confirm.props.disabled, false);
      await act(async () => { await confirm.props.onClick(); });
      assert.deepEqual(decisions, [{ revision: view.revision, previewDigest: view.previewDigest, decision: "apply", selectedOptionId: "persist" }]);
    } finally { if (renderer) await act(async () => renderer!.unmount()); }
  }
});
test("connector restorations retain unknown warnings and reject incomplete or oversized diffs", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const view = connectorReversals[0]!.view;
  setLanguage("en");
  assert.match(render({ request: { ...view, impact: { ...view.impact, message: "Additional warning" } } }), /Additional warning/);
  for (const change of [
    { field: "enabledConnectorIds", before: "12 connectors: pubmed …", after: "Inherit parent settings" },
    { field: "enabledConnectorIds", before: "custom-000000000001, custom-000000000002, custom-000000000003, pubmed", after: "Inherit parent settings" },
    { field: "enabledConnectorIds", before: "pubmed, uniprot", after: "arxiv" },
  ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, changes: [change] }), { unsupported: true });
});

test("real MCP destructive proposals navigate without weakening contract checks", async () => {
  const { desktopConfigurationPresentation } = await import("../src/app/configuration-presentation.js");
  const { readFile } = await import("node:fs/promises");
  // Full framework proposals from PR #773; only generated identities are normalized.
  const fixtures = JSON.parse(await readFile(new URL("../../../test/fixtures/configuration-mcp-destructive-navigation.json", import.meta.url), "utf8")) as {
    cases: Array<{ kind: string; view: ConfigurationRequestView }>;
  };
  assert.deepEqual(fixtures.cases.map(fixture => fixture.kind), ["deleteCollecting", "deleteReady", "headerReady", "envReady"]);
  for (const { kind, view } of fixtures.cases) {
    assert.deepEqual(desktopConfigurationPresentation(view), { settingsGroup: "mcp" }, kind);
    const invalid: Partial<ConfigurationRequestView>[] = [
      { schemaVersion: 2 }, { adapterVersion: 2 }, { scope: { kind: "session", id: "session" } },
      { previewDigest: undefined }, { previewDigest: "" }, { state: "needs_fix" }, { state: "stale" },
      { activation: { mode: "next_run", state: "not_requested" } },
      { fields: view.fields.map(field => field.id === "serverId" ? { ...field, choices: [] } : field) },
      { fields: view.fields.map(field => field.id === "serverId" && field.kind === "enum" ? { ...field, value: "arxiv", choices: [{ id: "arxiv", label: "arXiv" }] } : field) },
      { fields: [...view.fields, { id: "secret", kind: "credential", label: "Secret", required: true, status: "missing" }] },
      { fields: [view.fields[0]!, view.fields[0]!] },
      { fields: view.fields.map(field => ({ ...field, required: false })) },
      { changes: [{ field: "unexpected", after: "Removed" }] },
      { changes: [...view.changes, { field: "serverId", after: "Deleted" }] },
      { verificationPlan: { targets: ["target"], actions: ["connect"], maxRequests: 1, mayCharge: false } },
      { verificationPlan: { targets: [], actions: [], maxRequests: 0, mayCharge: true } },
      { autoApplyAt: "2099-01-01T00:00:00Z" },
      { allowedActions: [] }, { allowedActions: ["query"] }, { allowedActions: ["preview"] },
      { allowedActions: ["preview", "preview", "dismiss"] },
      { allowedActions: [...view.allowedActions, "continue"] },
      { allowedActions: ["query"], error: { code: "CONFIGURATION_BACKEND_UNAVAILABLE", message: "Backend unavailable" } },
      { error: { code: "CONFIGURATION_BACKEND_UNAVAILABLE", message: "Backend unavailable" } },
      { protocolVersion: undefined }, { options: undefined }, { options: [] },
      { options: view.options!.filter(option => option.kind === "dismiss") },
      { selectedOptionId: undefined }, { selectedOptionId: "missing" }, { selectedOptionId: "dismiss" },
      { options: view.options!.map(option => ({ ...option, id: "persist" })) },
      { options: view.options!.map(option => option.kind === "persisted_apply" ? { ...option, available: false } : option) },
      { options: view.options!.map(option => option.kind === "persisted_apply" ? { ...option, kind: "run_overlay" } : option) },
    ];
    if (String(view.capabilityId) === "mcp.delete") {
      for (const value of [undefined, "true", view.state === "collecting_input"]) invalid.push({
        fields: view.fields.map(field => field.id === "confirmDelete" && field.kind === "boolean" ? { ...field, value } : field),
      });
    } else invalid.push({ changes: [] });
    for (const patch of invalid) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...patch }), { unsupported: true }, `${kind}: ${JSON.stringify(patch)}`);
    for (const patch of [
      { securityConsent: { revision: view.revision, status: "required", statement: "New consent" } },
      { endpointAuthorization: { endpointTarget: "https://example.test", host: "example.test", classification: "external", status: "required", revision: view.revision } },
    ]) assert.deepEqual(desktopConfigurationPresentation({ ...view, ...patch } as ConfigurationRequestView), { unsupported: true });
    let opened = 0, writes = 0;
    const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
    const { ApiRequestError } = await import("../src/api/client.js");
    let renderer: ReactTestRenderer | undefined;
    const before = JSON.stringify(view);
    try {
      const props = { request: view, locale: "en", compact: { onOpenSettings: () => { opened++; } },
        ProcessRecord: ({ label, children }: { label: React.ReactNode; children: React.ReactNode }) => <div>{label}{children}</div>,
        ApiRequestError, onUpdate: () => { writes++; },
        actions: { preview: async () => { writes++; return view; }, decide: async () => { writes++; return view; } } as never };
      await act(async () => { renderer = create(<ConfigurationRequestCard {...props} />); });
      assert.deepEqual(renderer!.root.findAllByType("button").map((button: { children: unknown[] }) => button.children), [["Open settings"]]);
      await act(async () => renderer!.root.findByType("button").props.onClick());
      assert.equal(opened, 1); assert.equal(writes, 0);
      assert.match(JSON.stringify(renderer!.toJSON()), /Have you finished changing these settings/);
      assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /Saved|Confirmed/);
      assert.equal(JSON.stringify(view), before, "navigation does not accept, mutate or resume the proposal");
      await act(async () => renderer!.update(<ConfigurationRequestCard {...props} request={{ ...view, revision: view.revision + 1 }} />));
      assert.match(JSON.stringify(renderer!.toJSON()), /Open settings/);
      assert.equal(writes, 0);
    } finally { if (renderer) await act(async () => renderer!.unmount()); }
  }
});

test("manual settings choices persist the concrete destination and self-reported outcome without applying", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  for (const completed of [true, false]) for (const locale of ["en", "zh-CN"]) {
    let renderer: ReactTestRenderer | undefined;
    const inputs: unknown[] = [];
    let current = request({ id: `manual-${locale}-${completed}`, capabilityId: "model.connect", fields: [] });
    const actions = {
      confirmSettings: async (input: { revision: number; stateVersion: number; destination: "models"; completed: boolean }) => {
        inputs.push(input);
        return { ...current, stateVersion: current.stateVersion + 1, state: "dismissed" as const,
          settingsConfirmation: { destination: input.destination, completed: input.completed, source: "user" as const,
            verified: false as const, configurationWritten: false as const, confirmedAt: "2026-11-10T10:00:00Z" },
          resumption: { state: "queued" as const }, allowedActions: [] };
      },
      decide: async () => { throw new Error("Manual settings confirmation must not apply or dismiss"); },
      preview: async () => { throw new Error("Manual settings confirmation must not preview"); },
    };
    const draw = () => <ConfigurationRequestCard request={current} locale={locale} ApiRequestError={ApiRequestError}
      compact={{ onOpenSettings: () => {}, settingsDestination: "models" }} actions={actions as never}
      ProcessRecord={({ label, children }) => <details><summary>{label}</summary>{children}</details>}
      onUpdate={next => { current = next; renderer!.update(draw()); }} />;
    try {
      await act(async () => { renderer = create(draw()); });
      await act(async () => renderer!.root.findByType("button").props.onClick());
      assert.equal(inputs.length, 0);
      assert.equal(renderer!.root.findAllByType("details").length, 0);
      const label = locale === "en" ? completed ? "Changed" : "Not changed" : completed ? "已完成修改" : "未完成修改";
      await act(async () => renderer!.root.findAllByType("button").find(button => button.children.includes(label))!.props.onClick());
      assert.deepEqual(inputs, [{ revision: 1, stateVersion: 1, destination: "models", completed }]);
      assert.equal(renderer!.root.findAllByType("details").length, 1);
      const summary = JSON.stringify(renderer!.root.findByType("summary").children);
      assert.match(summary, locale === "en" ? /Model settings/ : /模型设置/);
      assert.ok(summary.includes(label));
      assert.equal(renderer!.root.findByType("details").props.open, undefined);
      assert.equal(renderer!.root.findAllByType("button").length, 0);
      await act(async () => { renderer!.unmount(); renderer = create(draw()); });
      assert.equal(renderer!.root.findAllByType("details").length, 1, "server receipt survives remount without the tab marker");
    } finally { if (renderer) await act(async () => renderer!.unmount()); }
  }
});

test("manual settings confirmation failures remain pending and duplicate clicks cannot submit twice", async () => {
  const { ConfigurationRequestCard } = await import("@sciencediscovery/configuration-ui");
  const { ApiRequestError } = await import("../src/api/client.js");
  let renderer: ReactTestRenderer | undefined;
  const view = request({ id: "manual-error", capabilityId: "model.connect", fields: [] });
  let calls = 0, reject!: (error: Error) => void;
  try {
    await act(async () => { renderer = create(<ConfigurationRequestCard request={view} locale="en" ApiRequestError={ApiRequestError}
      compact={{ onOpenSettings: () => {}, settingsDestination: "models" }}
      actions={{ confirmSettings: () => { calls++; return new Promise((_resolve, no) => { reject = no; }); } } as never}
      ProcessRecord={({ label }) => <details>{label}</details>} onUpdate={() => { throw new Error("Failed operation cannot settle"); }} />); });
    await act(async () => renderer!.root.findByType("button").props.onClick());
    const yes = renderer!.root.findAllByType("button").find(button => button.children.includes("Changed"))!;
    await act(async () => { yes.props.onClick(); yes.props.onClick(); });
    assert.equal(calls, 1);
    assert.ok(renderer!.root.findAllByType("button").every(button => button.props.disabled));
    await act(async () => reject(new ApiRequestError("private details", 409)));
    assert.equal(renderer!.root.findAllByType("details").length, 0);
    assert.match(JSON.stringify(renderer!.toJSON()), /Have you finished changing these settings/);
    assert.doesNotMatch(JSON.stringify(renderer!.toJSON()), /private details/);
    assert.equal(renderer!.root.findAllByProps({ role: "alert" }).length, 1);
  } finally { if (renderer) await act(async () => renderer!.unmount()); }
});
