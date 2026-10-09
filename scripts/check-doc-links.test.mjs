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
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createTest } from "../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { findBrokenDocumentationTargets } from "./check-doc-links.mjs";

test("documentation target check accepts local files, anchors, and external URLs", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "science-doc-links-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "docs", "guide"), { recursive: true });
  await writeFile(join(root, "docs", "asset.png"), "asset");
  await writeFile(
    join(root, "docs", "guide", "page.md"),
    "[self](#section) [asset](../asset.png) [web](https://example.com)\n",
  );

  assert.deepEqual(await findBrokenDocumentationTargets(root, ["docs/guide/page.md"]), []);
});

test("documentation target check reports missing Markdown and HTML targets", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "science-doc-links-"));
  t.after(() => rm(root, { force: true, recursive: true }));
  await mkdir(join(root, "docs"), { recursive: true });
  await writeFile(
    join(root, "docs", "page.md"),
    "[missing](missing.md)\n<img src=\"missing.png\" alt=\"missing\">\n",
  );

  const failures = await findBrokenDocumentationTargets(root, ["docs/page.md"]);
  assert.deepEqual(
    failures.map(({ kind, target }) => ({ kind, target })),
    [
      { kind: "link", target: "missing.md" },
      { kind: "image", target: "missing.png" },
    ],
  );
});
