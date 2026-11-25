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


import type { PermissionDecision, PermissionGrant, PermissionRequest } from "@sciencediscovery/schema";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";

import { PermissionCards, PermissionGrantManager } from "../src/Permissions.js";
import { permissionMatchingKey } from "../src/PermissionDecisionActions.js";
import { LocaleProvider } from "../src/i18n/index.js";
import { activityCardId } from "../src/session/run-activity.js";

const noopToggle = () => undefined;

const SANDBOX_NETWORK_HINT = "Applies only to the listed hosts on this Runner for the current agent run: they are added to the allowed domains of the executions that use the grant. Other hosts still ask, and the global sandbox network setting is unchanged.";

function networkRequest(): PermissionRequest {
  return { action: "sandbox_network", createdAt: "2026-10-18T00:00:00.000Z", id: "request-network",
    projectId: "project-1", resource: `sandbox-network:${"a".repeat(64)}`, sessionId: "session-1", state: "pending",
    summary: "Sandbox network on local for this Agent run: eutils.ncbi.nlm.nih.gov:443. Purpose: Retrieve requested PubMed records." };
}

test("allow-matching UI groups the same permission resources as the backend", () => {
  const request = {
    action: "artifact_download" as const,
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-download",
    resource: "pubmed:download:first.pdf",
    sessionId: "session-1",
    state: "pending" as const,
    summary: "Download first.pdf",
  };
  assert.equal(permissionMatchingKey(request), "artifact_download:pubmed:download");
  assert.equal(
    permissionMatchingKey({ ...request, id: "request-2", resource: "pubmed:download:second.pdf" }),
    permissionMatchingKey(request),
  );
  assert.notEqual(
    permissionMatchingKey({ ...request, id: "request-3", resource: "biorxiv:download:paper.pdf" }),
    permissionMatchingKey(request),
  );
});

test("pending permission details fold without hiding the decision buttons", () => {
  const request: PermissionRequest = {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    description: { kind: "python" },
    id: "request-1",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    busy: false,
    expandedCards: {},
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.match(html, /Permission required/);
  assert.match(html, /Run local code/);
  assert.match(html, /Run Python code in the Session workspace/, "the card composes the sentence from the structured description");
  assert.match(html, /aria-expanded="false"/);
  // Resource details fold, while pending decisions remain directly actionable.
  assert.doesNotMatch(html, /workspace-code/);
  assert.match(html, /Allow once/);
});

test("expanded permission card exposes the independent decisions", () => {
  const request: PermissionRequest = {
    action: "code",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "request-1",
    projectId: "project-1",
    resource: "workspace-code",
    sessionId: "session-1",
    state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    busy: false,
    expandedCards: { [activityCardId("permission", request.id)]: true },
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.match(html, /aria-expanded="true"/);
  assert.match(html, /workspace-code/);
  assert.match(html, /class="plan-actions permission-decision-actions"/);
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, /class="secondary-button"[^>]*>Allow once</);
  assert.match(html, /class="secondary-button"[^>]*>Allow same type</);
  assert.match(html, /class="danger-button"[^>]*>Deny</);
});

test("the approval sentence follows the reader's language, not the API's English", () => {
  const render = (request: PermissionRequest, locale: "en" | "zh-CN") =>
    renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale }, createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
    })));
  const shell: PermissionRequest = {
    action: "code", createdAt: "2026-10-18T00:00:00.000Z", description: { kind: "shell" },
    id: "request-shell", projectId: "project-1", resource: "workspace-code", sessionId: "session-1",
    state: "pending", summary: "Run a shell script in the Session workspace",
  };
  const chinese = render(shell, "zh-CN");
  assert.match(chinese, /在会话工作区中运行 Shell 脚本/);
  assert.doesNotMatch(chinese, /Run a shell script/);
  assert.match(render(shell, "en"), /Run a shell script in the Session workspace/);

  const direct: PermissionRequest = {
    ...shell,
    action: "direct_code",
    description: {
      account: "user:1000:1000", command: "printf hello\nrm -rf build", cwd: "", kind: "direct-host",
      runnerId: "local", target: "machine:instance", workspaceRoot: "/data/projects/session-1/workspace",
    },
    id: "request-direct",
    summary: "DIRECT HOST EXECUTION: Runner local, machine:instance",
  };
  const directChinese = render(direct, "zh-CN");
  assert.match(directChinese, /直接在主机上执行/);
  assert.match(directChinese, /不会隔离文件系统、进程或网络/);
  assert.match(directChinese, /命令：\nprintf hello\nrm -rf build/, "the command keeps its newlines");
  assert.doesNotMatch(directChinese, /DIRECT HOST EXECUTION/);
});

