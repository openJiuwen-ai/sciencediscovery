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
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

import { fileURLToPath } from "node:url";

import { strToU8, zipSync } from "fflate";

import {
  BUNDLED_SKILL_IDS,
  createDialogueSkillDraft,
  createSessionSkillDraft,
  discoverGitSkillRoots,
  packageFromUpload,
  parseSkillMarkdown,
  SKILL_LIMITS,
  SkillCatalog,
  SkillCatalogError,
  validateSkillPackage,
  validateGitSkillImportRequest,
} from "@sciencediscovery/specialist";

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

test("discovers multiple Skills in common marketplace repository layouts", async () => {
  const checkout = await temporaryDataDir();
  try {
    await mkdir(resolve(checkout, "skills", "alpha"), { recursive: true });
    await mkdir(resolve(checkout, ".agents", "skills", "beta"), { recursive: true });
    await mkdir(resolve(checkout, ".claude", "skills", "gamma", "references"), { recursive: true });
    await writeFile(resolve(checkout, "skills", "alpha", "SKILL.md"), markdown("alpha"));
    await writeFile(resolve(checkout, ".agents", "skills", "beta", "SKILL.md"), markdown("beta"));
    await writeFile(resolve(checkout, ".claude", "skills", "gamma", "SKILL.md"), markdown("gamma"));
    await writeFile(resolve(checkout, ".claude", "skills", "gamma", "references", "guide.md"), "guide");

    assert.deepEqual(await discoverGitSkillRoots(checkout), [
      ".agents/skills/beta",
      ".claude/skills/gamma",
      "skills/alpha",
    ]);
    assert.deepEqual(await discoverGitSkillRoots(checkout, "skills/alpha"), ["skills/alpha"]);
    assert.deepEqual(await discoverGitSkillRoots(checkout, "skills"), ["skills/alpha"]);
  } finally {
    await rm(checkout, { force: true, recursive: true });
  }
});

