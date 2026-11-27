// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:macos", "os:windows", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import { strToU8, zipSync } from "fflate";
import { packageFromUpload, SkillCatalog, SkillCatalogError, validateSkillPackage } from "./skills.js";

function packageWithDescription(frontmatter: string): Map<string, Buffer> {
  return new Map([["SKILL.md", Buffer.from(`---\nname: description-check\n${frontmatter}\n---\n\nFollow the instructions.\n`)]]);
}

test("skill packages reject missing, blank and non-string descriptions", () => {
  for (const frontmatter of ["", 'description: ""', 'description: "   "', 'description: "\\t\\n"', "description: null", "description: 123", "description: false", "description: []", "description: {}"]) {
    assert.throws(() => validateSkillPackage(packageWithDescription(frontmatter)), (error: unknown) => {
      assert.ok(error instanceof SkillCatalogError);
      assert.match(error.message, /description/);
      return true;
    }, frontmatter);
  }
});

test("a package path cannot be both a file and a folder", () => {
  const files = new Map([
    ["SKILL.md", Buffer.from("---\nname: shape-check\ndescription: A package.\n---\n\nBody.\n")],
    ["references/a.md", Buffer.from("# A")],
    ["references", Buffer.from("not a folder")],
  ]);
  assert.throws(() => validateSkillPackage(files), /both a file and a folder: references/u);
});

test("skill packages preserve a nonblank description and the original package bytes", () => {
  const files = packageWithDescription('description: "  A useful description.  "');
  const loaded = validateSkillPackage(files);
  assert.equal(loaded.detail.description, "  A useful description.  ");
  assert.deepEqual(loaded.files.get("SKILL.md"), files.get("SKILL.md"));
});

/** A repository root with two bundled Skill directories: one valid package and
 *  one whose unquoted description contains `: `, the YAML that took the API
 *  down when it shipped in `skills/idea-tree-team/SKILL.md`. */
async function temporarySkillRepository(): Promise<string> {
  const root = resolve(process.cwd(), ".tmp");
  await mkdir(root, { recursive: true });
  const repository = await mkdtemp(resolve(root, "bundled-skill-failure-"));
  await mkdir(resolve(repository, "skills", "idea-tree-team"), { recursive: true });
  await writeFile(resolve(repository, "skills", "idea-tree-team", "SKILL.md"), [
    "---",
    "name: idea-tree-team",
    "description: Use when the user explicitly asks for autonomous Idea Tree research: prepare the inputs.",
    "---",
    "",
    "# Idea Tree",
    "",
  ].join("\n"));
  await mkdir(resolve(repository, "skills", "literature-searcher"), { recursive: true });
  await writeFile(resolve(repository, "skills", "literature-searcher", "SKILL.md"), [
    "---",
    "name: literature-searcher",
    "description: Search the literature for evidence.",
    "---",
    "",
    "# Literature",
    "",
  ].join("\n"));
  return repository;
}

test("one invalid bundled package is skipped and reported instead of failing the catalog load", async () => {
  const repository = await temporarySkillRepository();
  const dataDir = resolve(repository, "data");
  try {
    const catalog = new SkillCatalog(dataDir, repository);
    await catalog.load();

    assert.ok(catalog.ids().includes("literature-searcher"), "the valid bundled skill is still installed");
    assert.equal(catalog.ids().includes("idea-tree-team"), false, "the broken bundled skill is not installed");
    const failed = catalog.loadFailures().find((failure) => failure.id === "idea-tree-team");
    assert.ok(failed, "the broken bundled skill is reported");
    assert.equal(failed.code, "SKILL_VALIDATION");
    assert.match(failed.message, /frontmatter|YAML/i);

    const listed = catalog.list();
    assert.ok(listed.some((skill) => skill.id === "literature-searcher" && skill.loadFailure === undefined));
    const failedEntry = listed.find((skill) => skill.id === "idea-tree-team");
    assert.ok(failedEntry, "/api/skills can list the broken skill as failed");
    assert.equal(failedEntry.loadFailure?.code, "SKILL_VALIDATION");
    assert.equal(failedEntry.readOnly, true);

    // A saved selection that still names the skipped built-in must not throw:
    // plugin binding would otherwise fail startup for every request.
    assert.deepEqual(catalog.resolve(["idea-tree-team", "literature-searcher"]).map((skill) => skill.id), ["literature-searcher"]);
    assert.throws(
      () => catalog.resolve(["never-installed-skill"]),
      (error: unknown) => error instanceof SkillCatalogError && error.code === "SKILL_NOT_FOUND",
    );
  } finally {
    await rm(repository, { force: true, recursive: true });
  }
});

/** The error an upload throws, as the HTTP layer sees it. */
function refusalOf(filename: string, files: Record<string, Uint8Array>): {
  code?: string;
  message?: string;
  skillRefusal?: unknown;
} {
  try {
    packageFromUpload(filename, Buffer.from(zipSync(files)));
  } catch (error) {
    return error as { code?: string; message?: string; skillRefusal?: unknown };
  }
  throw new Error("the archive was accepted");
}

test("an archive over the entry cap carries the count and the cap, not just the cap", () => {
  const files: Record<string, Uint8Array> = {
    "skills-main/SKILL.md": strToU8("---\nname: many\ndescription: Many entries.\n---\n\nBody.\n"),
  };
  // 500 resource entries beside SKILL.md puts the central directory at 501,
  // one over the importer's cap. This is the shape a repository-wide ZIP has
  // long before anything is unpacked.
  for (let index = 0; index < 500; index += 1) files[`skills-main/references/${index}.md`] = strToU8("#");
  const refusal = refusalOf("skills-main.zip", files);
  assert.equal(refusal.code, "PAYLOAD_TOO_LARGE");
  assert.deepEqual(refusal.skillRefusal, {
    actual: 501,
    cap: 500,
    limit: "entries",
    reason: "too-large",
  });
});

test("a repository ZIP with no root SKILL.md says the package shape is wrong", () => {
  const refusal = refusalOf("skills-main.zip", {
    "skills-main/alpha/SKILL.md": strToU8("---\nname: alpha\ndescription: One.\n---\n"),
    "skills-main/beta/SKILL.md": strToU8("---\nname: beta\ndescription: Two.\n---\n"),
  });
  assert.equal(refusal.code, "SKILL_VALIDATION");
  assert.deepEqual(refusal.skillRefusal, { reason: "missing-root" });
});

test("an archive of loose files has no package root to grow outside of", () => {
  const refusal = refusalOf("loose-files.zip", {
    "hello.md": strToU8("# Hello"),
  });
  assert.equal(refusal.code, "SKILL_VALIDATION");
  assert.deepEqual(refusal.skillRefusal, { reason: "missing-root" });
});

test("several top-level directories are refused as several package roots", () => {
  const refusal = refusalOf("two-skills.zip", {
    "alpha/SKILL.md": strToU8("---\nname: alpha\ndescription: One.\n---\n"),
    "beta/SKILL.md": strToU8("---\nname: beta\ndescription: Two.\n---\n"),
  });
  assert.deepEqual(refusal.skillRefusal, { reason: "several-roots" });
});