test("a request without a description gets a localized action instead of English prose", () => {
  const render = (request: PermissionRequest) => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: "zh-CN" },
    createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
    })));
  const legacy: PermissionRequest = {
    action: "connector", createdAt: "2026-10-18T00:00:00.000Z", id: "request-legacy", projectId: "project-1",
    resource: "pubmed:search:BRCA1", sessionId: "session-1", state: "pending", summary: "Query PubMed for BRCA1",
  };
  const html = render(legacy);
  assert.match(html, /请求：使用连接器/);
  assert.doesNotMatch(html, /Query PubMed for BRCA1/);
  assert.match(render({ ...legacy, description: { kind: "mcp-tool", sourceId: "pubmed", toolId: "search" } }), /调用 MCP 工具 pubmed\/search/);
});

test("the permission panel shows the command or arguments a tool approval would run", () => {
  const request: PermissionRequest = {
    action: "code", createdAt: "2026-10-18T00:00:00.000Z",
    description: { detail: '{"celsius": -40}', kind: "tool-call", toolName: "mcp__custom-1__to_kelvin" },
    id: "request-tool", projectId: "project-1", resource: "workspace-code", sessionId: "session-1",
    state: "pending", summary: 'mcp__custom-1__to_kelvin: {"celsius": -40}',
  };
  const render = (locale: "en" | "zh-CN") => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale },
    createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
    })));
  assert.match(render("zh-CN"), /在本会话中运行工具 mcp__custom-1__to_kelvin\n\{&quot;celsius&quot;: -40\}/);
  assert.match(render("en"), /Run tool mcp__custom-1__to_kelvin in this Session\n\{&quot;celsius&quot;: -40\}/);
});

test("permission cards hide decided requests", () => {
  const request: PermissionRequest = {
    action: "connector",
    createdAt: "2026-01-01T00:00:00.000Z",
    decidedAt: "2026-01-01T00:00:05.000Z",
    decision: "allowed",
    id: "request-1",
    projectId: "project-1",
    resource: "arxiv",
    sessionId: "session-1",
    state: "allowed",
    summary: "Query the arxiv connector",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {},
    onDecision: () => undefined,
    onToggleCard: noopToggle,
    requests: [request],
  }));
  assert.equal(html, "");
});

test("pending download approvals keep all actions while cancelled ones have no approval entry", () => {
  const request: PermissionRequest = {
    action: "artifact_download", createdAt: "2026-09-11T00:00:00.000Z",
    id: "download-approval", projectId: "project-1", sessionId: "session-1",
    resource: "arxiv:download:paper.pdf", summary: "Download paper.pdf", state: "pending",
  };
  const render = (state: PermissionRequest["state"]) => renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle,
    requests: [{ ...request, state }],
  }));
  const pending = render("pending");
  assert.match(pending, />Allow once<\/button>/);
  assert.match(pending, />Allow same type<\/button>/);
  assert.match(pending, />Deny<\/button>/);
  assert.equal(render("cancelled"), "");
});

test("standing grants are listable and revocable", () => {
  const grant: PermissionGrant = {
    action: "connector",
    createdAt: "2026-01-01T00:00:00.000Z",
    id: "grant-1",
    projectId: "project-1",
    resource: "pubmed",
    scope: "project",
    state: "active",
  };
  const html = renderToStaticMarkup(createElement(PermissionGrantManager, {
    grants: [grant],
    onRevoke: () => undefined,
  }));
  assert.match(html, /Standing permission grants/);
  assert.match(html, /pubmed · this Session/);
  assert.match(html, /Revoke/);
});

test("direct consent is visibly unsandboxed and retains exact command whitespace", () => {
  const request: PermissionRequest = { id: "direct", action: "direct_code", createdAt: "2026-01-01T00:00:00Z",
    description: { command: "printf 'a  b'", kind: "direct-host", runnerId: "machine", target: "machine",
      account: "user", workspaceRoot: "workspace", cwd: "" },
    resource: "direct:bound-scope", sessionId: "session", state: "pending",
    summary: "DIRECT HOST EXECUTION: machine, account user, cwd workspace. No isolation.\nprintf 'a  b'\n" };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => {}, onToggleCard: noopToggle, requests: [request],
  }));
  assert.match(html, /Execute directly on the host \(no sandbox\)/);
  assert.match(html, /white-space:pre-wrap/);
  assert.match(html, /a  b/);
  assert.match(html, /Allow once/);
  assert.match(html, /Deny/);
  assert.notEqual(permissionMatchingKey(request), permissionMatchingKey({ ...request, resource: "direct:other-run" }));
});

