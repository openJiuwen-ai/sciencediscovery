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


import { strFromU8, unzipSync } from "fflate";

import { setActiveLocale, translate } from "../src/i18n/index.js";
import {
  createSkillFolderArchive,
  MAX_SKILL_FOLDER_ARCHIVE_BYTES,
  MAX_SKILL_FOLDER_EXTRACTED_BYTES,
  MAX_SKILL_FOLDER_FILES,
} from "../src/skill-folder-import.js";

function folderFile(path: string, content: string): File {
  const file = new File([content], path.split("/").at(-1)!, { type: "text/plain" });
  Object.defineProperty(file, "webkitRelativePath", { value: path });
  return file;
}

test("packages a selected Skill folder with its relative paths intact", async () => {
  const archive = await createSkillFolderArchive([
    folderFile("portable-skill/SKILL.md", "---\nname: portable-skill\ndescription: Portable.\n---\n\n# Instructions\n"),
    folderFile("portable-skill/references/guide.md", "Reference text"),
    folderFile("portable-skill/scripts/inspect.py", "print('ok')"),
  ]);
  const files = unzipSync(new Uint8Array(await archive.arrayBuffer()));

  assert.equal(archive.name, "portable-skill.zip");
  assert.deepEqual(Object.keys(files).sort(), [
    "portable-skill/SKILL.md",
    "portable-skill/references/guide.md",
    "portable-skill/scripts/inspect.py",
  ]);
  assert.equal(strFromU8(files["portable-skill/references/guide.md"]!), "Reference text");
});

test("rejects folders without a root SKILL.md or with multiple roots", async () => {
  await assert.rejects(
    createSkillFolderArchive([folderFile("portable-skill/references/guide.md", "Reference text")]),
    /must contain SKILL\.md at its root/,
  );
  await assert.rejects(createSkillFolderArchive([
    folderFile("first/SKILL.md", "first"),
    folderFile("second/guide.md", "second"),
  ]), /exactly one Skill folder/);
});

test("tells a Chinese reader why a folder was refused, in Chinese", async (context) => {
  setActiveLocale("zh-CN");
  context.after(() => setActiveLocale("en"));
  // The file name is what the reader has to act on, so it survives translation.
  await assert.rejects(
    createSkillFolderArchive([folderFile("portable-skill/references/guide.md", "Reference text")]),
    (error: Error) => error.message === "所选文件夹的根目录下必须有 SKILL.md。",
  );
  await assert.rejects(createSkillFolderArchive([
    folderFile("first/SKILL.md", "first"),
    folderFile("second/guide.md", "second"),
  ]), (error: Error) => error.message === "请只选择一个 Skill 文件夹。");
  await assert.rejects(
    createSkillFolderArchive([]),
    (error: Error) => error.message === "请选择要导入的 Skill 文件夹。",
  );
});

test("states the folder limits with the numbers the code enforces", () => {
  for (const locale of ["en", "zh-CN"] as const) {
    assert.match(
      translate(locale, "skillFolder.tooManyFiles", { count: MAX_SKILL_FOLDER_FILES }),
      new RegExp(String(MAX_SKILL_FOLDER_FILES)),
    );
    assert.match(
      translate(locale, "skillFolder.extractedTooLarge", { size: MAX_SKILL_FOLDER_EXTRACTED_BYTES / (1024 * 1024) }),
      /50 MiB/,
    );
    assert.match(
      translate(locale, "skillFolder.archiveTooLarge", { size: MAX_SKILL_FOLDER_ARCHIVE_BYTES / (1024 * 1024) }),
      /25 MiB/,
    );
  }
});
