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
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

import { SKILL_EXTENSIONS_WORKSPACE_PATH } from "@sciencediscovery/schema";
import { hashSkillPackageFiles, SkillCatalog, type RuntimeSkillSnapshot } from "@sciencediscovery/specialist";

import { prepareSkillSandbox, skillPackageSetHash, SKILL_SNAPSHOT_MANIFEST } from "./skill-sandbox.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

function snapshot(id: string, source: ReadonlyMap<string, Buffer>, revision: number): RuntimeSkillSnapshot {
  const frozen = new Map([...source].map(([path, bytes]) => [path, Buffer.from(bytes)]));
  const resources = [...frozen]
    .filter(([path]) => path !== "SKILL.md")
    .map(([path, bytes]) => ({
      hash: createHash("sha256").update(bytes).digest("hex"),
      kind: path.startsWith("scripts/") ? "script" as const : path.startsWith("references/") ? "reference" as const : "asset" as const,
      path,
      size: bytes.length,
    }));
  return {
    content: "Use the complete frozen package.",
    description: "Synthetic complete package snapshot.",
    hash: hashSkillPackageFiles(frozen),
    id,
    readPackageFiles: () => [...frozen].map(([path, bytes]) => ({
      bytes: Buffer.from(bytes),
      hash: createHash("sha256").update(bytes).digest("hex"),
      path,
      size: bytes.length,
    })),
    readResource: (path) => {
      const bytes = frozen.get(path);
      if (!bytes) throw new Error("not found");
      return {
        content: bytes.toString("utf8"),
        hash: createHash("sha256").update(bytes).digest("hex"),
        path,
        revision,
        skillId: id,
        size: bytes.length,
      };
    },
    resources,
    revision,
    version: `1.0.${revision}`,
  };
}

test("prepares only selected complete frozen Skill packages before sandbox execution", async (context) => {
  const fixtureRoot = resolve(process.cwd(), ".tmp", `skill-sandbox-${process.pid}-${Date.now()}`);
  const workspaceRoot = resolve(fixtureRoot, "workspace");
  const snapshotRoot = resolve(fixtureRoot, "session", "skill-snapshots", "run-1");
  await mkdir(workspaceRoot, { recursive: true });
  context.after(() => rm(fixtureRoot, { force: true, recursive: true }));
  const script = Buffer.from(`print("frozen marker")\n# ${"x".repeat(20_000)}\n`);
  const selectedSource = new Map<string, Buffer>([
    ["SKILL.md", Buffer.from("---\nname: selected-skill\ndescription: test\n---\n\nFrozen instructions.\n")],
    ["scripts/foo.py", script],
    ["references/guide.md", Buffer.from("Frozen guide\n")],
    ["assets/data.bin", Buffer.from([0x00, 0xff, 0x41])],
  ]);
  const selected = snapshot("selected-skill", selectedSource, 3);
  const unselected = snapshot("unselected-skill", new Map([
    ["SKILL.md", Buffer.from("---\nname: unselected-skill\ndescription: no\n---\n\nDo not expose.\n")],
  ]), 1);

  const prepared = await prepareSkillSandbox(snapshotRoot, workspaceRoot, [selected]);
  assert.equal(prepared.manifest.skills.length, 1);
  assert.equal(prepared.manifest.skills[0]?.id, "selected-skill");
  assert.equal(prepared.manifest.skills[0]?.revision, 3);
  assert.equal(prepared.manifest.skills[0]?.hash, selected.hash);
  for (const [path, bytes] of selectedSource) {
    assert.deepEqual(await readFile(resolve(snapshotRoot, "selected-skill", ...path.split("/"))), bytes);
  }
  await assert.rejects(stat(resolve(snapshotRoot, unselected.id)), /ENOENT/);
  await assert.rejects(stat(resolve(workspaceRoot, "skills")), /ENOENT/);
  assert.ok((await stat(resolve(workspaceRoot, SKILL_EXTENSIONS_WORKSPACE_PATH))).isDirectory());
  const manifestText = await readFile(resolve(snapshotRoot, SKILL_SNAPSHOT_MANIFEST), "utf8");
  assert.doesNotMatch(manifestText, /frozen marker/);
  assert.ok(manifestText.length < script.length / 10);

  // Preparing the same execution identity is idempotent and never re-reads live package files.
  selectedSource.set("scripts/foo.py", Buffer.from("print('live edit')\n"));
  await prepareSkillSandbox(snapshotRoot, workspaceRoot, [selected]);
  assert.deepEqual(await readFile(resolve(snapshotRoot, "selected-skill", "scripts", "foo.py")), script);
});

