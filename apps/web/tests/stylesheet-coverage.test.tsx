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
 * Every class the evolve screens put on an element has a rule behind it.
 *
 * This has now failed silently twice, the same way both times: a wholesale
 * block replacement in `evolve.css` swallowed neighbouring rules, the markup
 * kept referencing the class, and the element rendered bare. The correction
 * box became a two-row postage stamp; the artifact page's "把这个做得更好"
 * button was crushed by its flex row into one character per line. Nothing
 * type-checks a className against a stylesheet, no unit test renders CSS, so
 * the only detector was a person looking at the screen — the slowest and most
 * annoyed detector there is.
 *
 * The check is textual on purpose: no DOM, no build. A class is "covered" when
 * it appears as a selector token anywhere in the stylesheet bundle. That is
 * deliberately weak — it cannot see a wrong rule, only a vanished one — and a
 * vanished one is exactly the accident this exists to catch.
 */

import assert from "node:assert/strict";
import { readFileSync, readdirSync } from "node:fs";
import { dirname, join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const src = join(here, "../src");

/** The screens this guards: the evolve surfaces plus the artifact header that
 *  carries the evolve entry point. */
const COMPONENT_FILES = [
  ...readdirSync(join(src, "evolve")).filter((name) => name.endsWith(".tsx"))
    .map((name) => join(src, "evolve", name)),
  join(src, "ScientificArtifacts.tsx"),
];

/** Classes owned by surfaces other than the evolve stylesheet. The artifact
 *  modal's own chrome is styled elsewhere; this test only vouches for the
 *  classes the evolve work introduced. */
const FOREIGN = /^(?!evolve-|artifact-evolve)/;

function classesIn(source: string): string[] {
  const found = new Set<string>();
  // Literal className="a b" and the template/ternary halves that appear as
  // plain strings. Computed names the regex cannot see are not guarded — the
  // cost of guarding them would be executing the component.
  for (const match of source.matchAll(/className=(?:"([^"]+)"|\{`([^`]+)`\}|\{[^}]*?"([^"]+)"[^}]*?\})/g)) {
    for (const chunk of (match[1] ?? match[2] ?? match[3] ?? "").split(/\s+/)) {
      const name = chunk.trim().replace(/\$\{[^}]*\}/g, "").replace(/["'`]+$/, "");
      // A trailing hyphen is a template prefix (`evolve-diff-${kind}`): the
      // full names are dynamic and this check cannot vouch for them.
      if (!name || name.endsWith("-") || name.includes("$") || FOREIGN.test(name)) continue;
      found.add(name);
    }
  }
  return [...found];
}

test("every evolve class in the markup still has a rule in the stylesheet", () => {
  const stylesheet = readFileSync(join(src, "styles/evolve.css"), "utf-8");
  const missing: string[] = [];
  for (const file of COMPONENT_FILES) {
    const source = readFileSync(file, "utf-8");
    for (const name of classesIn(source)) {
      // A selector token, not a substring: `.evolve-draft` must not vouch for
      // `.evolve-draft-risks`.
      const token = new RegExp(`\\.${name.replace(/[.*+?^${}()|[\\]\\\\]/g, "\\$&")}(?![\\w-])`);
      if (!token.test(stylesheet)) missing.push(name);
    }
  }
  assert.deepEqual(
    missing.sort(),
    [],
    `这些 class 在标记里用着，样式表里却没有规则——多半又是一次整块替换把它们吞了：${missing.join(", ")}`,
  );
});