test("network consent names hosts and purpose in the conversation without expanding details", () => {
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onToggleCard: noopToggle, onDecision: async () => {},
    requests: [{ action: "sandbox_network", createdAt: "2026-10-18T00:00:00Z", id: "network",
      description: { hosts: ["eutils.ncbi.nlm.nih.gov:443"], kind: "network", purpose: "Retrieve requested PubMed records.", runnerId: "local" },
      sessionId: "s", resource: "sandbox-network:scoped-digest", state: "pending",
      summary: "Sandbox network on local for this Agent run: eutils.ncbi.nlm.nih.gov:443. Purpose: Retrieve requested PubMed records." }],
  }));
  assert.match(html, /Sandbox network access/);
  assert.match(html, /aria-expanded="false"/);
  assert.doesNotMatch(html, /sandbox-network:scoped-digest/);
  assert.match(html, /for this Agent run/);
  assert.match(html, /eutils.ncbi.nlm.nih.gov:443/);
  assert.match(html, /Retrieve requested PubMed records/);
  assert.match(html, /Allow once/); assert.match(html, /Deny/);
});

test("a sandbox network grant is offered by host scope, not as the shared allow-same-type action", () => {
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [networkRequest()],
  }));
  assert.match(html, new RegExp(`<button class="secondary-button"[^>]*title="${SANDBOX_NETWORK_HINT.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}"[^>]*>Allow these hosts for this run</button>`));
  assert.doesNotMatch(html, /Allow same type/);
  assert.match(html, />Allow once<\/button>/);
  assert.match(html, />Deny<\/button>/);
});

test("the renamed sandbox network button still decides allow_matching", async () => {
  globalThis.IS_REACT_ACT_ENVIRONMENT = true;
  const request = networkRequest();
  const decisions: PermissionDecision[] = [];
  let renderer!: ReactTestRenderer;
  try {
    await act(async () => { renderer = create(createElement(PermissionCards, {
      expandedCards: {}, onToggleCard: noopToggle, requests: [request],
      onDecision: async (_decided, decision) => { decisions.push(decision); },
    })); });
    await act(async () => renderer.root.findByProps({ title: SANDBOX_NETWORK_HINT }).props.onClick());
    assert.deepEqual(decisions, ["allow_matching"]);
  } finally { if (renderer) await act(async () => renderer.unmount()); }
});

test("collapsed shell approvals explain waiting, one request, Session-wide code grants and denial", () => {
  const request: PermissionRequest = {
    action: "code", createdAt: "2026-10-18T00:00:00.000Z", id: "request-shell",
    projectId: "project-1", resource: "workspace-code", sessionId: "session-1", state: "pending",
    summary: "Run Python code in the Session workspace",
  };
  const html = renderToStaticMarkup(createElement(PermissionCards, {
    expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
  }));
  assert.equal(html.match(/class="secondary-button"/g)?.length, 2);
  assert.match(html, />Allow once<\/button>/);
  assert.match(html, />Allow same type<\/button>/);
  assert.match(html, />Deny<\/button>/);
  assert.match(html, /Waiting for your decision before this operation can proceed/);
  assert.match(html, /Allow only this request, without saving permission for future requests/);
  assert.match(html, /Allow pending and future workspace code execution in this Session without asking again, including other scripts and commands/);
  assert.match(html, /Skip this operation and send the denial to the agent/);
  assert.equal(html.match(/aria-describedby=/g)?.length, 3);
  assert.doesNotMatch(html, /title=/);
});

test("matching explanations follow exact-resource and resource-segment matchers", () => {
  const cases: Array<[PermissionRequest["action"], string, RegExp]> = [
    ["connector", "pubmed:search:BRCA1", /first 2 colon-separated resource parts equal pubmed:search\./],
    ["artifact_download", "arxiv:download:paper.pdf", /first 2 colon-separated resource parts equal arxiv:download\./],
    ["host", "ssh:compute-1", /exact resource ssh:compute-1 in this Session/],
    ["direct_code", "direct:run-bound-scope", /exact resource direct:run-bound-scope in this Session/],
    ["connector", "arxiv", /exact resource arxiv in this Session/],
  ];
  for (const [action, resource, help] of cases) {
    const request: PermissionRequest = { ...networkRequest(), action, resource };
    const html = renderToStaticMarkup(createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
    }));
    assert.match(html, help);
    assert.match(html, /pending and future requests for the same action/);
  }
});

test("approval explanations are localized and network consent keeps its run scope", () => {
  const render = (action: PermissionRequest["action"], resource: string, locale: "en" | "zh-CN") =>
    renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale }, createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle,
      requests: [{ ...networkRequest(), action, resource }],
    })));
  const code = render("code", "workspace-code", "zh-CN");
  assert.match(code, /此操作正在等待你的决定，获准后才能继续/);
  assert.match(code, /仅放行当前请求，不为后续请求保存授权/);
  assert.match(code, /本会话中待审批及后续的工作区代码执行，包括其他脚本和命令/);
  assert.match(code, /跳过此操作，并将拒绝结果反馈给 agent/);
  const network = render("sandbox_network", "sandbox-network:digest", "en");
  assert.match(network, /Allow the listed hosts on this Runner for this agent run without asking again/);
  assert.doesNotMatch(network, /exact resource|first 2 colon-separated/);
  assert.match(render("sandbox_network", "sandbox-network:digest", "zh-CN"), /允许本次 Agent 运行中此 Runner 访问列出的主机/);
});

