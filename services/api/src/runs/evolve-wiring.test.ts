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
import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

// Reads the TypeScript sources, not the build output: what this guards is the
// shape of the hand-written call sites. From dist/runs/ that is three levels up
// then into src/.
const apiSource = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "src");

/**
 * `scheduleSessionRuns` takes sixteen positional arguments and every call site
 * spells them out by hand. The evolve tool deps went in last, so three of the
 * four call sites silently passed `undefined` for them — and `undefined` there
 * is not an error, it just removes `create_evolve_run` from the model's tool
 * list. Nothing fails; the feature is simply absent, and the model works around
 * it by hand-rolling a search.
 *
 * A type checker cannot catch this: the parameter is optional by design,
 * because a review subagent legitimately runs without it. So this asserts the
 * shape of the call sites instead.
 */
async function callSitesOf(file: string, callee: string): Promise<string[]> {
  const text = await readFile(resolve(apiSource, file), "utf-8");
  const sites: string[] = [];
  let at = text.indexOf(`${callee}(`);
  while (at !== -1) {
    // Skip the declaration itself.
    const before = text.slice(Math.max(0, at - 40), at);
    if (!/function\s+$/.test(before)) {
      let depth = 0;
      let end = at + callee.length;
      do {
        if (text[end] === "(") depth += 1;
        if (text[end] === ")") depth -= 1;
        end += 1;
      } while (depth > 0 && end < text.length);
      sites.push(text.slice(at, end));
    }
    at = text.indexOf(`${callee}(`, at + 1);
  }
  return sites;
}

test("every scheduleSessionRuns call site passes the evolve tool deps", async () => {
  const sites = [
    ...await callSitesOf("http/index.ts", "scheduleSessionRuns"),
    ...await callSitesOf("runs/index.ts", "scheduleSessionRuns"),
    ...await callSitesOf("bootstrap/platform.ts", "scheduleSessionRuns"),
  ];

  assert.ok(sites.length >= 4, `expected the known call sites, found ${sites.length}`);
  for (const site of sites) {
    assert.match(site, /\b(evolveToolDeps|evolve)\b/,
      `a scheduleSessionRuns call site omits the evolve deps:\n${site}`);
  }
});

test("streamAgentRun forwards the evolve tool deps too", async () => {
  const sites = await callSitesOf("http/index.ts", "streamAgentRun");

  assert.ok(sites.length >= 1);
  for (const site of sites) {
    assert.match(site, /\bevolveToolDeps\b/, `streamAgentRun omits the evolve deps:\n${site}`);
  }
});
