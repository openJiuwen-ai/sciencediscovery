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
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
// The runner compiles JSX with the classic runtime, so React has to be in scope.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SearchHitIcon, hitIcon } from "../src/views/search-hit-icons.js";

test("a hit takes the mark of what it is", () => {
  assert.equal(hitIcon("project"), "folder");
  assert.equal(hitIcon("session"), "bubble");
  assert.equal(hitIcon("artifact", "out/figure.png"), "image");
  assert.equal(hitIcon("artifact", "src/train.py"), "code");
  assert.equal(hitIcon("artifact", "out/config.json"), "json");
  assert.equal(hitIcon("artifact", "out/summary.md"), "doc");
  assert.equal(hitIcon("artifact", "out/results.csv"), "sheet");
  assert.equal(hitIcon("artifact", "out/deck.pptx"), "slides");
});

test("an artifact of no known kind is a plain file, not a guess", () => {
  assert.equal(hitIcon("artifact", "out/notes.xyz"), "file");
  assert.equal(hitIcon("artifact", "out/README"), "file");
  assert.equal(hitIcon("artifact"), "file");
  assert.equal(hitIcon("artifact", "out/archive.tar.gz"), "file");
});

test("the suffix is read without case, and the folder in the path is not the name", () => {
  assert.equal(hitIcon("artifact", "out/FIGURE.PNG"), "image");
  assert.equal(hitIcon("artifact", "png/notes"), "file");
});

test("the mark is drawn as the kind's own glyph", () => {
  const session = renderToStaticMarkup(<SearchHitIcon kind="session" />);
  const project = renderToStaticMarkup(<SearchHitIcon kind="project" />);
  assert.match(session, /class="search-hit-icon"/u);
  assert.notEqual(session, project, "a Session and a Project are not the same mark");
  const image = renderToStaticMarkup(<SearchHitIcon kind="artifact" path="out/figure.png" />);
  const plain = renderToStaticMarkup(<SearchHitIcon kind="artifact" path="out/notes.xyz" />);
  assert.notEqual(image, plain, "an image does not read as an unknown file");
});
