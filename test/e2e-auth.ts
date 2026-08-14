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

/**
 * Shared access-token wiring for the Playwright suite.
 *
 * The product no longer ships a default credential: every installation
 * generates its own access token on first start and prints it. Tests therefore
 * cannot assume any literal, and a suite that guesses one only finds out at the
 * first business request, as a 401 or a wait that times out. The token comes
 * from `E2E_API_TOKEN`, the run fails at start-up when it is missing (see
 * `global-setup.ts`), and the value only ever lives in the environment — never
 * in the sources, a fixture file, or a report.
 *
 * `authorizationHeader()` is safe to evaluate while specs are being collected,
 * so `--list` still works without a configured stack; the loud failure belongs
 * to the run, not to discovery.
 */

/** The one variable that names the access token of the instance under test. */
export const API_TOKEN_VARIABLE = "E2E_API_TOKEN";

/** Where the Web UI keeps the token it sends with every request. */
export const BROWSER_TOKEN_STORAGE_KEY = "science-agent-token";

/** The variable the E2E guideline treats as authoritative for the target. */
export const BASE_URL_VARIABLE = "E2E_BASE_URL";
/** Older per-spec spelling, still accepted so existing commands keep working. */
export const LEGACY_BASE_URL_VARIABLE = "E2E_API_URL";

const DEFAULT_BASE_URL = "http://127.0.0.1:4310";

/**
 * The one address the whole suite talks to.
 *
 * The REST fixtures, the storage-state origin and the Playwright `baseURL` all
 * come from here, so they cannot end up pointing at different services: setting
 * only the legacy variable moves the browser too, and setting both makes
 * `E2E_BASE_URL` win rather than splitting the run in half.
 */
export function apiBaseUrl(
  env: NodeJS.ProcessEnv = process.env,
  fallback: string = DEFAULT_BASE_URL,
): string {
  const configured = env[BASE_URL_VARIABLE]?.trim() || env[LEGACY_BASE_URL_VARIABLE]?.trim();
  return (configured || fallback).replace(/\/+$/, "");
}

export function resolveApiToken(env: NodeJS.ProcessEnv = process.env): string | undefined {
  return env[API_TOKEN_VARIABLE]?.trim() || undefined;
}

/**
 * The token, or a failure that names exactly what is missing and where to get
 * it. Used by the global setup so a misconfigured run stops before the first
 * request instead of after it.
 */
export function requireApiToken(env: NodeJS.ProcessEnv = process.env): string {
  const token = resolveApiToken(env);
  if (token) return token;
  throw new Error(
    `${API_TOKEN_VARIABLE} is not set, so these tests have no way to authenticate.`
    + " The stack prints the token it generated on its first start"
    + ' ("Local API token (generated on first start): ..."), and stores it in'
    + " <data dir>/secrets/auth-token. Export that value as"
    + ` ${API_TOKEN_VARIABLE} before running the suite.`
    + " There is no default token to fall back on.",
  );
}

/** Bearer header for API fixtures. Empty when unconfigured; the run has already
 *  failed by then, and returning a header keeps spec collection working. */
export function authorizationHeader(env: NodeJS.ProcessEnv = process.env): { authorization: string } {
  return { authorization: `Bearer ${resolveApiToken(env) ?? ""}` };
}

export interface BrowserStorageState {
  cookies: never[];
  origins: Array<{ localStorage: Array<{ name: string; value: string }>; origin: string }>;
}

/**
 * Seed the browser the same way a user would after pasting the printed token,
 * so every UI spec starts authenticated without repeating the wiring. Specs
 * that need the rejected-token path clear the key in an init script.
 *
 * The origin comes from `apiBaseUrl` rather than a caller-supplied address, so
 * the seeded token always belongs to the service the run actually targets.
 */
export function browserStorageState(env: NodeJS.ProcessEnv = process.env): BrowserStorageState {
  return {
    cookies: [],
    origins: [{
      localStorage: [{ name: BROWSER_TOKEN_STORAGE_KEY, value: resolveApiToken(env) ?? "" }],
      origin: new URL(apiBaseUrl(env)).origin,
    }],
  };
}
