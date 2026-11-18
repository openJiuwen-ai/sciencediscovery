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
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  BUNDLED_SKILL_IDS,
  type GitSkillCheckout,
  SkillCatalog,
  SkillCatalogError,
  validateGitSkillImportRequest,
} from "@sciencediscovery/specialist";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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
