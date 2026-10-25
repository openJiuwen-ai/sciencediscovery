// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import assert from "node:assert/strict";
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { SourcePreview } from "../src/SourcePreview.js";
import { readPreviewText, SOURCE_PREVIEW_LIMIT, sourceLanguage } from "../src/source-preview.js";

for (const [extensions, language, sample] of [
  ["txt log out err unknown", "plaintext", "hello"],
  ["py", "python", "def score():\n    return 42"],
  ["r R", "r", "function(x) { return(42) }"],
  ["jl", "julia", "function score()\n return 42\nend"],
  ["js jsx", "javascript", "const score = 42;"],
  ["ts tsx", "typescript", "const score: number = 42;"],
  ["sh bash", "bash", 'echo "done"'],
  ["sql", "sql", "SELECT count(*) FROM results;"],
  ["c h", "c", "int score = 42;"],
  ["cpp", "cpp", "int score = 42;"],
  ["java", "java", "public class Score {}"],
  ["go", "go", "func score() int { return 42 }"],
  ["rs", "rust", "fn score() -> i32 { 42 }"],
  ["json", "json", '{"score": 42}'],
  ["yaml yml", "yaml", "score: 42"],
  ["toml ini", "ini", '[model]\nname = "test"'],
  ["xml html", "xml", '<result value="42" />'],
  ["css", "css", ".result { color: red; }"],
  ["md", "markdown", "# Results"],
  ["tex", "latex", "\\section{Results}"],
] as const) {
  test(`${extensions}: chooses ${language} and renders the registered grammar`, () => {
    for (const extension of extensions.split(" ")) {
      assert.equal(sourceLanguage(`results/analysis.${extension}`), language);
      const html = renderToStaticMarkup(createElement(SourcePreview, { name: `analysis.${extension}`, source: sample }));
      assert.match(html, new RegExp(`data-language="${language}"`));
      if (language !== "plaintext") assert.match(html, /class="hljs-/);
    }
  });
}

test("multiline tokens, blank lines and CRLF retain logical line numbers", () => {
  const html = renderToStaticMarkup(createElement(SourcePreview, { language: "python", source: 'text = """first\r\n\r\nlast"""\r\n' }));
  assert.deepEqual([...html.matchAll(/class="source-line-number">(\d+)</g)].map((match) => match[1]), ["1", "2", "3", "4"]);
  assert.match(html, /class="hljs-string">last/);
  assert.match(html, /aria-hidden="true" class="source-line-number"/);
});

test("uploaded markup stays inert, including in the plaintext fallback", () => {
  for (const name of ["untrusted.html", "untrusted.unknown"]) {
    const html = renderToStaticMarkup(createElement(SourcePreview, { name, source: '<script>alert("x")</script>' }));
    assert.doesNotMatch(html, /<script>/);
    assert.match(html, /&lt;/);
  }
});

test("empty files have a readable empty state and line 1", () => {
  const html = renderToStaticMarkup(createElement(SourcePreview, { source: "" }));
  assert.match(html, /This file is empty/);
  assert.match(html, /source-line-number">1</);
});

test("oversized previews stop at the character cap and explain full-file download", () => {
  const html = renderToStaticMarkup(createElement(SourcePreview, { source: "x".repeat(SOURCE_PREVIEW_LIMIT) + "HIDDEN_SUFFIX" }));
  assert.match(html, /Preview truncated at 100,000 characters; use Download to read the full file/);
  assert.doesNotMatch(html, /HIDDEN_SUFFIX/);
  assert.ok(html.includes("x".repeat(SOURCE_PREVIEW_LIMIT)));
});

test("unknown names and empty UTF-8 files are readable without a catalog kind", async () => {
  assert.equal(await readPreviewText(new Blob(["未知格式\nhello"]), "output.unknown"), "未知格式\nhello");
  assert.equal(await readPreviewText(new Blob([]), "empty.txt"), "");
  assert.equal(sourceLanguage("output.unknown", "application/json; charset=utf-8"), "json");
});

test("binary metadata prevents decoding images, PDFs and Office documents", async () => {
  const blob = new Blob(["ASCII bytes"]);
  blob.slice = () => { throw new Error("Binary metadata must be checked before reading bytes"); };
  for (const name of ["figure.png", "vector.svg", "report.pdf", "table.xlsx", "archive.zip", "weights.npy"]) {
    assert.equal(await readPreviewText(blob, name), undefined, name);
  }
  for (const type of ["image/png", "application/pdf", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"]) {
    assert.equal(await readPreviewText(blob, "unknown", type), undefined, type);
  }
});

test("unknown binary bytes do not become replacement characters in the viewer", async () => {
  for (const bytes of [[0xff, 0xfe, 0x41], [0x61, 0, 0x62], [0x61, 1, 0x62]]) {
    assert.equal(await readPreviewText(new Blob([new Uint8Array(bytes)]), "unknown.bin"), undefined);
  }
});

test("bounded decoding tolerates a UTF-8 character crossing the sample boundary", async () => {
  const prefix = "x".repeat(SOURCE_PREVIEW_LIMIT * 4 + 3);
  const text = await readPreviewText(new Blob([prefix, "中文后缀"]), "large.txt");
  assert.equal(text, prefix);
});
