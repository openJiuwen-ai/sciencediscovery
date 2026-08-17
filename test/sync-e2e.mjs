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

import { copyFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const testDir = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(testDir, "..");
const envDir = join(repoRoot, ".e2e");
const controlledFiles = ["e2e.package.json", "e2e.package-lock.json", "playwright.config.ts"];

function targetName(sourceName) {
  if (sourceName === "e2e.package.json") return "package.json";
  if (sourceName === "e2e.package-lock.json") return "package-lock.json";
  return sourceName;
}

function staleFiles() {
  return controlledFiles.filter((name) => {
    const source = join(testDir, name);
    const target = join(envDir, targetName(name));
    return !existsSync(target) || !readFileSync(source).equals(readFileSync(target));
  });
}

const mode = process.argv[2];
if (mode === "--write") {
  mkdirSync(envDir, { recursive: true });
  for (const name of controlledFiles) {
    copyFileSync(join(testDir, name), join(envDir, targetName(name)));
  }
  console.log("Synchronized .e2e manifest, lockfile, and Playwright config. Run npm install in .e2e before testing.");
  process.exit(0);
}

if (mode !== "--check") {
  console.error("Usage: node test/sync-e2e.mjs --check|--write");
  process.exit(2);
}

const stale = staleFiles();
if (stale.length) {
  console.error(`BLOCKED: .e2e is missing or stale (${stale.join(", ")}).`);
  console.error("Run node test/sync-e2e.mjs --write, then run npm install in .e2e.");
  process.exit(1);
}

console.log(".e2e source copies are current.");