test("the package set hash is stable per selected Skill set so one snapshot is shared", () => {
  const alpha = snapshot("alpha-skill", new Map([["SKILL.md", Buffer.from("alpha\n")]]), 2);
  const beta = snapshot("beta-skill", new Map([["SKILL.md", Buffer.from("beta\n")]]), 5);

  // Two runs selecting the same revisions must resolve to the same directory,
  // otherwise a persistent kernel would see its read-only mount change per run.
  assert.equal(skillPackageSetHash([alpha, beta]), skillPackageSetHash([alpha, beta]));
  assert.equal(skillPackageSetHash([alpha, beta]), skillPackageSetHash([beta, alpha]));
  assert.match(skillPackageSetHash([alpha]), /^[0-9a-f]{64}$/);

  // A different selection, revision, or package content must not collide.
  assert.notEqual(skillPackageSetHash([alpha]), skillPackageSetHash([alpha, beta]));
  assert.notEqual(
    skillPackageSetHash([alpha]),
    skillPackageSetHash([snapshot("alpha-skill", new Map([["SKILL.md", Buffer.from("alpha\n")]]), 3)]),
  );
  assert.notEqual(
    skillPackageSetHash([alpha]),
    skillPackageSetHash([snapshot("alpha-skill", new Map([["SKILL.md", Buffer.from("edited\n")]]), 2)]),
  );
});

test("stages the frozen revision even after the live package is edited on disk", async (context) => {
  const fixtureRoot = resolve(repositoryRoot, ".tmp");
  await mkdir(fixtureRoot, { recursive: true });
  const dataDir = await mkdtemp(resolve(fixtureRoot, "skill-sandbox-frozen-"));
  context.after(() => rm(dataDir, { force: true, recursive: true }));
  const workspaceRoot = resolve(dataDir, "workspace");
  await mkdir(workspaceRoot, { recursive: true });

  const catalog = new SkillCatalog(dataDir, repositoryRoot);
  await catalog.load();
  await catalog.import("portable-skill.zip", Buffer.from(zipSync({
    "portable-skill/SKILL.md": strToU8(
      "---\nname: portable-skill\ndescription: A portable test skill used for validation.\nmetadata:\n  version: 2.3.4\n---\n\n# Instructions\n\nDo the portable thing.\n",
    ),
    "portable-skill/scripts/unused.py": strToU8("print('frozen revision')"),
  })));
  const frozen = catalog.resolve(["portable-skill"])[0]!;

  // Edit the live revision package after resolve, exactly as a concurrent author would.
  const livePath = resolve(dataDir, "skills", "portable-skill", "revisions", "1", "package", "scripts", "unused.py");
  await writeFile(livePath, "print('live disk edit')");

  const snapshotRoot = resolve(dataDir, "skill-snapshots", "run-1");
  const prepared = await prepareSkillSandbox(snapshotRoot, workspaceRoot, [frozen]);
  assert.equal(
    await readFile(resolve(snapshotRoot, "portable-skill", "scripts", "unused.py"), "utf8"),
    "print('frozen revision')",
  );
  assert.equal(prepared.manifest.skills[0]?.hash, frozen.hash);
  assert.equal(prepared.manifest.skills[0]?.revision, 1);
  // The staged tree is read-only for the sandbox user, even before any bind mount.
  assert.equal((await stat(resolve(snapshotRoot, "portable-skill", "scripts", "unused.py"))).mode & 0o222, 0);
});
