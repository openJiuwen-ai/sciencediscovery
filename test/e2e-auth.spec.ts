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

import { expect } from "@playwright/test";

import { test } from "./helpers/e2e.ts";
import {
  API_TOKEN_VARIABLE,
  apiBaseUrl,
  authorizationHeader,
  BASE_URL_VARIABLE,
  browserStorageState,
  BROWSER_TOKEN_STORAGE_KEY,
  LEGACY_BASE_URL_VARIABLE,
  requireApiToken,
  resolveApiToken,
} from "./e2e-auth.js";

// Static suite metadata is inherited by each framework-expanded journey.
test.describe("e2e-auth.spec", { tag: ["@isolation:global", "@category:e2e", "@os:linux", "@arch:amd64", "@status:reviewed", "@sandbox:bubblewrap"] }, () => {

/**
 * The suite's own access-token wiring. These assertions need no stack and no
 * browser: they pin the contract every other spec now depends on — the token
 * comes from the environment, a missing one is reported as a configuration
 * problem, and no retired product default can slip back in as a credential.
 */

/** Credentials the product used to ship, which must never work as a fallback. */
const RETIRED_DEFAULTS = ["science-agent-local", "science-agent-gateway-local"];

/**
 * E2E-META
 * Purpose: 固定测试套件自身的凭据契约——配置的 token 同时驱动 REST fixtures 与浏览器存储状态。
 * Steps:
 *   1. 用合成的环境值解析 API token、鉴权头与浏览器 storageState。
 *   2. 断言三者使用同一个 token 与同一个来源。
 * Environment: 不启动栈或浏览器；只运行套件自身的 token/base-url 解析函数。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 全部输入为进程内合成环境变量。
 * Credentials: 合成的 "configured-token"；不是产品凭据。
 * CostSideEffects: none
 */
test("a configured token resolves for both the API fixtures and the browser", { tag: "@mocked" }, () => {
  const env = { [API_TOKEN_VARIABLE]: "configured-token", [BASE_URL_VARIABLE]: "http://127.0.0.1:4310" };

  expect(resolveApiToken(env)).toBe("configured-token");
  expect(requireApiToken(env)).toBe("configured-token");
  expect(authorizationHeader(env)).toEqual({ authorization: "Bearer configured-token" });
  expect(browserStorageState(env)).toEqual({
    cookies: [],
    origins: [{
      localStorage: [{ name: BROWSER_TOKEN_STORAGE_KEY, value: "configured-token" }],
      origin: "http://127.0.0.1:4310",
    }],
  });
});

/**
 * E2E-META
 * Purpose: 配置 token 前后的空白与换行不影响解析结果。
 * Steps:
 *   1. 传入带前后空白和换行的 token。
 *   2. 断言解析结果被 trim 成同一个 token。
 * Environment: 不启动栈或浏览器；纯解析函数。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: 合成的 "padded-token"；不是产品凭据。
 * CostSideEffects: none
 */
test("surrounding whitespace in the configured token is ignored", { tag: "@mocked" }, () => {
  expect(resolveApiToken({ [API_TOKEN_VARIABLE]: "  padded-token \n" })).toBe("padded-token");
});

/**
 * E2E-META
 * Purpose: 缺少 token 时按配置问题报错，点名变量并指出凭据文件位置，而不是猜测一个默认值。
 * Steps:
 *   1. 依次传入空、空白与未设置的环境。
 *   2. 断言解析返回 undefined，且 requireApiToken 的错误点名变量与 secrets/auth-token。
 * Environment: 不启动栈或浏览器；纯解析函数。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: none — 用例刻意不提供 token。
 * CostSideEffects: none
 */
test("a missing token is reported as configuration, naming the variable and where to find the value", { tag: "@mocked" }, () => {
  for (const env of [{}, { [API_TOKEN_VARIABLE]: "" }, { [API_TOKEN_VARIABLE]: "   " }]) {
    expect(resolveApiToken(env)).toBeUndefined();
    expect(() => requireApiToken(env)).toThrow(new RegExp(API_TOKEN_VARIABLE));
    expect(() => requireApiToken(env)).toThrow(/secrets\/auth-token/);
    expect(() => requireApiToken(env)).toThrow(/no default token/);
  }
});

/**
 * E2E-META
 * Purpose: 产品已下线的默认 token 永远不会作为回退凭据出现。
 * Steps:
 *   1. 用空环境生成鉴权头与浏览器 storageState。
 *   2. 断言任何已下线的默认 token 都不出现，未配置就是空 Bearer。
 * Environment: 不启动栈或浏览器；纯解析函数。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: none — 用例验证的就是没有可用默认凭据。
 * CostSideEffects: none
 */
test("no retired product default is ever used as a credential", { tag: "@mocked" }, () => {
  const unconfigured = authorizationHeader({});

  for (const retired of RETIRED_DEFAULTS) {
    expect(unconfigured.authorization).not.toContain(retired);
    expect(JSON.stringify(browserStorageState({}))).not.toContain(retired);
    expect(() => requireApiToken({})).not.toThrow(new RegExp(`Bearer ${retired}`));
  }
  // Unconfigured means "no credential", not "some other guessable credential".
  expect(unconfigured.authorization).toBe("Bearer ");
});

/**
 * E2E-META
 * Purpose: 本实例的 token 同时通过 REST fixtures 与浏览器入口，不触发连接对话框或未授权通知。
 * Steps:
 *   1. 用共享鉴权头请求 /api/models。
 *   2. 打开应用首页。
 *   3. 断言 Connection settings 未弹出，且没有 Unauthorized 通知。
 * Environment: 隔离本地栈（E2E_BASE_URL），浏览器已注入本实例 token。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 请求只指向本地栈。
 * Credentials: 隔离实例的 E2E_API_TOKEN。
 * CostSideEffects: none
 */
test("the seeded token gets the suite through the front door of both surfaces", { tag: "@mocked" }, async ({ page, request }) => {
  // The REST fixtures every other spec uses.
  const models = await request.get("/api/models", { headers: authorizationHeader() });
  expect(models.status(), "the shared authorization header must be accepted").toBe(200);

  // And the browser, which the config seeds the same way a user would after
  // pasting the printed token: no Connection dialog, no rejection notice.
  await page.goto("/");
  await expect(page.locator("section.system-config-dialog[role='dialog']")).toBeHidden();
  await expect(page.locator(".toast-viewport .toast").filter({ hasText: "Unauthorized" })).toHaveCount(0);
});

/** Everything that has to agree on the target: what REST fixtures call, what
 *  the seeded token belongs to, and what the browser navigates to. */
function targets(env: NodeJS.ProcessEnv) {
  return {
    browserOrigin: browserStorageState(env).origins[0]?.origin,
    playwrightBaseUrl: apiBaseUrl(env), // playwright.config.ts computes `baseURL` this way
    restBase: apiBaseUrl(env),
  };
}

/**
 * E2E-META
 * Purpose: 只设置权威地址变量时，REST、Playwright baseURL 与浏览器 origin 指向同一个服务。
 * Steps:
 *   1. 只设置 E2E_BASE_URL。
 *   2. 断言三处目标完全一致。
 * Environment: 不启动栈；只解析地址。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: none
 * CostSideEffects: none
 */
test("E2E_BASE_URL alone points every surface at the same service", { tag: "@mocked" }, () => {
  const { browserOrigin, playwrightBaseUrl, restBase } = targets({ [BASE_URL_VARIABLE]: "http://127.0.0.1:4360" });

  expect(restBase).toBe("http://127.0.0.1:4360");
  expect(playwrightBaseUrl).toBe("http://127.0.0.1:4360");
  expect(browserOrigin).toBe("http://127.0.0.1:4360");
});

/**
 * E2E-META
 * Purpose: 旧地址变量单独出现时也同时移动浏览器与 REST，避免一次运行分裂到两个服务。
 * Steps:
 *   1. 只设置旧变量 E2E_API_URL。
 *   2. 断言三处目标仍一致（回归：REST 与浏览器曾经分裂）。
 * Environment: 不启动栈；只解析地址。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: none
 * CostSideEffects: none
 */
test("the legacy variable alone moves the browser too, instead of splitting the run", { tag: "@mocked" }, () => {
  // Regression: the REST helper used to honour E2E_API_URL while the Playwright
  // baseURL read only E2E_BASE_URL, so this configuration drove the fixtures at
  // one service and the browser at another.
  const { browserOrigin, playwrightBaseUrl, restBase } = targets({ [LEGACY_BASE_URL_VARIABLE]: "http://127.0.0.1:4361" });

  expect(restBase).toBe("http://127.0.0.1:4361");
  expect(playwrightBaseUrl).toBe("http://127.0.0.1:4361");
  expect(browserOrigin).toBe("http://127.0.0.1:4361");
});

/**
 * E2E-META
 * Purpose: 两个地址变量冲突时，权威变量 E2E_BASE_URL 整体胜出，而不是让不同界面各用一端。
 * Steps:
 *   1. 同时设置两个变量且值不同。
 *   2. 断言三处目标都解析到权威变量。
 * Environment: 不启动栈；只解析地址。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: none
 * CostSideEffects: none
 */
test("a conflict resolves to the authoritative variable rather than to two targets", { tag: "@mocked" }, () => {
  const env = {
    [BASE_URL_VARIABLE]: "http://127.0.0.1:4360",
    [LEGACY_BASE_URL_VARIABLE]: "http://127.0.0.1:4361",
  };
  const { browserOrigin, playwrightBaseUrl, restBase } = targets(env);

  // The guideline treats E2E_BASE_URL as authoritative, so it wins outright.
  expect(restBase).toBe("http://127.0.0.1:4360");
  expect(playwrightBaseUrl).toBe("http://127.0.0.1:4360");
  expect(browserOrigin).toBe("http://127.0.0.1:4360");
});

/**
 * E2E-META
 * Purpose: 空白、尾斜杠与空值都归一化为同一个 origin，回退顺序有明确终点。
 * Steps:
 *   1. 输入带空格、尾斜杠、空白的地址与空环境。
 *   2. 断言归一化为同一个 origin；空白权威值回退到旧变量，最终回退到测试栈端口 4410。
 * Environment: 不启动栈；只解析地址。
 * Type: mocked
 * LLM: none
 * WebSearch: none
 * PaperSources: none
 * MCP: none
 * OtherExternal: none — 输入为进程内合成环境变量。
 * Credentials: none
 * CostSideEffects: none
 */
test("padding, trailing slashes and blanks resolve to one normalized address", { tag: "@mocked" }, () => {
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "  http://127.0.0.1:4360/  " })).toBe("http://127.0.0.1:4360");
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "http://127.0.0.1:4360///" })).toBe("http://127.0.0.1:4360");
  // A blank authoritative value is "unset", so the legacy variable still applies.
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "   ", [LEGACY_BASE_URL_VARIABLE]: "http://127.0.0.1:4361" }))
    .toBe("http://127.0.0.1:4361");
  // The fallback is the test-stack port, never the product's own default.
  expect(apiBaseUrl({})).toBe("http://127.0.0.1:4410");
  // One spec keeps its own documented port; only the variables are shared.
  expect(apiBaseUrl({}, "http://127.0.0.1:4410")).toBe("http://127.0.0.1:4410");
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "http://127.0.0.1:4360" }, "http://127.0.0.1:4410"))
    .toBe("http://127.0.0.1:4360");
});

});
