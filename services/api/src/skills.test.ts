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
import { mkdir, mkdtemp, readFile, readdir, rm } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

import {
  BUNDLED_SKILL_IDS,
  createDialogueSkillDraft,
  createSessionSkillDraft,
  packageFromUpload,
  parseSkillMarkdown,
  SkillCatalog,
  SkillCatalogError,
  validateSkillPackage,
  validateGitSkillImportRequest,
} from "./skills.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function markdown(name = "portable-skill", body = "# Instructions\n\nDo the portable thing."): Buffer {
  return Buffer.from(`---\nname: ${name}\ndescription: A portable test skill used for validation.\nmetadata:\n  version: 2.3.4\n---\n\n${body}\n`);
}

test("bundled skill registry covers all repository skill directories", async () => {
  const entries = await readdir(resolve(repositoryRoot, "skills"), { withFileTypes: true });
  const skillDirectories: string[] = [];
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    try {
      await readFile(resolve(repositoryRoot, "skills", entry.name, "SKILL.md"));
    } catch {
      continue;
    }
    skillDirectories.push(entry.name);
  }
  skillDirectories.sort();

  assert.deepEqual(skillDirectories, [...BUNDLED_SKILL_IDS].sort());
});

async function temporaryDataDir(): Promise<string> {
  const root = resolve(repositoryRoot, ".tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(resolve(root, "skill-catalog-test-"));
}

test("parses Agent Skills frontmatter and rejects invalid metadata", () => {
  const parsed = parseSkillMarkdown(markdown());
  assert.equal(parsed.frontmatter.name, "portable-skill");
  assert.match(parsed.instructions, /Do the portable thing/);

  assert.throws(
    () => validateSkillPackage(new Map([["SKILL.md", markdown("Invalid_Name")]]), { directoryName: "Invalid_Name" }),
    /name must contain/,
  );
  assert.throws(
    () => validateSkillPackage(new Map([["SKILL.md", markdown("portable-skill")]]), { directoryName: "different-name" }),
    /must match package directory/,
  );
});

test("creates reviewable dialogue and Session drafts without activating them", () => {
  const dialogue = createDialogueSkillDraft({ description: "Analyze an existing assay pipeline and validate its result." });
  assert.equal(dialogue.origin, "dialogue");
  assert.equal(dialogue.name, "analyze-an-existing-assay-pipeline-and-validate-its");
  assert.match(dialogue.instructions, /existing Python, R, or shell scripts/);

  const distilled = createSessionSkillDraft({
    messages: [
      { content: "Run the established normalization workflow.", createdAt: "2026-01-01T00:00:00.000Z", id: "m1", role: "user" },
      { content: "The workflow completed.", createdAt: "2026-01-01T00:01:00.000Z", id: "m2", role: "assistant" },
    ],
    request: { name: "normalized-assay" },
    runs: [],
    sessionTitle: "Normalized assay",
  });
  assert.equal(distilled.origin, "session");
  assert.match(distilled.sourceSummary, /2 messages/);
  assert.match(distilled.instructions, /not active until a user reviews/);
});

test("accepts credential-helper Git URLs and rejects embedded credentials or unsafe paths", () => {
  assert.deepEqual(validateGitSkillImportRequest({
    ref: "v1.2.0",
    repositoryUrl: "https://example.org/team/methods.git",
    subdirectory: "skills/pocket-method/",
  }), {
    ref: "v1.2.0",
    repositoryUrl: "https://example.org/team/methods.git",
    subdirectory: "skills/pocket-method",
  });
  assert.throws(
    () => validateGitSkillImportRequest({ repositoryUrl: "https://token@example.org/private.git" }),
    /credential helper/,
  );
  assert.throws(
    () => validateGitSkillImportRequest({ repositoryUrl: "https://example.org/repo.git", subdirectory: "../skill" }),
    /Unsafe skill package path/,
  );
});

test("package validation is path-safe and hashes the complete tree deterministically", () => {
  const left = validateSkillPackage(new Map([
    ["references/guide.md", Buffer.from("guide")],
    ["SKILL.md", markdown()],
  ]), { directoryName: "portable-skill" });
  const right = validateSkillPackage(new Map([
    ["SKILL.md", markdown()],
    ["references/guide.md", Buffer.from("guide")],
  ]), { directoryName: "portable-skill" });
  assert.equal(left.detail.hash, right.detail.hash);
  assert.equal(left.detail.declaredVersion, "2.3.4");
  assert.deepEqual(left.detail.resourceSummary, {
    bytes: 5,
    files: 1,
    kinds: { asset: 0, other: 0, reference: 1, script: 0 },
  });
  assert.throws(
    () => validateSkillPackage(new Map([
      ["SKILL.md", markdown()],
      ["../escape.txt", Buffer.from("no")],
    ])),
    /Unsafe skill package path/,
  );
});

test("imports a rooted ZIP and rejects traversal archives", () => {
  const archive = Buffer.from(zipSync({
    "portable-skill/SKILL.md": strToU8(markdown().toString("utf8")),
    "portable-skill/references/guide.md": strToU8("Reference text"),
    "portable-skill/scripts/unused.py": strToU8("raise RuntimeError('must stay inert')"),
  }));
  const loaded = packageFromUpload("portable-skill.zip", archive);
  assert.equal(loaded.detail.id, "portable-skill");
  assert.deepEqual(loaded.detail.resources.map((item) => item.path), [
    "references/guide.md",
    "scripts/unused.py",
  ]);

  const unsafe = Buffer.from(zipSync({
    "../escape.txt": strToU8("escape"),
    "portable-skill/SKILL.md": strToU8(markdown().toString("utf8")),
  }));
  assert.throws(() => packageFromUpload("unsafe.zip", unsafe), /Unsafe skill package path/);
});

test("persists immutable managed revisions and enforces optimistic concurrency", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    assert.equal(catalog.get("life-science-evidence-brief")?.readOnly, true);
    const methodSkill = catalog.get("structure-pocket-inspection");
    assert.equal(methodSkill?.readOnly, true);
    assert.deepEqual(methodSkill?.resources.map((resource) => resource.path), ["scripts/inspect_pdb.py"]);

    const archive = Buffer.from(zipSync({
      "portable-skill/SKILL.md": strToU8(markdown().toString("utf8")),
      "portable-skill/references/guide.md": strToU8("revision one"),
      "portable-skill/scripts/unused.py": strToU8("print('not run')"),
    }));
    const imported = await catalog.import("portable-skill.zip", archive);
    assert.equal(imported.currentRevision, 1);
    const frozen = catalog.resolve(["portable-skill"])[0]!;

    const updated = await catalog.update("portable-skill", {
      description: "A portable test skill used after editing.",
      expectedRevision: 1,
      instructions: "# Updated\n\nUse the preserved reference.",
      metadata: { version: "2.4.0" },
      name: "portable-skill",
    });
    assert.equal(updated.currentRevision, 2);
    assert.equal(updated.resources.length, 2);
    assert.equal(frozen.readResource("references/guide.md").revision, 1);
    assert.throws(
      () => frozen.readResource("../escape.txt"),
      /Unsafe skill package path/,
    );
    await assert.rejects(
      catalog.update("portable-skill", {
        description: "Stale edit",
        expectedRevision: 1,
        instructions: "# Stale",
        name: "portable-skill",
      }),
      (error: unknown) => error instanceof SkillCatalogError && error.code === "SKILL_CONFLICT",
    );

    const reloaded = new SkillCatalog(dataDir, repositoryRoot);
    await reloaded.load();
    assert.equal(reloaded.get("portable-skill")?.currentRevision, 2);
    assert.equal(reloaded.readCurrentResource("portable-skill", "references/guide.md").content, "revision one");
    assert.equal(
      await readFile(resolve(dataDir, "skills", "portable-skill", "revisions", "1", "package", "scripts", "unused.py"), "utf8"),
      "print('not run')",
    );

    await reloaded.delete("portable-skill");
    assert.equal(reloaded.get("portable-skill"), undefined);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
