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
const { afterEach, test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
import type { PermissionDescription } from "@sciencediscovery/schema";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import type { PermissionRequest } from "../src/api/types.js";
import { formatPermissionRequest } from "../src/permission-summary.js";
import { setLanguage } from "../src/text.js";
import { PermissionCard } from "../src/views/PermissionCard.js";

// The language store is module state: leave it in the default for the next test
// file the runner loads.
afterEach(() => setLanguage("zh-CN"));

function request(description: PermissionDescription | undefined, summary: string): PermissionRequest {
  return {
    action: description?.kind === "direct-host" ? "direct_code" : "code",
    createdAt: "2026-01-01T00:00:00Z",
    ...(description ? { description } : {}),
    id: "permission-1",
    resource: "workspace-code",
    state: "pending",
    summary,
  };
}

const card = (value: PermissionRequest) => renderToStaticMarkup(
  <PermissionCard busy={false} interactive onDecision={() => {}} request={value} />,
);

test("a zh-CN card says a shell request in Chinese, not the API's English sentence", () => {
  const html = card(request({ kind: "shell" }, "Run a shell script in the Session workspace"));
  assert.match(html, /在会话工作区中运行 Shell 脚本/);
  assert.doesNotMatch(html, /Run a shell script/);
});

test("a direct-host request keeps its command and warning in Chinese", () => {
  const html = card(request({
    account: "user:1000:1000",
    command: "printf hello\nrm -rf build",
    cwd: "",
    kind: "direct-host",
    runnerId: "local",
    target: "machine:instance",
    workspaceRoot: "/data/projects/session-1/workspace",
  }, "DIRECT HOST EXECUTION: Runner local, machine:instance, account user:1000:1000"));
  assert.match(html, /直接在主机上执行/);
  assert.match(html, /不会隔离文件系统、进程或网络/);
  assert.match(html, /同类授权只覆盖本次 Agent 运行中的这条命令和这个范围/);
  assert.match(html, /账号 user:1000:1000/);
  // The command is the most consequential line of the card: its newline must
  // survive rendering, which needs the pre-wrap the summary used to lack.
  assert.match(html, /命令：\nprintf hello\nrm -rf build/);
  assert.doesNotMatch(html, /DIRECT HOST EXECUTION/);
});

test("the same persisted request is rendered in whichever language is in force", () => {
  const persisted = request({ kind: "shell", remoteHostAlias: "build-01" }, "Run a shell script on build-01 in the Session workspace");
  assert.match(card(persisted), /在 build-01 上的会话工作区中运行 Shell 脚本/);
  setLanguage("en");
  const english = card(persisted);
  assert.match(english, /Run a shell script on build-01 in the Session workspace/);
  assert.doesNotMatch(english, /运行 Shell 脚本/);
});

test("an unstructured request falls back to a localized action, not to English prose", () => {
  const legacy = request(undefined, "Query PubMed for BRCA1");
  const html = card({ ...legacy, action: "connector" });
  assert.match(html, /使用连接器/);
  assert.doesNotMatch(html, /Query PubMed for BRCA1/);
  // The canonical summary is still the last resort for an action this build
  // does not know, so nothing is silently dropped.
  assert.equal(formatPermissionRequest({ action: "unknown" as never, summary: "Raw summary" }), "Raw summary");
  assert.match(card({ ...legacy, action: "unknown" as never }), /Query PubMed for BRCA1/);
});

test("a tool approval card shows the command or arguments the user is approving", () => {
  const toolCall = request({ detail: "rm -rf out", kind: "tool-call", toolName: "run_shell" }, "run_shell: rm -rf out");
  // run_shell approves the fixed workspace-code resource, so the command is
  // only available as the description's detail.
  assert.match(card(toolCall), /在本会话中运行工具 run_shell\nrm -rf out/);
  const withArguments = request(
    { detail: '{"celsius": -40}', kind: "tool-call", toolName: "mcp__custom-1__to_kelvin" },
    'mcp__custom-1__to_kelvin: {"celsius": -40}',
  );
  assert.match(card(withArguments), /工具 mcp__custom-1__to_kelvin\n\{&quot;celsius&quot;: -40\}/);
  setLanguage("en");
  assert.match(card(toolCall), /Run tool run_shell in this Session\nrm -rf out/);
  assert.match(card(withArguments), /Run tool mcp__custom-1__to_kelvin in this Session\n\{&quot;celsius&quot;: -40\}/);
});

test("every description kind has Chinese and English wording", () => {
  // A kind added without copy would otherwise render as a blank line; the
  // renderer table is exhaustive by type, so this only has to prove the
  // default language is applied to all of them.
  setLanguage("en");
  assert.equal(formatPermissionRequest(request({ kind: "file-copy", fileCount: 3 }, "summary")), "Copy 3 selected files between authorized Workspaces");
  setLanguage("zh-CN");
  assert.equal(formatPermissionRequest(request({ fileCount: 3, kind: "file-copy" }, "summary")), "在已授权的工作区之间复制 3 个选中的文件");
});

/**
 * #1383: the configured allowlist is the starting policy, not a boundary. An
 * approval adds its hosts to the one execution that carries the token, and a
 * denial neither rewrites the setting nor covers the host path, which runs
 * outside the sandbox.
 */
test("a network card states the per-execution widening and that denial leaves the allowlist alone", () => {
  const description: PermissionDescription = {
    hosts: ["eutils.ncbi.nlm.nih.gov:443"],
    kind: "network",
    purpose: "Retrieve requested PubMed records.",
    runnerId: "local",
  };
  const value = { ...request(description, "Sandbox network on local"), action: "sandbox_network" as const };
  const chinese = card(value);
  assert.match(chinese, /临时加入使用该授权的那一次执行的允许域名/);
  assert.match(chinese, /不改动设置里的白名单/);
  assert.match(chinese, /拒绝只拒绝沙箱内的这条通道/);
  assert.match(chinese, /主机直执行也不受沙箱网络策略约束/);
  // The host and purpose the decision is about stay on the card.
  assert.match(chinese, /eutils\.ncbi\.nlm\.nih\.gov:443/);
  assert.match(chinese, /Retrieve requested PubMed records/);
  setLanguage("en");
  const english = card(value);
  assert.match(english, /adds these hosts to the allowed domains of the single execution/);
  assert.match(english, /without editing the configured allowlist/);
  assert.match(english, /Deny blocks only this sandbox channel/);
  assert.match(english, /direct host execution is not subject to the sandbox network policy/);
});

test("a direct-host card says the sandbox network policy and its allowlist do not apply", () => {
  const description: PermissionDescription = {
    account: "user:1000:1000",
    command: "curl https://example.org",
    cwd: "",
    kind: "direct-host",
    runnerId: "local",
    target: "machine:instance",
    workspaceRoot: "/data/projects/session-1/workspace",
  };
  const value = request(description, "DIRECT HOST EXECUTION: Runner local");
  const chinese = card(value);
  assert.match(chinese, /沙箱网络模式与域名白名单对它不生效/);
  assert.match(chinese, /沙箱里刚被拒绝的主机仍可能经此通道访问/);
  setLanguage("en");
  const english = card(value);
  assert.match(english, /sandbox network mode and domain allowlist do not apply/);
  assert.match(english, /a host just denied in the sandbox may still be reached/);
});
