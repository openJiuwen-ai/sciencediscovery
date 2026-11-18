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
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  BUNDLED_SKILL_IDS,
  type GitSkillCheckout,
  SkillCatalog,
  SkillCatalogError,
  validateGitSkillImportRequest,
} from "@sciencediscovery/specialist";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const exec = promisify(execFile);

async function git(directory: string, arguments_: string[]): Promise<string> {
  const { stdout } = await exec("git", arguments_, {
    cwd: directory,
    env: { ...process.env, GIT_TERMINAL_PROMPT: "0" },
  });
  return stdout;
}

function markdown(name = "git-skill", body = "# Instructions\n\nFrom Git."): string {
  return `---\nname: ${name}\ndescription: A Git-imported test skill.\n---\n\n${body}\n`;
}

async function temporaryDataDir(): Promise<string> {
  const root = resolve(repositoryRoot, ".tmp");
  await mkdir(root, { recursive: true });
  return await mkdtemp(resolve(root, "skill-git-import-test-"));
}

/**
 * A checkout without a network. The real transport refuses `file://` on
 * purpose, so the import branches are exercised by writing the package the
 * way a clone would have left it and returning the commit inspection saw.
 */
function fakeGitCheckout(options: {
  body?: string;
  commit: string;
  files?: Record<string, string>;
  name?: string;
  subdirectory?: string;
}): GitSkillCheckout {
  return async (importRoot, input) => {
    const checkout = resolve(importRoot, `fake-${Math.random().toString(36).slice(2)}`);
    const root = options.subdirectory ? resolve(checkout, ...options.subdirectory.split("/")) : checkout;
    await mkdir(root, { recursive: true });
    await writeFile(
      resolve(root, "SKILL.md"),
      options.files?.["SKILL.md"] ?? markdown(options.name ?? "git-skill", options.body),
    );
    for (const [path, content] of Object.entries(options.files ?? {})) {
      if (path === "SKILL.md") continue;
      const target = resolve(root, ...path.split("/"));
      await mkdir(resolve(target, ".."), { recursive: true });
      await writeFile(target, content);
    }
    return { checkout, commit: options.commit, normalized: validateGitSkillImportRequest(input) };
  };
}

