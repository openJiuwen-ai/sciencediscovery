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

// Print the content digest of a directory tree, as recorded in the payload
// manifest for the pinned deer-flow commit. This is the same implementation
// the launcher uses to verify a download or manual placement at first launch
// (services/launcher/src/content-digest.ts), so the two sides cannot drift.
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repositoryRoot = resolve(fileURLToPath(import.meta.url), "../../..");
const { digestTree } = await import(
  `${repositoryRoot}/services/launcher/dist/content-digest.js`
);

const target = process.argv[2];
if (!target) {
  process.stderr.write("Usage: digest-tree.mjs <directory>\n");
  process.exit(2);
}
process.stdout.write(`${await digestTree(resolve(target))}\n`);
