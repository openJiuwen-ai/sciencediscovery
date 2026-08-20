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

import { expect, test } from "@playwright/test";

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

/**
 * The suite's own access-token wiring. These assertions need no stack and no
 * browser: they pin the contract every other spec now depends on — the token
 * comes from the environment, a missing one is reported as a configuration
 * problem, and no retired product default can slip back in as a credential.
 */

/** Credentials the product used to ship, which must never work as a fallback. */
const RETIRED_DEFAULTS = ["science-agent-local", "science-agent-gateway-local"];

test("a configured token resolves for both the API fixtures and the browser", () => {
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

test("surrounding whitespace in the configured token is ignored", () => {
  expect(resolveApiToken({ [API_TOKEN_VARIABLE]: "  padded-token \n" })).toBe("padded-token");
});

test("a missing token is reported as configuration, naming the variable and where to find the value", () => {
  for (const env of [{}, { [API_TOKEN_VARIABLE]: "" }, { [API_TOKEN_VARIABLE]: "   " }]) {
    expect(resolveApiToken(env)).toBeUndefined();
    expect(() => requireApiToken(env)).toThrow(new RegExp(API_TOKEN_VARIABLE));
    expect(() => requireApiToken(env)).toThrow(/secrets\/auth-token/);
    expect(() => requireApiToken(env)).toThrow(/no default token/);
  }
});

test("no retired product default is ever used as a credential", () => {
  const unconfigured = authorizationHeader({});

  for (const retired of RETIRED_DEFAULTS) {
    expect(unconfigured.authorization).not.toContain(retired);
    expect(JSON.stringify(browserStorageState({}))).not.toContain(retired);
    expect(() => requireApiToken({})).not.toThrow(new RegExp(`Bearer ${retired}`));
  }
  // Unconfigured means "no credential", not "some other guessable credential".
  expect(unconfigured.authorization).toBe("Bearer ");
});

test("the seeded token gets the suite through the front door of both surfaces", async ({ page, request }) => {
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

test("E2E_BASE_URL alone points every surface at the same service", () => {
  const { browserOrigin, playwrightBaseUrl, restBase } = targets({ [BASE_URL_VARIABLE]: "http://127.0.0.1:4360" });

  expect(restBase).toBe("http://127.0.0.1:4360");
  expect(playwrightBaseUrl).toBe("http://127.0.0.1:4360");
  expect(browserOrigin).toBe("http://127.0.0.1:4360");
});

test("the legacy variable alone moves the browser too, instead of splitting the run", () => {
  // Regression: the REST helper used to honour E2E_API_URL while the Playwright
  // baseURL read only E2E_BASE_URL, so this configuration drove the fixtures at
  // one service and the browser at another.
  const { browserOrigin, playwrightBaseUrl, restBase } = targets({ [LEGACY_BASE_URL_VARIABLE]: "http://127.0.0.1:4361" });

  expect(restBase).toBe("http://127.0.0.1:4361");
  expect(playwrightBaseUrl).toBe("http://127.0.0.1:4361");
  expect(browserOrigin).toBe("http://127.0.0.1:4361");
});

test("a conflict resolves to the authoritative variable rather than to two targets", () => {
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

test("padding, trailing slashes and blanks resolve to one normalized address", () => {
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "  http://127.0.0.1:4360/  " })).toBe("http://127.0.0.1:4360");
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "http://127.0.0.1:4360///" })).toBe("http://127.0.0.1:4360");
  // A blank authoritative value is "unset", so the legacy variable still applies.
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "   ", [LEGACY_BASE_URL_VARIABLE]: "http://127.0.0.1:4361" }))
    .toBe("http://127.0.0.1:4361");
  expect(apiBaseUrl({})).toBe("http://127.0.0.1:4310");
  // One spec keeps its own documented port; only the variables are shared.
  expect(apiBaseUrl({}, "http://127.0.0.1:4410")).toBe("http://127.0.0.1:4410");
  expect(apiBaseUrl({ [BASE_URL_VARIABLE]: "http://127.0.0.1:4360" }, "http://127.0.0.1:4410"))
    .toBe("http://127.0.0.1:4360");
});
