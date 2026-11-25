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

import assert from "node:assert/strict";

import { createTest } from "../../../test/support/tagged/compat.mjs";
import { setLanguage } from "../src/text.js";
import { localizeToolDiagnostics } from "../src/tool-diagnostics.js";

const { describe, it, afterEach } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});

afterEach(() => {
  setLanguage("zh-CN");
});

describe("a tool result re-renders runner and egress diagnostics in Chinese", () => {
  it("localizes the execution timeout the runner reports", () => {
    setLanguage("zh-CN");
    const localized = localizeToolDiagnostics("Shell execution timed out after 5000 ms");
    assert.equal(
      localized,
      "工具执行已超过 5 秒。建议缩小单次执行范围后重试，或在系统设置中适当增加执行超时时间。",
    );
    assert.doesNotMatch(localized, /Shell execution timed out after 5000 ms/);
    // The other producers use the same sentence with their own label.
    assert.match(
      localizeToolDiagnostics("Direct shell execution timed out after 5000 ms"),
      /工具执行已超过 5 秒/,
    );
    assert.match(
      localizeToolDiagnostics("Python execution timed out after 25 ms"),
      /工具执行已超过 0\.025 秒/,
    );
    // Every label the runner-side producers actually emit is recognized.
    for (const label of [
      "R execution",
      "Persistent kernel evaluation",
      "Persistent shell evaluation",
    ]) {
      assert.match(localizeToolDiagnostics(`${label} timed out after 2000 ms`), /工具执行已超过 2 秒/);
    }
  });

  it("does not rewrite a program's own execution timeout", () => {
    setLanguage("zh-CN");
    const output = "Test execution timed out after 30000 ms";
    assert.equal(localizeToolDiagnostics(output), output);
  });

  it("localizes a domain-allowlist denial with the host and port", () => {
    setLanguage("zh-CN");
    const localized = localizeToolDiagnostics("example.org:443 is not in the sandbox network allowed domains");
    assert.equal(localized, "沙箱网络拒绝访问 example.org:443：它不在允许的域名列表中。");
    assert.doesNotMatch(localized, /is not in the sandbox network allowed domains/);
  });

  it("localizes the other egress decisions the gateway can report", () => {
    setLanguage("zh-CN");
    assert.match(
      localizeToolDiagnostics("sandbox network access is disabled for this execution"),
      /本次执行已关闭沙箱网络访问/,
    );
    assert.match(
      localizeToolDiagnostics("10.0.0.1 is an IP address; sandbox network access allows domain names only"),
      /不能直接访问 IP 地址 10\.0\.0\.1/,
    );
    assert.match(
      localizeToolDiagnostics("10.0.0.1 is a private address; enable private network access to allow it"),
      /10\.0\.0\.1 是私有地址/,
    );
    assert.match(
      localizeToolDiagnostics("mirror.test resolves only to private or loopback addresses; enable private network access to allow it"),
      /mirror\.test 只解析到私有或回环地址/,
    );
    assert.match(
      localizeToolDiagnostics("missing.test could not be resolved: getaddrinfo ENOTFOUND"),
      /无法解析 missing\.test：getaddrinfo ENOTFOUND/,
    );
  });

  it("localizes the gateway's own 502 and 400 explanations", () => {
    setLanguage("zh-CN");
    assert.equal(
      localizeToolDiagnostics("Sandbox network access could not reach mirror.test:443 through this deployment's outbound route"),
      "沙箱网络无法通过本部署的出口路由访问 mirror.test:443。",
    );
    assert.equal(
      localizeToolDiagnostics("Sandbox network access expects absolute-form proxy requests"),
      "沙箱网络只接受完整的代理请求（absolute-form）。",
    );
    assert.equal(
      localizeToolDiagnostics("Sandbox network access cannot forward https: without CONNECT"),
      "沙箱网络无法在未建立 CONNECT 隧道的情况下转发 https: 请求。",
    );
  });

  it("keeps bracketed IPv6 hosts intact in every egress decision", () => {
    setLanguage("zh-CN");
    assert.equal(
      localizeToolDiagnostics("[::1] is an IP address; sandbox network access allows domain names only"),
      "沙箱网络只允许访问域名，不能直接访问 IP 地址 [::1]。",
    );
    assert.equal(
      localizeToolDiagnostics("[::1] is a private address; enable private network access to allow it"),
      "[::1] 是私有地址；如需访问，请在沙箱网络中启用私有网络访问。",
    );
    assert.equal(
      localizeToolDiagnostics("[2001:db8::1] resolves only to private or loopback addresses; enable private network access to allow it"),
      "[2001:db8::1] 只解析到私有或回环地址；如需访问，请在沙箱网络中启用私有网络访问。",
    );
    assert.equal(
      localizeToolDiagnostics("[2001:db8::1] could not be resolved: getaddrinfo ENOTFOUND"),
      "无法解析 [2001:db8::1]：getaddrinfo ENOTFOUND",
    );
    assert.equal(
      localizeToolDiagnostics("[::1]:443 is not in the sandbox network allowed domains"),
      "沙箱网络拒绝访问 [::1]:443：它不在允许的域名列表中。",
    );
  });

  it("localizes the proxy's tunnel failure and keeps the status", () => {
    setLanguage("zh-CN");
    const localized = localizeToolDiagnostics("Tunnel connection failed: 403 Forbidden");
    assert.equal(localized, "代理隧道连接失败：403 Forbidden。请检查代理设置或沙箱网络允许的域名。");
    assert.doesNotMatch(localized, /Tunnel connection failed/);
  });

  it("localizes the proxy sentence inside a Python traceback", () => {
    setLanguage("zh-CN");
    const localized = localizeToolDiagnostics(
      "Traceback (most recent call last):\n  File \"<stdin>\", line 1, in <module>\nOSError: Tunnel connection failed: 403 Forbidden",
    );
    assert.match(localized, /OSError: 代理隧道连接失败：403 Forbidden。请检查代理设置或沙箱网络允许的域名。/);
    assert.doesNotMatch(localized, /Tunnel connection failed/);
  });

  it("localizes diagnostics inside a result without touching the rest", () => {
    setLanguage("zh-CN");
    const localized = localizeToolDiagnostics(
      "started\nTunnel connection failed: 403 Forbidden\nShell execution timed out after 5000 ms",
    );
    assert.match(localized, /^started\n/);
    assert.match(localized, /代理隧道连接失败：403 Forbidden/);
    assert.match(localized, /工具执行已超过 5 秒/);
    assert.doesNotMatch(localized, /Tunnel connection failed|Shell execution timed out/);
  });

  it("localizes several reasons on one line independently", () => {
    setLanguage("zh-CN");
    assert.equal(
      localizeToolDiagnostics(
        "a.test could not be resolved: dns failed; b.test is a private address; enable private network access to allow it",
      ),
      "无法解析 a.test：dns failed; b.test 是私有地址；如需访问，请在沙箱网络中启用私有网络访问。",
    );
  });

  it("stays linear on a long single-line result", () => {
    setLanguage("zh-CN");
    const line = `{"value":"${"a".repeat(100_000)}"}`;
    const started = performance.now();
    const localized = localizeToolDiagnostics(line);
    const elapsed = performance.now() - started;
    assert.equal(localized, line);
    assert.ok(elapsed < 500, `localizing a 100 KB line took ${elapsed.toFixed(1)} ms`);
  });

  it("leaves ordinary program output untouched", () => {
    setLanguage("zh-CN");
    const output = "stdout: tunnel connection failed: retrying\nstderr: timed out after 3 ms";
    assert.equal(localizeToolDiagnostics(output), output);
  });
});

