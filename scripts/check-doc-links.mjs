#!/usr/bin/env node
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

import { execFileSync } from "node:child_process";
import { readFile, stat } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import MarkdownIt from "markdown-it";

const markdown = new MarkdownIt({ html: true, linkify: false });
const externalTarget = /^(?:[a-z][a-z\d+.-]*:|\/\/|\/)/iu;

function trackedDocumentationFiles(repositoryRoot) {
  const output = execFileSync(
    "git",
    [
      "ls-files",
      "--",
      "README.md",
      "README_zh.md",
      "CONTRIBUTING.md",
      ":(glob)docs/**/*.md",
    ],
    { cwd: repositoryRoot, encoding: "utf8" },
  );
  return output.trim().split("\n").filter(Boolean);
}

function visit(tokens, callback) {
  for (const token of tokens) {
    callback(token);
    if (token.children) visit(token.children, callback);
  }
}

function localTargets(source) {
  const targets = [];
  visit(markdown.parse(source, {}), (token) => {
    if (token.type === "link_open") targets.push({ kind: "link", target: token.attrGet("href") });
    if (token.type === "image") targets.push({ kind: "image", target: token.attrGet("src") });

    if (token.type === "html_block" || token.type === "html_inline") {
      for (const match of token.content.matchAll(/<(a|img)\b[^>]*?\b(?:href|src)\s*=\s*["']([^"']+)["']/giu)) {
        targets.push({ kind: match[1].toLowerCase() === "img" ? "image" : "link", target: match[2] });
      }
    }
  });
  return targets.filter(({ target }) => target && !externalTarget.test(target));
}

function targetPath(repositoryRoot, sourceFile, target) {
  const pathPart = target.split("#", 1)[0].split("?", 1)[0];
  if (!pathPart) return resolve(repositoryRoot, sourceFile);
  try {
    return resolve(repositoryRoot, dirname(sourceFile), decodeURIComponent(pathPart));
  } catch {
    return undefined;
  }
}

export async function findBrokenDocumentationTargets(repositoryRoot, files) {
  const failures = [];
  for (const sourceFile of files) {
    const source = await readFile(resolve(repositoryRoot, sourceFile), "utf8");
    for (const { kind, target } of localTargets(source)) {
      const resolved = targetPath(repositoryRoot, sourceFile, target);
      if (!resolved) {
        failures.push({ kind, sourceFile, target, reason: "invalid URL encoding" });
        continue;
      }
      try {
        await stat(resolved);
      } catch {
        failures.push({ kind, sourceFile, target, reason: "target does not exist" });
      }
    }
  }
  return failures;
}

async function main() {
  const repositoryRoot = process.cwd();
  const files = trackedDocumentationFiles(repositoryRoot);
  const failures = await findBrokenDocumentationTargets(repositoryRoot, files);
  if (failures.length > 0) {
    for (const failure of failures) {
      console.error(`${failure.sourceFile}: broken ${failure.kind} '${failure.target}' (${failure.reason})`);
    }
    process.exitCode = 1;
    return;
  }
  console.log(`Documentation links passed (${files.length} Markdown files checked).`);
}

if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) await main();
