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
import test from "node:test";

import {
  addImportPreset,
  loadImportPresets,
  saveImportPresets,
  type SkillGitImportPreset,
} from "../src/skill-import-presets.js";
import { SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY } from "../src/browser-storage.js";

function fakeStorage(initial: Record<string, string> = {}) {
  const entries = new Map(Object.entries(initial));
  return {
    entries,
    getItem: (key: string) => entries.get(key) ?? null,
    setItem: (key: string, value: string) => { entries.set(key, value); },
    removeItem: (key: string) => { entries.delete(key); },
  };
}

test("loads an empty preset list from clean or corrupted storage", () => {
  assert.deepEqual(loadImportPresets(fakeStorage()), []);
  assert.deepEqual(loadImportPresets(fakeStorage({
    [SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY]: "not json",
  })), []);
  assert.deepEqual(loadImportPresets(fakeStorage({
    [SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY]: JSON.stringify({ nope: true }),
  })), []);
});

test("sanitizes stored presets and drops entries without a repository URL", () => {
  const storage = fakeStorage({
    [SKILL_GIT_IMPORT_PRESETS_STORAGE_KEY]: JSON.stringify([
      { label: "  Science Skills  ", repositoryUrl: " https://example.com/a.git " },
      { label: "no url" },
      42,
      null,
      { repositoryUrl: "https://example.com/b.git", ref: "  ", subdirectory: " skills " },
    ]),
  });
  assert.deepEqual(loadImportPresets(storage), [
    { label: "Science Skills", repositoryUrl: "https://example.com/a.git" },
    { label: "https://example.com/b.git", repositoryUrl: "https://example.com/b.git", subdirectory: "skills" },
  ]);
});

test("addImportPreset moves the entry to the front and caps the list at ten", () => {
  const storage = fakeStorage();
  for (let index = 0; index < 12; index += 1) {
    const next = addImportPreset(storage, { label: `repo-${index}`, repositoryUrl: `https://example.com/${index}.git` });
    assert.equal(next.length, Math.min(index + 1, 10));
    assert.equal(next[0]!.repositoryUrl, `https://example.com/${index}.git`);
  }
  const stored: SkillGitImportPreset[] = loadImportPresets(storage);
  assert.equal(stored.length, 10);
  assert.equal(stored[0]!.repositoryUrl, "https://example.com/11.git");
  assert.equal(stored[9]!.repositoryUrl, "https://example.com/2.git");
  assert.ok(!stored.some((preset) => preset.repositoryUrl === "https://example.com/1.git"));

  const rePromoted = addImportPreset(storage, { label: "old friend", repositoryUrl: "https://example.com/5.git" });
  assert.equal(rePromoted.length, 10);
  assert.equal(rePromoted[0]!.repositoryUrl, "https://example.com/5.git");
  assert.equal(rePromoted.filter((preset) => preset.repositoryUrl === "https://example.com/5.git").length, 1);
});

test("saveImportPresets survives a rejecting storage", () => {
  const rejecting = {
    getItem: () => null,
    setItem: () => { throw new Error("quota exceeded"); },
  };
  saveImportPresets(rejecting, [{ label: "kept", repositoryUrl: "https://example.com/kept.git" }]);
  assert.deepEqual(loadImportPresets(rejecting), []);
});