describe("an English UI keeps the producers' English diagnostics", () => {
  it("returns every recognized diagnostic exactly as the producer wrote it", () => {
    setLanguage("en");
    const lines = [
      "Shell execution timed out after 5000 ms",
      "Direct shell execution timed out after 5000 ms",
      "example.org:443 is not in the sandbox network allowed domains",
      "sandbox network access is disabled for this execution",
      "10.0.0.1 is an IP address; sandbox network access allows domain names only",
      "10.0.0.1 is a private address; enable private network access to allow it",
      "mirror.test resolves only to private or loopback addresses; enable private network access to allow it",
      "missing.test could not be resolved: getaddrinfo ENOTFOUND",
      "Sandbox network access could not reach mirror.test:443 through this deployment's outbound route",
      "Sandbox network access expects absolute-form proxy requests",
      "Sandbox network access cannot forward https: without CONNECT",
      "[::1] is an IP address; sandbox network access allows domain names only",
      "[::1] is a private address; enable private network access to allow it",
      "[2001:db8::1] resolves only to private or loopback addresses; enable private network access to allow it",
      "[2001:db8::1] could not be resolved: getaddrinfo ENOTFOUND",
      "[::1]:443 is not in the sandbox network allowed domains",
      "Tunnel connection failed: 403 Forbidden",
    ];
    for (const line of lines) {
      assert.equal(localizeToolDiagnostics(line), line);
    }
  });
});
