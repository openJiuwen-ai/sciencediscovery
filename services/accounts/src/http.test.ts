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

import { Router, readCookie, parseBearer, serializeCookie } from "./http.js";
import { normalizePath, toFunctionResult, toHttpRequest } from "./server.js";

test("router extracts parameters and rejects the wrong method", async () => {
  const router = new Router();
  router.add("POST", "/v1/admin/users/:id/sessions/:sid/revoke", async (_request, params) => ({ status: 200, headers: {}, body: JSON.stringify(params) }));

  const match = router.match("POST", "/v1/admin/users/42/sessions/abc/revoke");
  assert.deepEqual(match?.params, { id: "42", sid: "abc" });
  assert.equal(router.match("GET", "/v1/admin/users/42/sessions/abc/revoke"), undefined);
  assert.equal(router.match("POST", "/v1/admin/users/42/sessions"), undefined);
});

test("router tolerates a trailing slash and decodes segments", () => {
  const router = new Router();
  router.add("GET", "/v1/me", async () => ({ status: 200, headers: {}, body: "" }));
  router.add("GET", "/v1/items/:id", async () => ({ status: 200, headers: {}, body: "" }));
  assert.ok(router.match("GET", "/v1/me/"));
  assert.deepEqual(router.match("GET", "/v1/items/a%20b")?.params, { id: "a b" });
});

test("cookies are read and written predictably", () => {
  const header = serializeCookie("sd_admin", "token-value", { maxAge: 60, domain: ".example.com", secure: true });
  assert.match(header, /sd_admin=token-value/u);
  assert.match(header, /HttpOnly/u);
  assert.match(header, /Secure/u);
  assert.match(header, /Domain=\.example\.com/u);
  assert.equal(readCookie("a=1; sd_admin=abc; b=2", "sd_admin"), "abc");
  assert.equal(readCookie("a=1", "sd_admin"), undefined);
  assert.equal(parseBearer("Bearer abc.def.ghi"), "abc.def.ghi");
  assert.equal(parseBearer("Basic abc"), undefined);
});

test("function events become the same request shape as node:http", () => {
  const request = toHttpRequest({
    httpMethod: "POST",
    path: "/v1/auth/ticket",
    headers: { "Content-Type": "application/json", "X-Forwarded-For": "1.2.3.4, 5.6.7.8" },
    queryStringParameters: { a: "1" },
    body: Buffer.from('{"ticket":"x"}').toString("base64"),
    isBase64Encoded: true,
  });
  assert.equal(request.method, "POST");
  assert.equal(request.path, "/v1/auth/ticket");
  assert.equal(request.headers["content-type"], "application/json");
  assert.equal(request.ip, "1.2.3.4");
  assert.equal(request.query.get("a"), "1");
  assert.equal(request.body.toString("utf8"), '{"ticket":"x"}');
  assert.equal(normalizePath("/v1/me/"), "/v1/me");
  assert.equal(normalizePath("/"), "/");

  assert.deepEqual(toFunctionResult({ status: 200, headers: { "content-type": "text/plain" }, body: "ok" }), {
    statusCode: 200,
    headers: { "content-type": "text/plain" },
    body: "ok",
    isBase64Encoded: false,
  });
});