test("the sandbox network grant button is localized", () => {
  const render = (locale: "en" | "zh-CN") => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale },
    createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [networkRequest()],
    })));
  assert.match(render("zh-CN"), />本次运行允许这些主机<\/button>/);
  assert.doesNotMatch(render("zh-CN"), /允许同类操作/);
  assert.match(render("en"), />Allow these hosts for this run<\/button>/);
});

test("sandbox network grants end with the agent run while other grants keep the Session scope", () => {
  const grant = (overrides: Partial<PermissionGrant>): PermissionGrant => ({
    action: "code", createdAt: "2026-10-18T00:00:00.000Z", id: "grant-1", projectId: "project-1",
    resource: "workspace-code", scope: "project", state: "active", ...overrides,
  });
  const html = renderToStaticMarkup(createElement(PermissionGrantManager, {
    grants: [
      grant({ action: "sandbox_network", id: "grant-network", resource: `sandbox-network:${"a".repeat(64)}`, scope: "session" }),
      grant({ id: "grant-shell" }),
    ],
    onRevoke: () => undefined,
  }));
  const networkLine = html.match(/<small>[^<]*sandbox-network[^<]*<\/small>/)?.[0] ?? "";
  assert.match(networkLine, /· this agent run<\/small>$/);
  assert.match(html, /workspace-code · this Session/);
});

/**
 * The configured allowlist is the starting policy, not a boundary (#1383). An
 * approval widens exactly the one execution that carries the token, and a
 * denial changes neither the setting nor the host path, which is not sandboxed.
 */
test("network consent states the per-execution widening and that denial leaves the allowlist alone", () => {
  const request: PermissionRequest = {
    action: "sandbox_network", createdAt: "2026-01-01T00:00:00Z",
    description: { hosts: ["eutils.ncbi.nlm.nih.gov:443"], kind: "network", purpose: "Retrieve requested PubMed records.", runnerId: "local" },
    id: "network", resource: "sandbox-network:scoped-digest", sessionId: "s", state: "pending",
    summary: "Sandbox network on local for this Agent run: eutils.ncbi.nlm.nih.gov:443. Purpose: Retrieve requested PubMed records.",
  };
  const render = (locale: "en" | "zh-CN") => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale },
    createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
    })));
  const english = render("en");
  assert.match(english, /adds these hosts to the allowed domains of the single execution/);
  assert.match(english, /without editing the configured allowlist/);
  assert.match(english, /Deny blocks only this sandbox channel/);
  assert.match(english, /direct host execution is not subject to the sandbox network policy/);
  const chinese = render("zh-CN");
  assert.match(chinese, /临时加入使用该授权的那一次执行的允许域名/);
  assert.match(chinese, /不改动设置里的白名单/);
  assert.match(chinese, /拒绝只拒绝沙箱内的这条通道/);
  assert.match(chinese, /主机直执行也不受沙箱网络策略约束/);
  // The hosts and the purpose the decision is about stay on the card.
  assert.match(chinese, /eutils\.ncbi\.nlm\.nih\.gov:443/);
  assert.match(chinese, /Retrieve requested PubMed records/);
});

test("the direct-host card says the sandbox network policy and its allowlist do not apply", () => {
  const request: PermissionRequest = {
    action: "direct_code", createdAt: "2026-01-01T00:00:00Z",
    description: { account: "user", command: "curl https://example.org", cwd: "", kind: "direct-host", runnerId: "machine",
      target: "machine", workspaceRoot: "workspace" },
    id: "direct", resource: "direct:bound-scope", sessionId: "session", state: "pending",
    summary: "DIRECT HOST EXECUTION: machine, account user, cwd workspace. No isolation.",
  };
  const render = (locale: "en" | "zh-CN") => renderToStaticMarkup(createElement(LocaleProvider, { initialLocale: locale },
    createElement(PermissionCards, {
      expandedCards: {}, onDecision: async () => undefined, onToggleCard: noopToggle, requests: [request],
    })));
  const english = render("en");
  assert.match(english, /sandbox network mode and domain allowlist do not apply/);
  assert.match(english, /a host just denied in the sandbox may still be reached/);
  const chinese = render("zh-CN");
  assert.match(chinese, /沙箱网络模式与域名白名单对它不生效/);
  assert.match(chinese, /沙箱里刚被拒绝的主机仍可能经此通道访问/);
});
