// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";

import { checkComponentBoundaries, importsOf } from "./component-boundaries.mjs";

const component = (name, extra = {}) => ({ name: `@sciencediscovery/${name}`, directory: `packages/${name}`,
  exports: { ".": { types: "./src/index.ts" }, "./web": { types: "./src/web.tsx" } }, ...extra });
const a = component("a"), b = component("b");
const host = component("api", { directory: "services/api", exports: { ".": { types: "./src/index.ts" } } });
function check(extra, manifests = [a, b, host]) {
  return checkComponentBoundaries(manifests, new Map([
    ["packages/a/src/index.ts", "export interface Port { run(): void }"],
    ["packages/b/src/index.ts", "export const value = 1"],
    ["packages/a/src/web.tsx", "export const view = 'a'"],
    ["packages/b/src/web.tsx", "export const view = 'b'"],
    ...Object.entries(extra),
  ]));
}
test("host injects a callback without a reverse source dependency", () => {
  assert.deepEqual(check({ "services/api/src/index.ts": 'import type { Port } from "@sciencediscovery/a"; const port: Port = {run() {}};' }), []);
});
test("static, dynamic, require, re-export and type imports cannot reach the host", () => {
  for (const source of [
    'import { x } from "@sciencediscovery/api";',
    'export * from "../../../services/api/src/index.js";',
    'const x = import("@sciencediscovery/api");',
    'const x = require("@sciencediscovery/api");',
    'type X = import("@sciencediscovery/api").X;',
  ]) assert.match(check({ "packages/a/src/index.ts": source }).join("\n"), /packages must not/);
});
test("cycles include type-only source imports and manifest dependencies", () => {
  assert.match(check({
    "packages/a/src/index.ts": 'import type { B } from "@sciencediscovery/b";',
    "packages/b/src/index.ts": 'export type { Port } from "@sciencediscovery/a";',
  }).join("\n"), /dependency cycle/);
  assert.match(check({}, [component("a", {dependencies:{[b.name]:"workspace:*"}}), component("b", {devDependencies:{[a.name]:"workspace:*"}})]).join("\n"), /dependency cycle/);
});
test("private and cross-package relative imports are rejected", () => {
  assert.match(check({"packages/a/src/index.ts": 'import { value } from "@sciencediscovery/b/src/index.ts";'}).join("\n"), /non-public/);
  assert.match(check({"packages/a/src/index.ts": 'import { value } from "../../b/src/index.js";'}).join("\n"), /cross-package relative/);
});
test("browser traversal follows helper re-exports and workspace package exports", () => {
  assert.match(check({
    "packages/a/src/web.tsx": 'export { value } from "./helper.js";',
    "packages/a/src/helper.ts": 'export { value } from "@sciencediscovery/b";',
    "packages/b/src/index.ts": 'import fs from "node:fs"; export const value = fs;',
  }).join("\n"), /browser entry reaches Node builtin node:fs/);
});
test("browser type imports are erased but comments are not imports", () => {
  assert.deepEqual(check({
    "packages/a/src/web.tsx": 'import type { value } from "@sciencediscovery/b"; // import fs from "node:fs"',
    "packages/b/src/index.ts": 'import fs from "node:fs"; export const value = fs;',
  }), []);
  assert.deepEqual(importsOf("example.ts", 'const text = "import fs from node:fs";'), []);
});
test("manifest-only package to host dependency is rejected", () => {
  assert.match(check({}, [component("a", { dependencies: {[host.name]:"workspace:*"} }), b, host]).join("\n"), /packages must not/);
});
test("legacy allowance is exact and never suppresses cycles or new files", () => {
  const sources = new Map([
    ["packages/a/src/index.ts", 'import "@sciencediscovery/api";'],
    ["packages/a/src/new.ts", 'import "@sciencediscovery/api";'],
    ["services/api/src/index.ts", 'import "@sciencediscovery/a";'],
  ]);
  const result = checkComponentBoundaries([a, host], sources, [{from:a.name,to:host.name,files:["packages/a/src/index.ts"]}]);
  assert.match(result.join("\n"), /new.ts: packages must not/);
  assert.match(result.join("\n"), /dependency cycle/);
  assert.ok(!result.some(line => line.startsWith("packages/a/src/index.ts:")));
});
