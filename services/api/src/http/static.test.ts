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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import fs, { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { ServerResponse } from "node:http";
import { syncBuiltinESMExports } from "node:module";
import path from "node:path";
import type { TestContext } from "node:test";

import { serveStatic } from "./static.js";

type PathMode = "native" | "win32";
const INDEX = "<h1>Static test</h1>";
const BUNDLE = "console.log('static test');";

async function staticFixture(context: TestContext, mode: PathMode, withIndex = true) {
  await mkdir(".tmp", { recursive: true });
  const root = await mkdtemp(path.resolve(".tmp/static-"));
  let staticDir = path.join(root, "static");
  const hostResolve = path.resolve;
  const hostReadFile = readFile;
  const hostStat = stat;
  const hostSep = path.sep;
  context.after(async () => {
    context.mock.restoreAll();
    Object.defineProperty(path, "sep", { value: hostSep });
    syncBuiltinESMExports();
    await rm(root, { recursive: true, force: true });
  });
  await mkdir(path.join(staticDir, "assets"), { recursive: true });
  await mkdir(path.join(staticDir, "..data"));
  await mkdir(path.join(root, "static-sibling"));
  if (withIndex) await writeFile(path.join(staticDir, "index.html"), INDEX);
  await writeFile(path.join(staticDir, "assets", "app.js"), BUNDLE);
  await writeFile(path.join(staticDir, "..data", "keep.txt"), "legitimate data");
  await writeFile(path.join(root, "escape.txt"), "outside secret");
  await writeFile(path.join(root, "static-sibling", "escape.txt"), "sibling secret");
  let hostPath = (filename: string) => filename;
  if (mode === "win32") {
    // Exercise Windows path semantics while translating only filesystem I/O to host files.
    const windowsRoot = "C:\\static-fixture";
    hostPath = (filename: string) => hostResolve(root, ...path.win32.relative(windowsRoot, filename).split("\\"));
    for (const method of ["resolve", "relative", "isAbsolute", "extname"] as const) {
      context.mock.method(path, method, path.win32[method]);
    }
    Object.defineProperty(path, "sep", { value: path.win32.sep });
    staticDir = path.win32.join(windowsRoot, "static");
  }
  const statCalls = context.mock.method(fs, "stat", (filename: string) => hostStat(hostPath(filename)));
  const readCalls = context.mock.method(fs, "readFile", (filename: string) => hostReadFile(hostPath(filename)));
  syncBuiltinESMExports();
  return { staticDir, statCalls, readCalls };
}

async function requestStatic(staticDir: string, pathname: string) {
  const result = { status: 0, contentType: "", body: "" };
  const response = {
    writeHead(status: number, headers: Record<string, string | number>) {
      result.status = status;
      result.contentType = String(headers["content-type"]);
    },
    end(body: string | Buffer) {
      result.body = body.toString();
    },
  } as unknown as ServerResponse;
  await serveStatic(response, staticDir, pathname);
  return result;
}

for (const mode of ["native", "win32"] as const) {
  test(`${mode}: serves the index, nested assets and dot-prefixed directory names`, async (context) => {
    const { staticDir } = await staticFixture(context, mode);
    for (const [pathname, body, contentType] of [
      ["/", INDEX, "text/html; charset=utf-8"],
      ["/assets/app.js", BUNDLE, "text/javascript; charset=utf-8"],
      ["/..data/keep.txt", "legitimate data", "text/plain; charset=utf-8"],
    ] as const) {
      assert.deepEqual(await requestStatic(staticDir, pathname), { status: 200, contentType, body }, pathname);
    }
  });

  test(`${mode}: rejects plain and encoded escapes without reading outside files`, async (context) => {
    const { staticDir, statCalls, readCalls } = await staticFixture(context, mode);
    const paths = [
      "/../escape.txt",
      "/%2e%2e/escape.txt",
      "/..",
      "/../static-sibling/escape.txt",
      `/${encodeURIComponent(path.resolve(staticDir, "..", "escape.txt"))}`,
    ];
    if (mode === "win32") paths.push("/..%5cescape.txt", "/D:/escape.txt", "/%5c%5cserver%5cshare%5cescape.txt");
    for (const pathname of paths) {
      assert.deepEqual(await requestStatic(staticDir, pathname), {
        status: 400,
        contentType: "application/json; charset=utf-8",
        body: '{"error":"Invalid path"}\n',
      }, pathname);
    }
    assert.equal(statCalls.mock.callCount(), 0);
    assert.equal(readCalls.mock.callCount(), 0);
  });

  test(`${mode}: keeps SPA route and directory fallback behavior`, async (context) => {
    const { staticDir } = await staticFixture(context, mode);
    for (const pathname of ["/projects/example", "/missing.js", "/assets/"]) {
      assert.deepEqual(await requestStatic(staticDir, pathname), {
        status: 200,
        contentType: "text/html; charset=utf-8",
        body: INDEX,
      }, pathname);
    }
  });

  test(`${mode}: serves the built-in page when no web index exists`, async (context) => {
    const { staticDir } = await staticFixture(context, mode, false);
    const result = await requestStatic(staticDir, "/");
    assert.equal(result.status, 200);
    assert.equal(result.contentType, "text/html; charset=utf-8");
    assert.match(result.body, /ScienceDiscovery API is running/);
  });
}