test("keeps exact Git commit provenance through review and confirmation", async () => {
  const dataDir = await temporaryDataDir();
  const commit = "1234567890abcdef1234567890abcdef12345678";
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const draft = await catalog.createReviewDraft({
      description: "Imported marketplace workflow.",
      instructions: "# Workflow\n\nRun the imported workflow.",
      name: "marketplace-skill",
    }, {
      git: { commit, ref: "main", repositoryUrl: "https://example.com/skills.git", subdirectory: "skills/marketplace-skill" },
      source: "git",
    });
    assert.equal(draft.provenance?.git?.commit, commit);
    const detail = await catalog.getReviewDraft(draft.draftId);
    await catalog.confirmReviewDraft(draft.draftId, {
      expectedUpdatedAt: draft.updatedAt,
      files: detail!.files.map((file) => ({ content: file.content, path: file.path })),
    });
    const versions = await catalog.listSkillVersions("marketplace-skill");
    assert.equal(versions[0]?.provenance?.source, "git");
    assert.equal(versions[0]?.provenance?.git?.commit, commit);
    assert.equal(versions[0]?.provenance?.git?.subdirectory, "skills/marketplace-skill");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
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
  assert.deepEqual(validateGitSkillImportRequest({
    repositoryUrl: "https://github.com/anthropics/skills/tree/main/skills",
  }), {
    ref: "main",
    repositoryUrl: "https://github.com/anthropics/skills.git",
    subdirectory: "skills",
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

test("creates an Agent-authored managed package with bounded text resources", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const created = await catalog.createPackage({
      description: "A reusable Agent-authored test workflow.",
      instructions: "# Workflow\n\nRead the supporting checklist when validation is needed.",
      metadata: { version: "1.0.0" },
      name: "agent-authored-skill",
      resources: [
        { content: "# Checklist\n\n- Verify the output.\n", path: "references/checklist.md" },
        { content: "print('portable helper')\n", path: "scripts/helper.py" },
      ],
    });

    assert.equal(created.currentRevision, 1);
    assert.equal(created.version, "1.0.0");
    assert.deepEqual(created.resources.map((resource) => resource.path), [
      "references/checklist.md",
      "scripts/helper.py",
    ]);
    assert.equal(
      catalog.resolve([created.id])[0]!.readResource("references/checklist.md").content,
      "# Checklist\n\n- Verify the output.\n",
    );
    await assert.rejects(catalog.createPackage({
      description: "Invalid duplicate SKILL.md resource.",
      instructions: "# Invalid",
      name: "invalid-agent-skill",
      resources: [{ content: "duplicate", path: "SKILL.md" }],
    }), /Duplicate skill package path/);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("keeps Agent-authored Skills inactive until a user confirms the reviewed files", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const draft = await catalog.createReviewDraft({
      description: "A review-gated Agent workflow.",
      instructions: "# Workflow\n\nCheck the proposed output.",
      name: "review-gated-skill",
      resources: [{ content: "original checklist", path: "references/checklist.md" }],
    });

    assert.equal(catalog.get("review-gated-skill"), undefined);
    assert.equal(draft.baseRevision, undefined);
    assert.equal(catalog.listReviewDrafts().length, 1);
    const reloadedCatalog = new SkillCatalog(dataDir, repositoryRoot);
    await reloadedCatalog.load();
    assert.equal(reloadedCatalog.listReviewDrafts().length, 1);
    const detail = await reloadedCatalog.getReviewDraft(draft.draftId);
    assert.deepEqual(detail?.baseFiles, []);
    assert.deepEqual(detail?.files.map((file) => file.path), ["SKILL.md", "references/checklist.md"]);

    const confirmed = await reloadedCatalog.confirmReviewDraft(draft.draftId, {
      expectedUpdatedAt: draft.updatedAt,
      files: detail!.files.map((file) => ({
        content: file.path === "references/checklist.md" ? "user-reviewed checklist" : file.content!,
        path: file.path,
      })),
    });
    assert.equal(confirmed.currentRevision, 1);
    assert.equal(reloadedCatalog.listReviewDrafts().length, 0);
    assert.equal(reloadedCatalog.readCurrentResource(confirmed.id, "references/checklist.md").content, "user-reviewed checklist");

    const revisionDraft = await reloadedCatalog.createReviewDraft({
      description: "A revised review-gated Agent workflow.",
      instructions: "# Workflow\n\nCheck the revised output.",
      name: "review-gated-skill",
    });
    assert.equal(revisionDraft.baseRevision, 1);
    const revisionDetail = await reloadedCatalog.getReviewDraft(revisionDraft.draftId);
    assert.ok(revisionDetail?.baseFiles.some((file) => file.path === "references/checklist.md"));
    const revised = await reloadedCatalog.confirmReviewDraft(revisionDraft.draftId, {
      expectedUpdatedAt: revisionDraft.updatedAt,
      files: revisionDetail!.files.map((file) => ({ content: file.content!, path: file.path })),
    });
    assert.equal(revised.currentRevision, 2);
    assert.deepEqual(revised.resources, []);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("keeps a reviewed Agent draft when its external Library publication fails", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const draft = await catalog.createReviewDraft({
      description: "A draft that must survive a failed Library commit.",
      instructions: "# Workflow\n\nPublish only after validation.",
      name: "publication-failure-skill",
    }, { sessionId: "session-source", source: "agent" });
    const detail = await catalog.getReviewDraft(draft.draftId);
    await assert.rejects(catalog.publishReviewDraft(draft.draftId, {
      expectedUpdatedAt: draft.updatedAt,
      files: detail!.files.map((file) => ({ content: file.content, path: file.path })),
    }, async (prepared) => {
      assert.equal(prepared.detail.id, "publication-failure-skill");
      assert.equal(prepared.provenance.sessionId, "session-source");
      throw new Error("Library commit failed");
    }), /Library commit failed/);
    assert.deepEqual(catalog.listReviewDrafts().map((candidate) => candidate.draftId), [draft.draftId]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("bulk publish prepares Git drafts as one batch, skips on filter, and sweeps drafts on success", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const commit = "fedcba0987654321fedcba0987654321fedcba09";
    const drafts = await Promise.all(["bulk-alpha", "bulk-beta"].map((name) => catalog.createReviewDraft({
      description: `Bulk import candidate ${name}.`,
      instructions: `# Workflow\n\nRun ${name}.`,
      name,
    }, {
      git: { commit, ref: "main", repositoryUrl: "https://example.com/bulk.git", subdirectory: `skills/${name}` },
      source: "git",
    })));
    const agentDraft = await catalog.createReviewDraft({
      description: "A non-Git draft that must never join a bulk batch.",
      instructions: "# Workflow\n\nAgent authored.",
      name: "bulk-agent-draft",
    }, { sessionId: "session-agent", source: "agent" });

    await assert.rejects(catalog.publishReviewDraftsAtomically(
      [...drafts.map((draft) => draft.draftId), agentDraft.draftId, drafts[0]!.draftId],
      { onConflict: "fail", prepare: () => Promise.resolve([]) },
    ), /Only Git review drafts can be bulk published/);
    assert.equal(catalog.listReviewDrafts().length, 3);

    const seen: Array<{ id: string; metadata?: Record<string, unknown> }> = [];
    const { result, skipped } = await catalog.publishReviewDraftsAtomically(
      [...drafts.map((draft) => draft.draftId), "missing-draft-id"],
      {
        onConflict: "filter",
        prepare: async (prepared) => {
          for (const item of prepared) {
            seen.push({ id: item.detail.id, metadata: item.provenance.metadata });
          }
          return "committed";
        },
        provenanceMetadata: { autoImportedAt: "2026-01-02T03:04:05.000Z", autoImportPresetId: "https://example.com/bulk.git" },
      },
    );
    assert.equal(result, "committed");
    assert.deepEqual(skipped, [{ draftId: "missing-draft-id", reason: "Skill review draft not found (already published or deleted)" }]);
    assert.deepEqual(seen.map((item) => item.id).sort(), ["bulk-alpha", "bulk-beta"]);
    for (const item of seen) {
      assert.equal(item.metadata?.autoImportedAt, "2026-01-02T03:04:05.000Z");
      assert.equal(item.metadata?.autoImportPresetId, "https://example.com/bulk.git");
    }
    assert.deepEqual(catalog.listReviewDrafts().map((candidate) => candidate.name).sort(), ["bulk-agent-draft"]);
    // Bulk-published Git Skills must also land in the local managed catalog so
    // SkillCatalog.list() and SkillWorkspaceDialog can find them. The agent
    // draft is still a draft and the repo's bundled built-ins are unrelated.
    const published = catalog.list().map((skill) => skill.id).filter((id) => id.startsWith("bulk-")).sort();
    assert.deepEqual(published, ["bulk-alpha", "bulk-beta"]);

    await assert.rejects(catalog.publishReviewDraftsAtomically([], { onConflict: "fail", prepare: () => Promise.resolve([]) }), /between 1 and 200/);
    await assert.rejects(
      catalog.publishReviewDraftsAtomically(Array.from({ length: 201 }, (_, index) => `draft-${index}`), { onConflict: "filter", prepare: () => Promise.resolve([]) }),
      /between 1 and 200/,
    );
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("bulk publish keeps every Git draft when the external commit fails", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const commit = "abcdef1234567890abcdef1234567890abcdef12";
    const drafts = await Promise.all(["rollback-alpha", "rollback-beta"].map((name) => catalog.createReviewDraft({
      description: `Rollback candidate ${name}.`,
      instructions: `# Workflow\n\nRun ${name}.`,
      name,
    }, {
      git: { commit, repositoryUrl: "https://example.com/rollback.git", subdirectory: `skills/${name}` },
      source: "git",
    })));
    await assert.rejects(catalog.publishReviewDraftsAtomically(
      drafts.map((draft) => draft.draftId),
      {
        onConflict: "fail",
        prepare: () => Promise.reject(new Error("Library commit failed")),
      },
    ), /Library commit failed/);
    assert.deepEqual(catalog.listReviewDrafts().map((candidate) => candidate.name).sort(), ["rollback-alpha", "rollback-beta"]);
    // Managed sync must also be rolled back — neither the list nor the index
    // should retain references to skills that never made it to a library commit.
    // The repo's bundled built-ins are unrelated and stay loaded.
    const rollbackEntries = catalog.list().map((skill) => skill.id).filter((id) => id.startsWith("rollback-"));
    assert.deepEqual(rollbackEntries, []);
    const reloaded = new SkillCatalog(dataDir, repositoryRoot);
    await reloaded.load();
    const reloadedEntries = reloaded.list().map((skill) => skill.id).filter((id) => id.startsWith("rollback-"));
    assert.deepEqual(reloadedEntries, []);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("bulk publish rolls back the managed entries if the library commit fails mid-batch", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const commit = "1234567890abcdef1234567890abcdef12345678";
    const drafts = await Promise.all(["managed-rollback-1", "managed-rollback-2", "managed-rollback-3"].map((name) => catalog.createReviewDraft({
      description: `Bulk rollback candidate ${name}.`,
      instructions: `# Workflow\n\nRun ${name}.`,
      name,
    }, {
      git: { commit, repositoryUrl: "https://example.com/managed-rollback.git", subdirectory: `skills/${name}` },
      source: "git",
    })));

    await assert.rejects(catalog.publishReviewDraftsAtomically(
      drafts.map((draft) => draft.draftId),
      {
        onConflict: "fail",
        prepare: (prepared) => {
          // Mirror what happens during a real commit: the catalog already
          // touched managed entries. Now the library commit must fail so we
          // can verify the catalog unwinds them.
          assert.equal(prepared.length, 3);
          return Promise.reject(new Error("Library publishVersion exploded"));
        },
      },
    ), /Library publishVersion exploded/);

    // Drafts stayed on disk for retry, managed entries were rolled back, and a
    // fresh catalog instance loads the same empty state from disk. The repo's
    // bundled built-ins are unrelated and stay loaded.
    assert.deepEqual(catalog.listReviewDrafts().map((candidate) => candidate.name).sort(), [
      "managed-rollback-1", "managed-rollback-2", "managed-rollback-3",
    ]);
    const midRollback = catalog.list().map((skill) => skill.id).filter((id) => id.startsWith("managed-rollback-"));
    assert.deepEqual(midRollback, []);
    const reloaded = new SkillCatalog(dataDir, repositoryRoot);
    await reloaded.load();
    const reloadedEntries = reloaded.list().map((skill) => skill.id).filter((id) => id.startsWith("managed-rollback-"));
    assert.deepEqual(reloadedEntries, []);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("bulk publish skips update drafts instead of aborting the batch", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const commit = "1111111111111111111111111111111111111111";
    const updateCommit = "2222222222222222222222222222222222222222";

    // Step 1: seed an initial Git draft and bulk-publish it so it lands in the
    // managed catalog at revision 1. After this the bulk endpoint will treat
    // any further draft with the same name as an update.
    const seed = await catalog.createReviewDraft({
      description: "Initial bulk publish target.",
      instructions: "# Workflow\n\nRun bulk-update-seed.",
      name: "bulk-update-seed",
    }, {
      git: { commit, repositoryUrl: "https://example.com/update.git", subdirectory: "skills/bulk-update-seed" },
      source: "git",
    });
    await catalog.publishReviewDraftsAtomically([seed.draftId], {
      onConflict: "fail", prepare: () => Promise.resolve("seeded"),
    });
    assert.equal(catalog.list().find((entry) => entry.id === "bulk-update-seed")?.currentRevision, 1);

    // Step 2: a Git draft that targets the same Skill id picks up baseRevision
    // automatically when upsertReviewDraft sees an existing managed entry.
    const update = await catalog.createReviewDraft({
      description: "Updated bulk publish target.",
      instructions: "# Workflow\n\nRun bulk-update-seed at revision 2.",
      name: "bulk-update-seed",
    }, {
      git: { commit: updateCommit, repositoryUrl: "https://example.com/update.git", subdirectory: "skills/bulk-update-seed" },
      source: "git",
    });
    assert.equal(update.baseRevision, 1);

    // Step 3: a fresh draft mixed into the batch so we can verify it still
    // commits even though update is skipped.
    const fresh = await catalog.createReviewDraft({
      description: "An unrelated new Skill mixed into the same batch.",
      instructions: "# Workflow\n\nRun bulk-update-fresh.",
      name: "bulk-update-fresh",
    }, {
      git: { commit, repositoryUrl: "https://example.com/update.git", subdirectory: "skills/bulk-update-fresh" },
      source: "git",
    });

    // Step 4: bulk publish a mixed batch. The update must end up in `skipped`
    // with a clear reason, the fresh Skill must commit, and the previously
    // installed bulk-update-seed must remain at revision 1.
    const preparedIds: string[] = [];
    const { result, skipped } = await catalog.publishReviewDraftsAtomically(
      [fresh.draftId, update.draftId],
      {
        onConflict: "fail",
        prepare: async (prepared) => {
          preparedIds.push(...prepared.map((item) => item.detail.id));
          return "partial";
        },
      },
    );
    assert.equal(result, "partial");
    assert.deepEqual(preparedIds, ["bulk-update-fresh"]);
    assert.equal(skipped.length, 1);
    assert.equal(skipped[0]!.draftId, update.draftId);
    assert.match(skipped[0]!.reason, /updates to installed/i);

    // The update draft stays on disk so the user can publish it individually
    // through the existing single-draft review flow.
    assert.deepEqual(catalog.listReviewDrafts().map((draft) => draft.name).sort(), ["bulk-update-seed"]);

    // The previously installed Skill is untouched: bulk publish cannot
    // silently bump or wipe a managed entry.
    const seedAfter = catalog.list().find((entry) => entry.id === "bulk-update-seed");
    assert.ok(seedAfter);
    assert.equal(seedAfter.currentRevision, 1);
    const freshAfter = catalog.list().find((entry) => entry.id === "bulk-update-fresh");
    assert.ok(freshAfter);
    assert.equal(freshAfter.currentRevision, 1);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("updates one pending Agent Skill draft and compares it with the previous proposal", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const first = await catalog.createReviewDraft({
      description: "The first proposed workflow.",
      instructions: "# Workflow\n\nCheck the first proposal.",
      name: "revised-agent-skill",
      resources: [{ content: "first guide", path: "references/guide.md" }],
    }, { sessionId: "session-agent-first", source: "agent" });
    const revised = await catalog.createReviewDraft({
      description: "The revised proposed workflow.",
      instructions: "# Workflow\n\nCheck the revised proposal.",
      name: "revised-agent-skill",
      resources: [{ content: "revised guide", path: "references/guide.md" }],
    }, { sessionId: "session-agent-revised", source: "agent" });

    assert.equal(revised.draftId, first.draftId);
    assert.equal(revised.comparisonSource, "previous-agent-draft");
    assert.equal(catalog.listReviewDrafts().length, 1);
    const detail = await catalog.getReviewDraft(revised.draftId);
    assert.equal(detail?.comparisonSource, "previous-agent-draft");
    assert.match(detail?.baseFiles.find((file) => file.path === "SKILL.md")?.content ?? "", /first proposal/);
    assert.match(detail?.files.find((file) => file.path === "SKILL.md")?.content ?? "", /revised proposal/);
    assert.equal(detail?.baseFiles.find((file) => file.path === "references/guide.md")?.content, "first guide");
    assert.equal(detail?.files.find((file) => file.path === "references/guide.md")?.content, "revised guide");
    const versions = await catalog.listSkillVersions("revised-agent-skill");
    assert.deepEqual(versions.map((version) => version.label), ["Current pending proposal", "Agent proposal 1"]);
    assert.deepEqual(versions.map((version) => version.provenance?.sessionId), ["session-agent-revised", "session-agent-first"]);
    const previousProposal = await catalog.getSkillVersion("revised-agent-skill", versions[1]!.id);
    const currentProposal = await catalog.getSkillVersion("revised-agent-skill", versions[0]!.id);
    assert.match(previousProposal.files.find((file) => file.path === "SKILL.md")?.content ?? "", /first proposal/);
    assert.match(currentProposal.files.find((file) => file.path === "SKILL.md")?.content ?? "", /revised proposal/);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("combines separately named Agent drafts into one stable Skill version history", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const standard = await catalog.createReviewDraft({
      description: "Standard literature survey proposal.",
      instructions: "# Standard\n\nRun the standard survey.",
      metadata: { version: "standard" },
      name: "literature-survey",
    }, { source: "manual" });
    const lite = await catalog.createReviewDraft({
      description: "Lightweight literature survey proposal.",
      instructions: "# Lite\n\nRun the lightweight survey.",
      metadata: { version: "lite" },
      name: "literature-survey-lite",
    });
    const systematic = await catalog.createReviewDraft({
      description: "Systematic literature survey proposal.",
      instructions: "# Systematic\n\nRun the systematic survey.",
      metadata: { version: "systematic" },
      name: "literature-survey-systematic",
    });

    const merged = await catalog.mergeReviewDrafts({
      draftIds: [standard.draftId, lite.draftId, systematic.draftId],
      targetDraftId: standard.draftId,
    });

    assert.equal(merged.draftId, standard.draftId);
    assert.equal(merged.name, "literature-survey");
    assert.deepEqual(catalog.listReviewDrafts().map((draft) => draft.name), ["literature-survey"]);
    const versions = await catalog.listSkillVersions("literature-survey");
    assert.deepEqual(versions.map((version) => version.label), [
      "Current pending proposal",
      "Agent proposal 2",
      "Agent proposal 1",
    ]);
    for (const version of versions) {
      const snapshot = await catalog.getSkillVersion("literature-survey", version.id);
      const parsed = parseSkillMarkdown(Buffer.from(snapshot.files.find((file) => file.path === "SKILL.md")!.content!));
      assert.equal(parsed.frontmatter.name, "literature-survey");
    }
    const selectedVersion = versions[2]!;
    const selectedSnapshot = await catalog.getSkillVersion("literature-survey", selectedVersion.id);
    const confirmed = await catalog.confirmReviewDraft(merged.draftId, {
      expectedUpdatedAt: merged.updatedAt,
      files: selectedSnapshot.files.map(({ binary, content, encodedContent, path }) => ({
        ...(binary ? { binary } : {}),
        ...(content === undefined ? {} : { content }),
        ...(encodedContent === undefined ? {} : { encodedContent }),
        path,
      })),
      sourceVersionId: selectedVersion.id,
    });
    assert.equal(confirmed.id, "literature-survey");
    assert.match(confirmed.instructions, /# Standard/);
    assert.equal((await catalog.listSkillVersions("literature-survey"))[0]?.provenance?.source, "manual");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("merges drafts that share a timestamp in the order they were listed", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const names = ["survey-first", "survey-second", "survey-third"];
    const draftIds: string[] = [];
    const create = new SkillCatalog(dataDir, repositoryRoot);
    await create.load();
    for (const name of names) {
      const draft = await create.createReviewDraft({
        description: `A ${name} literature survey proposal.`,
        instructions: `# ${name}\n\nRun the ${name} survey.`,
        metadata: { version: name },
        name,
      });
      draftIds.push(draft.draftId);
    }
    // Three drafts created back to back land in the same millisecond most of
    // the time; force the tie so the ordering is tested rather than the clock.
    const shared = "2026-01-01T00:00:00.000Z";
    for (const draftId of draftIds) {
      const path = resolve(dataDir, "skills", ".drafts", `${draftId}.json`);
      const stored = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
      await writeFile(path, JSON.stringify({ ...stored, createdAt: shared, updatedAt: shared }));
    }

    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const merged = await catalog.mergeReviewDrafts({ draftIds, targetDraftId: draftIds[0]! });
    const versions = await catalog.listSkillVersions(merged.name);
    // Newest first, so the draft listed first is the oldest proposal. Before
    // the tie was broken by list order it was broken by a random id, which put
    // an arbitrary one of the three here.
    const oldest = await catalog.getSkillVersion(merged.name, versions.at(-1)!.id);
    const parsed = parseSkillMarkdown(
      Buffer.from(oldest.files.find((file) => file.path === "SKILL.md")!.content!),
    );
    assert.match(parsed.instructions, /# survey-first/);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("lists every managed revision and edits any UTF-8 package file as a new revision", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const created = await catalog.createPackage({
      description: "A versioned resource workflow.",
      instructions: "# Workflow\n\nUse the guide.",
      name: "versioned-resource-skill",
      resources: [{ content: "guide version one", path: "references/guide.md" }],
    });
    const updated = await catalog.updateFile("versioned-resource-skill", "references/guide.md", {
      content: "guide version two",
      expectedRevision: created.currentRevision,
      sourceSessionId: "session-manual-edit",
    });

    assert.equal(updated.currentRevision, 2);
    const versions = await catalog.listSkillVersions("versioned-resource-skill");
    assert.deepEqual(versions.map((version) => version.id), ["revision:2", "revision:1"]);
    assert.equal(versions[0]?.provenance?.source, "manual");
    assert.equal(versions[0]?.provenance?.sessionId, "session-manual-edit");
    const first = await catalog.getSkillVersion("versioned-resource-skill", "revision:1");
    const second = await catalog.getSkillVersion("versioned-resource-skill", "revision:2");
    assert.equal(first.files.find((file) => file.path === "references/guide.md")?.content, "guide version one");
    assert.equal(second.files.find((file) => file.path === "references/guide.md")?.content, "guide version two");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("consolidates legacy duplicate drafts into one review with a proposal diff", async () => {
  const dataDir = await temporaryDataDir();
  const draftRoot = resolve(dataDir, "skills", ".drafts");
  const firstId = "11111111-1111-4111-8111-111111111111";
  const latestId = "22222222-2222-4222-8222-222222222222";
  try {
    await mkdir(draftRoot, { recursive: true });
    await writeFile(resolve(draftRoot, `${firstId}.json`), JSON.stringify({
      createdAt: "2026-08-20T01:00:00.000Z",
      draftId: firstId,
      files: [{ content: "first proposal", path: "SKILL.md" }],
      name: "legacy-duplicate-skill",
      updatedAt: "2026-08-20T01:00:00.000Z",
    }));
    await writeFile(resolve(draftRoot, `${latestId}.json`), JSON.stringify({
      createdAt: "2026-08-20T02:00:00.000Z",
      draftId: latestId,
      files: [{ content: "latest proposal", path: "SKILL.md" }],
      name: "legacy-duplicate-skill",
      updatedAt: "2026-08-20T02:00:00.000Z",
    }));

    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    assert.deepEqual(catalog.listReviewDrafts().map((draft) => draft.draftId), [latestId]);
    const detail = await catalog.getReviewDraft(latestId);
    assert.equal(detail?.comparisonSource, "previous-agent-draft");
    assert.equal(detail?.baseFiles[0]?.content, "first proposal");
    assert.equal(detail?.files[0]?.content, "latest proposal");
    assert.deepEqual(await readdir(draftRoot), [`${latestId}.json`]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
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
    assert.equal(frozen.metadata.version, "2.3.4");

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
    assert.equal(
      Buffer.from(frozen.readPackageFiles().find((file) => file.path === "scripts/unused.py")!.bytes).toString("utf8"),
      "print('not run')",
    );
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
    const restored = await reloaded.resolveRevision({
      hash: frozen.hash,
      id: frozen.id,
      revision: frozen.revision,
      version: frozen.version,
    });
    assert.equal(restored.metadata.version, "2.3.4");
    assert.equal(restored.readResource("references/guide.md").revision, 1);
    await assert.rejects(
      reloaded.resolveRevision({ ...frozen, hash: "sha256:not-the-frozen-package" }),
      (error: unknown) => error instanceof SkillCatalogError && error.code === "SKILL_CONFLICT",
    );
    assert.equal(reloaded.readCurrentResource("portable-skill", "references/guide.md").content, "revision one");
    assert.equal(
      await readFile(resolve(dataDir, "skills", "portable-skill", "revisions", "1", "package", "scripts", "unused.py"), "utf8"),
      "print('not run')",
    );
    await writeFile(
      resolve(dataDir, "skills", "portable-skill", "revisions", "1", "package", "scripts", "unused.py"),
      "print('live disk edit')",
    );
    const frozenBytesAfterLiveEdit = frozen.readPackageFiles();
    assert.equal(
      Buffer.from(frozenBytesAfterLiveEdit.find((file) => file.path === "scripts/unused.py")!.bytes).toString("utf8"),
      "print('not run')",
    );
    assert.ok(frozenBytesAfterLiveEdit.some((file) => file.path === "SKILL.md"));

    await reloaded.delete("portable-skill");
    assert.equal(reloaded.get("portable-skill"), undefined);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("complete frozen Skill package files bypass the text read limit and remain immutable", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillCatalog(dataDir, repositoryRoot);
    await catalog.load();
    const largeBinary = Buffer.alloc(SKILL_LIMITS.runtimeTextBytes + 1, 0xff);
    const archive = Buffer.from(zipSync({
      "large-resource-skill/SKILL.md": strToU8(markdown("large-resource-skill").toString("utf8")),
      "large-resource-skill/scripts/large.bin": largeBinary,
    }));
    await catalog.import("large-resource-skill.zip", archive);
    const frozen = catalog.resolve(["large-resource-skill"])[0]!;

    assert.throws(
      () => frozen.readResource("scripts/large.bin"),
      /exceeds .* text bytes/,
    );
    const first = frozen.readPackageFiles().find((file) => file.path === "scripts/large.bin")!;
    assert.equal(first.size, largeBinary.length);
    assert.deepEqual(Buffer.from(first.bytes), largeBinary);
    first.bytes[0] = 0;
    assert.equal(frozen.readPackageFiles().find((file) => file.path === "scripts/large.bin")!.bytes[0], 0xff);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
