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
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { resolve } from "node:path";
import test from "node:test";

import { SkillLibraryCatalog } from "./skill-library-catalog.js";

async function temporaryDataDir(): Promise<string> {
  const root = resolve(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(resolve(root, "skill-library-catalog-test-"));
}

function skillPackage(name: string, description = "A test skill for library commits.", body = "Do the thing.") {
  return {
    files: [{
      content: `---\nname: ${name}\ndescription: ${description}\nmetadata:\n  version: 1.0.0\n---\n\n# ${name}\n\n${body}\n`,
      path: "SKILL.md",
    }],
  };
}

test("skill libraries commit batches atomically, diff versions, and rollback by creating a new version", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    const library = await catalog.create({ id: "workflow-library", name: "Workflow Library" });
    assert.equal(library.headVersionId, undefined);

    const first = await catalog.commitVersion("workflow-library", {
      author: { kind: "self-evolution", name: "evaluator" },
      operations: [
        { package: skillPackage("alpha-skill"), type: "upsert" },
        { package: skillPackage("beta-skill"), type: "upsert" },
      ],
    });
    assert.equal(first.conflicts.length, 0);
    assert.equal(first.version?.skills.length, 2);
    assert.equal(catalog.get("workflow-library")?.headVersionId, first.version?.id);

    const dryRun = await catalog.commitVersion("workflow-library", {
      author: { kind: "user" },
      baseVersionId: first.version!.id,
      dryRun: true,
      operations: [
        { package: skillPackage("alpha-skill", "A revised test skill for library commits."), type: "upsert" },
        { skillId: "beta-skill", type: "delete" },
      ],
    });
    assert.equal(dryRun.dryRun, true);
    assert.equal(dryRun.diff.modified.length, 1);
    assert.equal(dryRun.diff.deleted.length, 1);
    assert.equal(catalog.get("workflow-library")?.headVersionId, first.version?.id);

    await assert.rejects(
      catalog.commitVersion("workflow-library", {
        author: { kind: "self-evolution" },
        baseVersionId: first.version!.id,
        operations: [
          { package: skillPackage("gamma-skill"), type: "upsert" },
          { package: { files: [{ content: "# Missing frontmatter", path: "SKILL.md" }] }, type: "upsert" },
        ],
      }),
      /frontmatter/,
    );
    assert.equal((await catalog.listVersions("workflow-library")).length, 1);

    const second = await catalog.commitVersion("workflow-library", {
      author: { kind: "user" },
      baseVersionId: first.version!.id,
      evaluation: { score: 0.92 },
      operations: [
        { package: skillPackage("alpha-skill", "A revised test skill for library commits."), type: "upsert" },
        { skillId: "beta-skill", type: "delete" },
      ],
    });
    assert.equal(second.version?.evaluation?.score, 0.92);
    const diff = await catalog.diffVersions("workflow-library", first.version!.id, second.version!.id);
    assert.deepEqual(diff.modified.map((entry) => entry.skillId), ["alpha-skill"]);
    assert.deepEqual(diff.deleted.map((entry) => entry.skillId), ["beta-skill"]);

    const rollback = await catalog.rollback("workflow-library", {
      author: { kind: "user" },
      baseVersionId: second.version!.id,
      targetVersionId: first.version!.id,
    });
    assert.notEqual(rollback.version?.id, first.version?.id);
    assert.equal(rollback.version?.rollbackOfVersionId, first.version?.id);
    assert.deepEqual(rollback.version?.skills.map((skill) => skill.id), ["alpha-skill", "beta-skill"]);
    assert.equal(catalog.get("workflow-library")?.headVersionId, rollback.version?.id);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("skill library commits report stale base conflicts without moving head", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "conflict-library" });
    const first = await catalog.commitVersion("conflict-library", {
      author: { kind: "user" },
      operations: [{ package: skillPackage("alpha-skill"), type: "upsert" }],
    });
    const stale = await catalog.commitVersion("conflict-library", {
      author: { kind: "user" },
      operations: [{ package: skillPackage("beta-skill"), type: "upsert" }],
    });
    assert.equal(stale.conflicts[0]?.code, "STALE_BASE_VERSION");
    assert.equal(catalog.get("conflict-library")?.headVersionId, first.version?.id);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("skill library references are validated against immutable version hashes", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "manifest-library" });
    const committed = await catalog.commitVersion("manifest-library", {
      author: { kind: "system" },
      operations: [{ package: skillPackage("manifest-skill"), type: "upsert" }],
    });
    const version = committed.version!;

    assert.deepEqual(await catalog.validateRefs([
      { contentHash: version.contentHash, libraryId: "manifest-library", versionId: version.id },
      { contentHash: version.contentHash, libraryId: "manifest-library", versionId: version.id },
    ]), [{ contentHash: version.contentHash, libraryId: "manifest-library", versionId: version.id }]);

    await assert.rejects(
      catalog.validateRefs([{ contentHash: "bad-hash", libraryId: "manifest-library", versionId: version.id }]),
      /hash mismatch/,
    );
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
