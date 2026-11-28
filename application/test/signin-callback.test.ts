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

import test from "node:test";
import assert from "node:assert/strict";

import { startSignInCallbackServer } from "../src/signin-callback.ts";

type Results = Array<{ ticket?: string; error?: string }>;

/** The per-flow result URL the served page posts to. */
function resultUrlOf(callbackUrl: string): string {
  return callbackUrl.replace("/callback/", "/result/");
}

test("the loopback callback URL serves the browser page", async () => {
  const server = await startSignInCallbackServer({ onResult: () => {} });
  try {
    assert.match(server.callbackUrl, /^http:\/\/127\.0\.0\.1:\d+\/callback\/[A-Za-z0-9_-]{20,}$/u);
    const response = await fetch(server.callbackUrl);
    assert.equal(response.status, 200);
    assert.match(response.headers.get("content-type") ?? "", /text\/html/u);
    // The page is a one-shot bridge: nothing may frame it or leak the fragment.
    assert.equal(response.headers.get("x-frame-options"), "DENY");
    const page = await response.text();
    assert.match(page, /auth-ticket/u);
    assert.match(page, /\/result\//u);
    // The copy is bilingual: the system browser's language is unknown here.
    assert.match(page, /正在确认登录/u);
    assert.match(page, /Signing you in/u);
  } finally {
    server.stop();
  }
});

test("a posted ticket reaches the shell once", async () => {
  const results: Results = [];
  const server = await startSignInCallbackServer({ onResult: (result) => results.push(result) });
  try {
    const response = await fetch(resultUrlOf(server.callbackUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: "t-1" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(results, [{ ticket: "t-1" }]);
  } finally {
    server.stop();
  }
});

test("a posted error is delivered without a ticket", async () => {
  const results: Results = [];
  const server = await startSignInCallbackServer({ onResult: (result) => results.push(result) });
  try {
    const response = await fetch(resultUrlOf(server.callbackUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ error: "access_denied" }),
    });
    assert.equal(response.status, 200);
    assert.deepEqual(results, [{ error: "access_denied" }]);
  } finally {
    server.stop();
  }
});

test("a body without a result is rejected", async () => {
  const results: Results = [];
  const server = await startSignInCallbackServer({ onResult: (result) => results.push(result) });
  try {
    const response = await fetch(resultUrlOf(server.callbackUrl), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({}),
    });
    assert.equal(response.status, 400);
    assert.deepEqual(results, []);
  } finally {
    server.stop();
  }
});

test("a post to another flow's result URL cannot settle this one", async () => {
  const results: Results = [];
  const server = await startSignInCallbackServer({ onResult: (result) => results.push(result) });
  try {
    const foreign = server.callbackUrl.replace(/\/callback\/[^/]+$/u, "/result/not-this-flow");
    const response = await fetch(foreign, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ ticket: "attacker-ticket" }),
    });
    assert.equal(response.status, 404);
    assert.deepEqual(results, []);
  } finally {
    server.stop();
  }
});

test("a cross-site plain-text post cannot settle the flow", async () => {
  const results: Results = [];
  const server = await startSignInCallbackServer({ onResult: (result) => results.push(result) });
  try {
    // `text/plain` is a CORS-simple type: a cross-origin page can send it
    // without a preflight, which is why the content type is checked.
    const response = await fetch(resultUrlOf(server.callbackUrl), {
      method: "POST",
      headers: { "content-type": "text/plain" },
      body: JSON.stringify({ ticket: "attacker-ticket" }),
    });
    assert.equal(response.status, 415);
    assert.deepEqual(results, []);
  } finally {
    server.stop();
  }
});

test("a post from another origin is refused", async () => {
  const results: Results = [];
  const server = await startSignInCallbackServer({ onResult: (result) => results.push(result) });
  try {
    const response = await fetch(resultUrlOf(server.callbackUrl), {
      method: "POST",
      headers: { "content-type": "application/json", origin: "https://attacker.example" },
      body: JSON.stringify({ ticket: "attacker-ticket" }),
    });
    assert.equal(response.status, 403);
    assert.deepEqual(results, []);
  } finally {
    server.stop();
  }
});
