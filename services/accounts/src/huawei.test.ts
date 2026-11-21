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

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import assert from "node:assert/strict";

import { HuaweiExchangeError, exchangeCodeForProfile } from "./huawei.js";

const ISSUER = "https://accounts.huawei.com";
const NOW = Date.parse("2026-11-21T00:00:00Z");

function idToken(claims: Record<string, unknown>): string {
  const header = Buffer.from(JSON.stringify({ alg: "RS256", typ: "JWT" })).toString("base64url");
  const payload = Buffer.from(JSON.stringify({
    iss: ISSUER,
    aud: "client",
    exp: Math.floor(NOW / 1000) + 3600,
    iat: Math.floor(NOW / 1000),
    ...claims,
  })).toString("base64url");
  return `${header}.${payload}.signature`;
}

function captureFetch(response: unknown, status = 200): { calls: Array<{ url: string; body: string }>; fetchImpl: typeof fetch } {
  const calls: Array<{ url: string; body: string }> = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    calls.push({ url: String(input), body: String(init?.body ?? "") });
    return new Response(JSON.stringify(response), { status });
  }) as typeof fetch;
  return { calls, fetchImpl };
}

test("exchange sends the code and returns the openid from the ID token", async () => {
  const { calls, fetchImpl } = captureFetch({ access_token: "a", id_token: idToken({ openid: "openid-1", display_name: "张三", picture: "https://x/y.png", email: "a@b.c" }) });
  const profile = await exchangeCodeForProfile({
    clientId: "client",
    clientSecret: "secret",
    code: "the-code",
    redirectUri: "https://api.example.com/v1/auth/huawei/callback",
    tokenEndpoint: "https://token.example.com",
    issuer: ISSUER,
    now: () => NOW,
    fetchImpl,
  });

  assert.equal(profile.openid, "openid-1");
  assert.equal(profile.displayName, "张三");
  assert.equal(profile.email, "a@b.c");
  const body = new URLSearchParams(calls[0]!.body);
  assert.equal(body.get("code"), "the-code");
  assert.equal(body.get("client_secret"), "secret");
  assert.equal(body.get("code_verifier"), null);
});

test("exchange prefers PKCE when a verifier is supplied", async () => {
  const { calls, fetchImpl } = captureFetch({ id_token: idToken({ sub: "openid-2" }) });
  const profile = await exchangeCodeForProfile({
    clientId: "client",
    clientSecret: "secret",
    code: "the-code",
    redirectUri: "https://api.example.com/v1/auth/huawei/callback",
    codeVerifier: "verifier",
    tokenEndpoint: "https://token.example.com",
    issuer: ISSUER,
    now: () => NOW,
    fetchImpl,
  });
  assert.equal(profile.openid, "openid-2");
  const body = new URLSearchParams(calls[0]!.body);
  assert.equal(body.get("code_verifier"), "verifier");
  assert.equal(body.get("client_secret"), null);
});

test("exchange omits client_secret when the client has none", async () => {
  const { calls, fetchImpl } = captureFetch({ id_token: idToken({ openid: "openid-3" }) });
  const profile = await exchangeCodeForProfile({
    clientId: "client",
    code: "the-code",
    redirectUri: "https://api.example.com/v1/auth/huawei/callback",
    tokenEndpoint: "https://token.example.com",
    issuer: ISSUER,
    now: () => NOW,
    fetchImpl,
  });
  assert.equal(profile.openid, "openid-3");
  const body = new URLSearchParams(calls[0]!.body);
  assert.equal(body.get("client_secret"), null);
});

test("exchange rejects an ID token issued for another client or outside its lifetime", async () => {
  const cases: Array<{ claims: Record<string, unknown>; code: string }> = [
    { claims: { openid: "o", aud: "another-client" }, code: "id_token_wrong_audience" },
    { claims: { openid: "o", azp: "another-client" }, code: "id_token_wrong_audience" },
    { claims: { openid: "o", iss: "https://evil.example.com" }, code: "id_token_wrong_issuer" },
    { claims: { openid: "o", exp: Math.floor(NOW / 1000) - 3600 }, code: "id_token_expired" },
    { claims: { openid: "o", exp: undefined }, code: "id_token_expired" },
  ];
  for (const { claims, code } of cases) {
    const { fetchImpl } = captureFetch({ id_token: idToken(claims) });
    await assert.rejects(
      exchangeCodeForProfile({ clientId: "client", code: "c", redirectUri: "r", tokenEndpoint: "t", issuer: ISSUER, now: () => NOW, fetchImpl }),
      (error: unknown) => error instanceof HuaweiExchangeError && error.code === code,
      code,
    );
  }
});

test("exchange surfaces provider failures and ID tokens without an identity", async () => {
  const rejected = captureFetch({ error: "invalid_grant", error_description: "code expired" }, 400);
  await assert.rejects(
    exchangeCodeForProfile({ clientId: "c", clientSecret: "s", code: "x", redirectUri: "r", tokenEndpoint: "t", issuer: ISSUER, now: () => NOW, fetchImpl: rejected.fetchImpl }),
    (error: unknown) => error instanceof HuaweiExchangeError && error.code === "token_exchange_failed",
  );

  const anonymous = captureFetch({ id_token: idToken({ nickname: "no openid" }) });
  await assert.rejects(
    exchangeCodeForProfile({ clientId: "client", clientSecret: "s", code: "x", redirectUri: "r", tokenEndpoint: "t", issuer: ISSUER, now: () => NOW, fetchImpl: anonymous.fetchImpl }),
    (error: unknown) => error instanceof HuaweiExchangeError && error.code === "id_token_without_openid",
  );
});