test("imports a Git package with the commit inspection saw and its provenance", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "a".repeat(40);
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit, subdirectory: "skills/git-skill" }),
    });
    await catalog.load();
    const detail = await catalog.importFromGit({
      commit,
      repositoryUrl: "https://example.com/skills.git",
      subdirectory: "skills/git-skill",
    });
    assert.equal(detail.id, "git-skill");
    assert.equal(detail.currentRevision, 1);
    const versions = await catalog.listSkillVersions("git-skill");
    assert.equal(versions[0]?.provenance?.source, "git");
    assert.equal(versions[0]?.provenance?.git?.commit, commit);
    assert.equal(versions[0]?.provenance?.git?.subdirectory, "skills/git-skill");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("importing after an inspection reuses the checkout it left behind", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "f".repeat(40);
  const repositoryUrl = "https://example.com/skills.git";
  let clones = 0;
  const clone: GitSkillCheckout = async (importRoot, input) => {
    clones += 1;
    return await fakeGitCheckout({ commit, subdirectory: "skills/git-skill" })(importRoot, input);
  };
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, { checkoutGit: clone });
    await catalog.load();
    const inspection = await catalog.inspectGitRepository({ repositoryUrl });
    assert.equal(clones, 1);
    assert.equal(inspection.commit, commit);

    // One package per request is the client's contract; the second one must
    // not pay for the same clone again.
    await catalog.importFromGit({ commit, repositoryUrl, subdirectory: "skills/git-skill" });
    assert.equal(clones, 1, "the import read the checkout inspection made");

    // A package pinned to another commit is a different question, so it is
    // answered by a fresh clone (and then refused, because the ref moved).
    await assert.rejects(
      catalog.importFromGit({ commit: "0".repeat(40), repositoryUrl, subdirectory: "skills/git-skill" }),
      /moved after inspection/,
    );
    assert.equal(clones, 2);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a scan lists a repository with more than a hundred packages", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "9".repeat(40);
  const count = 120;
  const checkout: GitSkillCheckout = async (importRoot, input) => {
    const root = resolve(importRoot, `fake-${Math.random().toString(36).slice(2)}`);
    for (let index = 0; index < count; index += 1) {
      const name = `skill-${String(index).padStart(3, "0")}`;
      await mkdir(resolve(root, "skills", name), { recursive: true });
      await writeFile(resolve(root, "skills", name, "SKILL.md"), markdown(name));
    }
    return { checkout: root, commit, normalized: validateGitSkillImportRequest(input) };
  };
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, { checkoutGit: checkout });
    await catalog.load();
    const inspection = await catalog.inspectGitRepository({ repositoryUrl: "https://example.com/skills.git" });
    assert.equal(inspection.candidates.length, count);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("an inspection pages a repository larger than one response", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "9".repeat(40);
  const count = 520;
  const repositoryUrl = "https://example.com/skills.git";
  let clones = 0;
  const checkout: GitSkillCheckout = async (importRoot, input) => {
    clones += 1;
    const root = resolve(importRoot, `fake-${Math.random().toString(36).slice(2)}`);
    for (let index = 0; index < count; index += 1) {
      const name = `skill-${String(index).padStart(3, "0")}`;
      await mkdir(resolve(root, "skills", name), { recursive: true });
      await writeFile(resolve(root, "skills", name, "SKILL.md"), markdown(name));
    }
    return { checkout: root, commit, normalized: validateGitSkillImportRequest(input) };
  };
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, { checkoutGit: checkout });
    await catalog.load();
    const first = await catalog.inspectGitRepository({ repositoryUrl });
    assert.equal(first.candidates.length, 500);
    assert.equal(first.total, count);
    assert.equal(first.nextCursor, first.candidates.at(-1)?.subdirectory);

    // Reading on names the commit the first page saw: the second page is the
    // same tree, served from the checkout the first page left behind.
    const second = await catalog.inspectGitRepository({
      commit: first.commit,
      cursor: first.nextCursor,
      repositoryUrl,
    });
    assert.equal(clones, 1, "the second page reused the first page's checkout");
    assert.equal(second.candidates.length, count - 500);
    assert.equal(second.total, count);
    assert.equal(second.nextCursor, undefined);

    // The two pages meet without a gap, an overlap, or a reordering.
    const seen = [...first.candidates, ...second.candidates].map((row) => row.subdirectory);
    assert.equal(seen.length, count);
    assert.equal(new Set(seen).size, count);
    assert.deepEqual(seen, [...seen].sort());
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a page after the first needs the commit it was read at", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "8".repeat(40);
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit }),
    });
    await catalog.load();
    await assert.rejects(
      catalog.inspectGitRepository({ cursor: "skills/git-skill", repositoryUrl: "https://example.com/skills.git" }),
      /requires the commit/,
    );
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a partial checkout keeps resources on the server until a package needs them", async () => {
  const dataDir = await temporaryDataDir();
  const source = resolve(dataDir, "source");
  await mkdir(resolve(source, "skills/git-skill/references"), { recursive: true });
  await writeFile(resolve(source, "skills/git-skill/SKILL.md"), markdown());
  await writeFile(resolve(source, "skills/git-skill/references/guide.md"), "guide");
  await git(source, ["init", "-b", "main"]);
  await git(source, ["-c", "protocol.file.allow=always", "add", "."]);
  await git(source, [
    "-c", "user.email=test@example.com", "-c", "user.name=Test",
    "commit", "-m", "initial", "--no-gpg-sign",
  ]);
  const commit = (await git(source, ["rev-parse", "HEAD"])).trim().toLowerCase();

  // A clone that is handed back exactly the way the real transport leaves it:
  // metadata plus SKILL.md, with every other blob still on the "server".
  const checkout: GitSkillCheckout = async (importRoot, input) => {
    await mkdir(importRoot, { recursive: true });
    const target = resolve(importRoot, `partial-${Math.random().toString(36).slice(2)}`);
    await git(importRoot, [
      "-c", "protocol.file.allow=always",
      "clone", "--depth=1", "--filter=blob:none", "--no-checkout", "--no-tags", "--single-branch",
      "--", `file://${source}`, target,
    ]);
    await git(target, ["sparse-checkout", "set", "--no-cone", "**/SKILL.md"]);
    await git(target, ["checkout"]);
    return { checkout: target, commit, normalized: validateGitSkillImportRequest(input), partial: true };
  };
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, { checkoutGit: checkout });
    await catalog.load();
    const inspection = await catalog.inspectGitRepository({ repositoryUrl: "https://example.com/skills.git" });
    assert.deepEqual(inspection.candidates.map((row) => [row.name, row.status]), [["git-skill", "new"]]);

    // Importing reads the package, so the resource has to be fetched first.
    const detail = await catalog.importFromGit({
      commit,
      repositoryUrl: "https://example.com/skills.git",
      subdirectory: "skills/git-skill",
    });
    assert.deepEqual(detail.resources.map((resource) => resource.path), ["references/guide.md"]);

    // An installed Skill can only be called unchanged after its whole package
    // is compared, so the scan fetches the resources of that one package.
    const again = await catalog.inspectGitRepository({ repositoryUrl: "https://example.com/skills.git" });
    assert.deepEqual(again.candidates.map((row) => [row.name, row.status]), [["git-skill", "unchanged"]]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a Git update needs the revision the user saw and preserves earlier revisions", async () => {
  const dataDir = await temporaryDataDir();
  const firstCommit = "b".repeat(40);
  const secondCommit = "c".repeat(40);
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit: firstCommit }),
    });
    await catalog.load();
    await catalog.importFromGit({ repositoryUrl: "https://example.com/skills.git" });
    const firstHash = catalog.get("git-skill")!.hash;

    const moved = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ body: "# Instructions\n\nSecond version.", commit: secondCommit }),
    });
    await moved.load();
    await assert.rejects(
      moved.importFromGit({ overwrite: true, repositoryUrl: "https://example.com/skills.git" }),
      /requires expectedRevision/,
    );
    await assert.rejects(
      moved.importFromGit({
        expectedRevision: 99,
        overwrite: true,
        repositoryUrl: "https://example.com/skills.git",
      }),
      /Skill revision conflict/,
    );
    const updated = await moved.importFromGit({
      commit: secondCommit,
      expectedRevision: 1,
      overwrite: true,
      repositoryUrl: "https://example.com/skills.git",
    });
    assert.equal(updated.currentRevision, 2);
    assert.notEqual(updated.hash, firstHash);
    const versions = await moved.listSkillVersions("git-skill");
    assert.equal(versions.length, 2);
    assert.equal(versions[0]?.provenance?.git?.commit, secondCommit);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a Git import rejects a moved ref before touching the installed Skill", async () => {
  const dataDir = await temporaryDataDir();
  const inspected = "d".repeat(40);
  const found = "e".repeat(40);
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit: found }),
    });
    await catalog.load();
    await assert.rejects(
      catalog.importFromGit({ commit: inspected, repositoryUrl: "https://example.com/skills.git" }),
      /Git ref moved after inspection/,
    );
    assert.equal(catalog.get("git-skill"), undefined);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("a Git import refuses a built-in name and an unrequested overwrite", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "f".repeat(40);
  try {
    const builtIn = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit, name: BUNDLED_SKILL_IDS[0]! }),
    });
    await builtIn.load();
    await assert.rejects(
      builtIn.importFromGit({ repositoryUrl: "https://example.com/skills.git" }),
      (error: unknown) => error instanceof SkillCatalogError && error.code === "SKILL_READ_ONLY",
    );

    const catalog = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit }),
    });
    await catalog.load();
    await catalog.importFromGit({ repositoryUrl: "https://example.com/skills.git" });
    await assert.rejects(
      catalog.importFromGit({ repositoryUrl: "https://example.com/skills.git" }),
      (error: unknown) => error instanceof SkillCatalogError && error.code === "SKILL_CONFLICT",
    );
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("re-importing identical bytes creates no revision", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "1".repeat(40);
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot, {
      checkoutGit: fakeGitCheckout({ commit }),
    });
    await catalog.load();
    await catalog.importFromGit({ repositoryUrl: "https://example.com/skills.git" });
    const same = await catalog.importFromGit({
      commit,
      expectedRevision: 1,
      overwrite: true,
      repositoryUrl: "https://example.com/skills.git",
    });
    assert.equal(same.currentRevision, 1);
    assert.equal((await catalog.listSkillVersions("git-skill")).length, 1);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
