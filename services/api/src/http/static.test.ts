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

import { createTest } from "../../../../test/support/tagged/compat.mjs";
// No os/arch tags: the containment check must hold on every platform.
// On Windows mkdtemp hands us a backslash path, which is exactly the
// regression shape from 炸点③-11 (SPA 400 on every path).
const { test } = createTest(import.meta.url);
import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TestContext } from "node:test";

import { serveStatic } from "./static.js";

function mockResponse(): { response: ServerResponse; result: { status: number; body: string } } {
  const result = { status: 0, body: "" };
  const response = {
    writeHead(status: number) {
      result.status = status;
    },
    end(body?: string | Buffer) {
      result.body = typeof body === "string" ? body : (body ?? Buffer.alloc(0)).toString("utf8");
    },
  } as unknown as ServerResponse;
  return { response, result };
}

async function staticFixture(context: TestContext): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "sd-static-"));
  context.after(() => rm(root, { force: true, recursive: true }));
  return root;
}

test("the index page is served for the root path", async (context) => {
  const dir = await staticFixture(context);
  await writeFile(join(dir, "index.html"), "<h1>hello</h1>");
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/");

  assert.equal(result.status, 200);
  assert.equal(result.body, "<h1>hello</h1>");
});

test("a nested asset is served from inside the root", async (context) => {
  const dir = await staticFixture(context);
  await mkdir(join(dir, "assets"), { recursive: true });
  await writeFile(join(dir, "assets", "app.js"), "console.log(1)");
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/assets/app.js");

  assert.equal(result.status, 200);
  assert.equal(result.body, "console.log(1)");
});

test("a directory whose name starts with two dots is not mistaken for an escape", async (context) => {
  const dir = await staticFixture(context);
  await mkdir(join(dir, "..data"), { recursive: true });
  await writeFile(join(dir, "..data", "keep.txt"), "legit");
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/..data/keep.txt");

  assert.equal(result.status, 200);
  assert.equal(result.body, "legit");
});

test("an escape above the root is rejected with 400", async (context) => {
  const dir = await staticFixture(context);
  await writeFile(join(dir, "..", "escape.txt"), "secret");
  context.after(() => rm(join(dir, "..", "escape.txt"), { force: true }));
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/../escape.txt");

  assert.equal(result.status, 400);
});

test("a percent-encoded escape above the root is rejected with 400", async (context) => {
  const dir = await staticFixture(context);
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/%2e%2e/escape.txt");

  assert.equal(result.status, 400);
});

test("a missing asset falls back to the index page (SPA routing)", async (context) => {
  const dir = await staticFixture(context);
  await writeFile(join(dir, "index.html"), "<h1>spa</h1>");
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/no/such/route.js");

  assert.equal(result.status, 200);
  assert.equal(result.body, "<h1>spa</h1>");
});

test("without a built web package the fallback page is served", async (context) => {
  const dir = await staticFixture(context);
  const { response, result } = mockResponse();

  await serveStatic(response, dir, "/");

  assert.equal(result.status, 200);
  assert.match(result.body, /API is running/);
});
