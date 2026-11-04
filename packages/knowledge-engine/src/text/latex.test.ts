// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
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
import { gunzipSync, gzipSync } from "node:zlib";
import { combineTexFiles, extractCombinedTex, texToMarkdown, type TarEntry } from "./latex.js";

const SAMPLE_TEX = [
  "\\documentclass{article}",
  "\\newcommand{\\R}{\\mathbb{R}}",
  "\\title{Binding Affinity of mAb114}",
  "\\begin{document}",
  "",
  "\\section{Introduction}",
  "The antibody binds GP \\cite{corti2016, murin2014} with high affinity in $\\R$ space.",
  "% a comment line that must vanish",
  "",
  "\\begin{equation}",
  "K_d = \\frac{k_{off}}{k_{on}} \\label{eq:kd}",
  "\\end{equation}",
  "",
  "\\begin{figure}",
  "\\caption{Structure of the GP trimer}",
  "\\end{figure}",
  "",
  "\\section*{Results}",
  "\\textbf{Strong} neutralization \\citep{corti2016}.",
  "\\end{document}",
].join("\n");

test("texToMarkdown: headings, cite anchors, math, captions, macros", () => {
  const markdown = texToMarkdown(SAMPLE_TEX);
  // Title becomes the top heading.
  assert.match(markdown, /^# Binding Affinity of mAb114/);
  // Sectioning → markdown headings.
  assert.match(markdown, /## Introduction/);
  // \cite → [@key] anchors (the W10 chain input), multi-key expands.
  assert.match(markdown, /\[@corti2016\] \[@murin2014\]/);
  // Custom macro expanded inside inline math.
  assert.match(markdown, /\$\\mathbb\{R\}\$/);
  // equation env → $$ with \label stripped.
  assert.match(markdown, /\$\$\nK_d = \\frac\{k_\{off\}\}\{k_\{on\}\}\n\$\$/);
  assert.equal(markdown.includes("\\label{eq:kd}"), false);
  // Figure caption kept, figure scaffolding dropped.
  assert.match(markdown, /\*\*\[figure\]\*\* Structure of the GP trimer/);
  // Comments stripped.
  assert.equal(markdown.includes("a comment line"), false);
  // Inline formatting survives.
  assert.match(markdown, /\*\*Strong\*\* neutralization/);
  // \citep (natbib) also anchors.
  assert.match(markdown, /\[@corti2016\]/);
});

test("texToMarkdown: align normalizes to aligned inside $$", () => {
  const markdown = texToMarkdown([
    "\\documentclass{article}",
    "\\begin{document}",
    "\\begin{align}",
    "a &= b \\\\",
    "c &= d",
    "\\end{align}",
    "\\end{document}",
  ].join("\n"));
  assert.match(markdown, /\$\$\n\\begin\{aligned\}[\s\S]*\\end\{aligned\}\n\$\$/);
});

function tarEntry(name: string, data: string): Buffer {
  const content = Buffer.from(data, "utf8");
  const header = Buffer.alloc(512);
  header.write(name.slice(0, 99), 0, "latin1");
  header.write(content.length.toString(8).padStart(11, "0") + "\0", 124, "latin1");
  header.write("0", 156, "latin1");
  header.write("ustar\0", 257, "latin1");
  // Checksum: spaces during computation, then octal.
  header.fill(" ", 148, 156);
  const sum = header.reduce((acc, byte) => acc + byte, 0);
  header.write(sum.toString(8).padStart(6, "0") + "\0 ", 148, "latin1");
  const padded = Buffer.alloc(Math.ceil(content.length / 512) * 512);
  content.copy(padded);
  return Buffer.concat([header, padded]);
}

test("combineTexFiles inlines \\input across root/main-relative paths", () => {
  const files: TarEntry[] = [
    { name: "paper/main.tex", data: Buffer.from("\\documentclass{article}\\begin{document}\\input{intro}\\input{paper/methods}\\end{document}", "utf8") },
    { name: "intro.tex", data: Buffer.from("\nIntro content.\n", "utf8") },
    { name: "paper/methods.tex", data: Buffer.from("\nMethods content.\n", "utf8") },
  ];
  const combined = combineTexFiles(files);
  assert.ok(combined);
  assert.match(combined!, /Intro content\./);
  assert.match(combined!, /Methods content\./);
  assert.equal(combined!.includes("\\input{intro}"), false);
});

test("extractCombinedTex handles tarball, single gzipped tex, and rejects non-tex", () => {
  const tarball = Buffer.concat([
    tarEntry("main.tex", "\\documentclass{article}\\begin{document}Body.\\end{document}"),
    Buffer.alloc(1024), // end-of-archive zeros
  ]);
  const fromTar = extractCombinedTex(gzipSync(tarball));
  assert.match(fromTar!, /Body\./);

  const single = extractCombinedTex(gzipSync(Buffer.from("\\documentclass{article}\\begin{document}Solo.\\end{document}", "utf8")));
  assert.match(single!, /Solo\./);

  const uncompressedTar = extractCombinedTex(tarball);
  assert.match(uncompressedTar!, /Body\./);

  assert.equal(extractCombinedTex(Buffer.from("not a tex document at all", "utf8")), null);
  assert.equal(extractCombinedTex(gzipSync(Buffer.concat([tarEntry("plot.py", "print(1)"), Buffer.alloc(1024)]))), null);
});
