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

import { createTest } from "../../../../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });

import { isLoopbackHost, verifyAccountAccessToken } from "./account-verification.js";

const response = (status: number): Response => new Response("{}", { status });

test("a token the account service accepts is proof; a bogus one is refused", async () => {
  const seen: string[] = [];
  const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
    seen.push(new URL(String(input)).pathname);
    const authorization = new Headers(init?.headers).get("authorization");
    return response(authorization === "Bearer live-token" ? 200 : 401);
  }) as typeof fetch;

  assert.deepEqual(await verifyAccountAccessToken("Bearer live-token", { baseUrl: "https://accounts.example.com/", fetchImpl }), { ok: true });
  assert.deepEqual(await verifyAccountAccessToken("Bearer bogus", { baseUrl: "https://accounts.example.com", fetchImpl }), { ok: false, reason: "unauthorized" });
  assert.equal(seen[0], "/v1/me");
});

test("verification fails closed when it cannot be made", async () => {
  assert.deepEqual(await verifyAccountAccessToken("Bearer token", { baseUrl: "" }), { ok: false, reason: "not_configured" });
  assert.deepEqual(await verifyAccountAccessToken(undefined, { baseUrl: "https://accounts.example.com" }), { ok: false, reason: "unauthorized" });
  assert.deepEqual(await verifyAccountAccessToken("Basic abc", { baseUrl: "https://accounts.example.com" }), { ok: false, reason: "unauthorized" });
  const offline = (async () => { throw new Error("offline"); }) as unknown as typeof fetch;
  assert.deepEqual(await verifyAccountAccessToken("Bearer token", { baseUrl: "https://accounts.example.com", fetchImpl: offline }), { ok: false, reason: "unreachable" });
});

test("only a loopback Host header names this machine", () => {
  assert.equal(isLoopbackHost("127.0.0.1:4310"), true);
  assert.equal(isLoopbackHost("localhost:4310"), true);
  assert.equal(isLoopbackHost("[::1]:4310"), true);
  assert.equal(isLoopbackHost("attacker.example:4310"), false);
  assert.equal(isLoopbackHost(undefined), false);
});
