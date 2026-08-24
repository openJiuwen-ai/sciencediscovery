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
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, test } from "node:test";

import { migrateLegacyDirectory } from "./directory-migration.js";

const temporaryRoots: string[] = [];

afterEach(async () => {
  await Promise.all(temporaryRoots.splice(0).map((path) => rm(path, { force: true, recursive: true })));
});

async function temporaryRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "science-discovery-migration-"));
  temporaryRoots.push(root);
  return root;
}

describe("legacy directory migration", () => {
  test("moves a legacy directory once and logs the import", async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, "science-agent-data");
    const targetPath = join(root, ".sciencediscovery-data");
    await mkdir(legacyPath);
    await writeFile(join(legacyPath, "state.json"), "legacy");
    const messages: string[] = [];

    await migrateLegacyDirectory({
      label: "runtime data",
      legacyPath,
      targetPath,
      log: (message) => messages.push(message),
    });
    await migrateLegacyDirectory({
      label: "runtime data",
      legacyPath,
      targetPath,
      log: (message) => messages.push(message),
    });

    assert.equal(await readFile(join(targetPath, "state.json"), "utf8"), "legacy");
    assert.equal(messages.length, 1);
    assert.match(messages[0] as string, /Imported legacy runtime data/);
  });

  test("does not overwrite an existing target and logs the skip", async () => {
    const root = await temporaryRoot();
    const legacyPath = join(root, "science-agent");
    const targetPath = join(root, "science-discovery");
    await mkdir(legacyPath);
    await mkdir(targetPath);
    await writeFile(join(legacyPath, "payload"), "legacy");
    await writeFile(join(targetPath, "payload"), "current");
    const messages: string[] = [];

    await migrateLegacyDirectory({
      label: "payload cache",
      legacyPath,
      targetPath,
      log: (message) => messages.push(message),
    });

    assert.equal(await readFile(join(targetPath, "payload"), "utf8"), "current");
    assert.equal(await readFile(join(legacyPath, "payload"), "utf8"), "legacy");
    assert.equal(messages.length, 1);
    assert.match(messages[0] as string, /Skipped importing legacy payload cache/);
  });
});
