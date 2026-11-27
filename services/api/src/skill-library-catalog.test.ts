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

import { BUNDLED_SKILL_IDS, SkillCatalog } from "@sciencediscovery/specialist";
import { BUILT_IN_SKILL_LIBRARY_ID } from "@sciencediscovery/schema";
import { ideaTreeRepositoryForSession } from "./idea-tree/python-client.js";
import { createIdeaTreeAuthorityRegistry } from "@sciencediscovery/idea-tree";

import { createQueuedRun, createSkillEvolutionRun, DEFAULT_SELF_EVOLUTION_LIBRARY_ID, SKILL_EVOLUTION_PROMPT_MARKER } from "./runs/index.js";
import { SessionStore } from "./store.js";
import { SkillLibraryCatalog } from "./skill-library-catalog.js";

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");

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

test("skill library self-evolution proposals dry-run before user publication", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "proposal-library" });
    const first = await catalog.commitVersion("proposal-library", {
      author: { kind: "user" },
      operations: [{ package: skillPackage("alpha-skill"), type: "upsert" }],
    });

    const proposal = await catalog.proposeUpdate("proposal-library", {
      author: { kind: "self-evolution" },
      baseVersionId: first.version!.id,
      dryRun: true,
      libraryId: "proposal-library",
      operations: [{ package: skillPackage("beta-skill"), type: "upsert" }],
      rationale: "Beta skill was useful in a failed run.",
      sourceRefs: [{ id: "run-1", kind: "run" }],
    });
    assert.equal(proposal.status, "pending");
    assert.equal(proposal.result.dryRun, true);
    assert.deepEqual(proposal.result.diff.added.map((entry) => entry.skillId), ["beta-skill"]);
    assert.equal(catalog.get("proposal-library")?.headVersionId, first.version?.id);
    assert.deepEqual(catalog.listProposals("proposal-library").map((item) => item.id), [proposal.id]);

    const published = await catalog.publishProposal(proposal.id);
    assert.equal(published.result.conflicts.length, 0);
    assert.equal(published.proposal.status, "published");
    assert.equal(catalog.get("proposal-library")?.headVersionId, published.result.version?.id);
    assert.deepEqual((await catalog.getVersion("proposal-library", published.result.version!.id)).skills.map((skill) => skill.id), ["alpha-skill", "beta-skill"]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("skill library self-evolution proposals publish as one merged version", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "proposal-batch-library", name: "Proposal Batch Library" });
    const first = await catalog.commitVersion("proposal-batch-library", {
      author: { kind: "user" },
      operations: [{ package: skillPackage("alpha-skill"), type: "upsert" }],
    });
    const beta = await catalog.proposeUpdate("proposal-batch-library", {
      author: { kind: "self-evolution" },
      baseVersionId: first.version!.id,
      dryRun: true,
      libraryId: "proposal-batch-library",
      operations: [{ package: skillPackage("beta-skill"), type: "upsert" }],
      rationale: "Beta skill was useful.",
      sourceRefs: [{ id: "run-1", kind: "run" }],
    });
    const gamma = await catalog.proposeUpdate("proposal-batch-library", {
      author: { kind: "self-evolution" },
      baseVersionId: first.version!.id,
      dryRun: true,
      libraryId: "proposal-batch-library",
      operations: [{ package: skillPackage("gamma-skill"), type: "upsert" }],
      rationale: "Gamma skill was useful.",
      sourceRefs: [{ id: "run-2", kind: "run" }],
    });

    const published = await catalog.publishProposals([beta.id, gamma.id]);
    assert.equal(published.result.conflicts.length, 0);
    assert.deepEqual(published.proposals.map((proposal) => proposal.status), ["published", "published"]);
    assert.equal(catalog.get("proposal-batch-library")?.headVersionId, published.result.version?.id);
    assert.deepEqual(
      (await catalog.getVersion("proposal-batch-library", published.result.version!.id)).skills.map((skill) => skill.id),
      ["alpha-skill", "beta-skill", "gamma-skill"],
    );
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("skill library self-evolution proposals reject read-only built-in libraries", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.seedBuiltInSkillLibrary(repositoryRoot);
    await assert.rejects(
      catalog.proposeUpdate(BUILT_IN_SKILL_LIBRARY_ID, {
        author: { kind: "self-evolution" },
        dryRun: true,
        libraryId: BUILT_IN_SKILL_LIBRARY_ID,
        operations: [{ package: skillPackage("beta-skill"), type: "upsert" }],
        rationale: "Do not write built-in skills.",
        sourceRefs: [{ id: "run-1", kind: "run" }],
      }),
      /read-only/,
    );
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

test("skill library search returns bounded candidates from mounted versions", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "recall-library" });
    const committed = await catalog.commitVersion("recall-library", {
      author: { kind: "system" },
      operations: [
        { package: skillPackage("alpha-literature-skill", "Find papers and summarize literature evidence."), type: "upsert" },
        { package: skillPackage("beta-literature-skill", "Rank literature evidence for a research question."), type: "upsert" },
        { package: skillPackage("gamma-docking-skill", "Run molecular docking workflows."), type: "upsert" },
      ],
    });
    const refs = await catalog.resolveEnabledRefs([{ libraryId: "recall-library", versionId: "head" }]);
    assert.deepEqual(refs, [{
      contentHash: committed.version!.contentHash,
      libraryId: "recall-library",
      versionId: committed.version!.id,
    }]);

    const result = await catalog.search({
      libraries: [{ ...refs[0]!, priority: 5, limit: 2 }],
      limit: 2,
      query: "literature evidence review",
    });
    assert.equal(result.conflicts.length, 0);
    assert.deepEqual(result.candidates.map((candidate) => candidate.skill.id), ["alpha-literature-skill", "beta-literature-skill"]);
    assert.equal(result.candidates.every((candidate) => candidate.priority === 5), true);

    const snapshots = await catalog.resolveSkills(result.candidates);
    assert.deepEqual(snapshots.map((skill) => skill.id), ["alpha-literature-skill", "beta-literature-skill"]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("recalled skill library snapshots expose immutable complete package files", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "resource-library" });
    const script = Buffer.from([0x00, 0xff, 0x41, 0x42]);
    const committed = await catalog.commitVersion("resource-library", {
      author: { kind: "system" },
      operations: [{
        package: {
          files: [
            {
              content: "---\nname: binary-resource-skill\ndescription: Materialize a frozen binary resource for analysis.\nmetadata:\n  version: 1.0.0\n---\n\nUse the bundled resource.\n",
              path: "SKILL.md",
            },
            { content: script.toString("base64"), encoding: "base64", path: "scripts/tool.bin" },
          ],
        },
        type: "upsert",
      }],
    });
    const search = await catalog.search({
      libraries: [{
        contentHash: committed.version!.contentHash,
        libraryId: "resource-library",
        versionId: committed.version!.id,
      }],
      query: "frozen binary resource",
    });
    const snapshot = (await catalog.resolveSkills(search.candidates))[0]!;
    const first = snapshot.readPackageFiles().find((file) => file.path === "scripts/tool.bin")!;
    assert.deepEqual(Buffer.from(first.bytes), script);
    first.bytes[0] = 0x7f;
    assert.deepEqual(
      Buffer.from(snapshot.readPackageFiles().find((file) => file.path === "scripts/tool.bin")!.bytes),
      script,
    );
    assert.ok(snapshot.readPackageFiles().some((file) => file.path === "SKILL.md"));
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("skill library package storage accepts paths whose segment starts with dots", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "dot-prefix-library" });
    const committed = await catalog.commitVersion("dot-prefix-library", {
      author: { kind: "system" },
      operations: [{
        package: {
          files: [
            {
              content: "---\nname: dot-prefix-skill\ndescription: Preserve package resources whose names begin with dots.\nmetadata:\n  version: 1.0.0\n---\n\nUse the bundled resource.\n",
              path: "SKILL.md",
            },
            { content: "dot-prefixed resource", path: "references/..foo.md" },
          ],
        },
        type: "upsert",
      }],
    });
    assert.equal(committed.conflicts.length, 0);

    const search = await catalog.search({
      libraries: [{
        contentHash: committed.version!.contentHash,
        libraryId: "dot-prefix-library",
        versionId: committed.version!.id,
      }],
      query: "dot prefix",
    });
    const snapshot = (await catalog.resolveSkills(search.candidates))[0]!;
    const resource = snapshot.readPackageFiles().find((file) => file.path === "references/..foo.md");
    assert.equal(Buffer.from(resource!.bytes).toString("utf8"), "dot-prefixed resource");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("queued runs pin enabled skill library heads to immutable version refs", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const skillCatalog = new SkillCatalog(dataDir, repositoryRoot);
    await skillCatalog.load();
    const store = new SessionStore(dataDir);
    store.setAvailableSkillIds(skillCatalog.ids());
    await store.load();
    const model = await store.createModel({
      apiToken: "model-token",
      baseUrl: "https://models.example.test/v1",
      model: "science-model",
      name: "Science model",
    });
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: "queued-library" });
    const committed = await catalog.commitVersion("queued-library", {
      author: { kind: "system" },
      operations: [{ package: skillPackage("queued-literature-skill", "Find literature evidence."), type: "upsert" }],
    });
    const project = await store.createProject("Queued library project", {
      enabledSkillIds: [],
      enabledSkillLibraries: [{ libraryId: "queued-library", limit: 1, priority: 7, versionId: "head" }],
      modelId: model.id,
      skillSelectionMode: "selected",
    });
    const session = await store.createSession(project.id, "Queued library session");
    const persistence = ideaTreeRepositoryForSession({ url: "http://127.0.0.1:1" }, { projectId: project.id, sessionId: session.id });

    const run = await createQueuedRun(
      store,
      skillCatalog,
      catalog,
      createIdeaTreeAuthorityRegistry(),
      session.id,
      { content: "find literature evidence" },
      persistence,
    );
    assert.deepEqual(run.skillLibraryRefs, [{
      contentHash: committed.version!.contentHash,
      libraryId: "queued-library",
      versionId: committed.version!.id,
    }]);
    assert.deepEqual(run.settingsSnapshot.enabledSkillLibraries, [{
      libraryId: "queued-library",
      limit: 1,
      priority: 7,
      versionId: "head",
    }]);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("run-level skill self-evolution queues a guided proposal run", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const skillCatalog = new SkillCatalog(dataDir, repositoryRoot);
    await skillCatalog.load();
    const store = new SessionStore(dataDir);
    store.setAvailableSkillIds(skillCatalog.ids());
    await store.load();
    const model = await store.createModel({
      apiToken: "model-token",
      baseUrl: "https://models.example.test/v1",
      model: "science-model",
      name: "Science model",
    });
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    await catalog.create({ id: DEFAULT_SELF_EVOLUTION_LIBRARY_ID });
    const project = await store.createProject("Self-evolution project", {
      enabledSkillIds: [],
      modelId: model.id,
      skillSelectionMode: "selected",
    });
    const session = await store.createSession(project.id, "Self-evolution session");
    const authorities = createIdeaTreeAuthorityRegistry();
    const persistence = ideaTreeRepositoryForSession({ url: "http://127.0.0.1:1" }, { projectId: project.id, sessionId: session.id });
    const source = await createQueuedRun(
      store,
      skillCatalog,
      catalog,
      authorities,
      session.id,
      { content: "Summarize a tiny CSV validation workflow" },
      persistence,
    );
    await store.updateSessionRunStatus(session.id, source.id, "completed", { finishedAt: new Date().toISOString(), startedAt: new Date().toISOString() });

    const evolution = await createSkillEvolutionRun(
      store,
      skillCatalog,
      catalog,
      authorities,
      persistence,
      session.id,
      source.id,
    );
    assert.equal(evolution.status, "queued");
    assert.match(evolution.prompt, new RegExp(SKILL_EVOLUTION_PROMPT_MARKER.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
    assert.match(evolution.prompt, /propose_skill_library_update/);
    assert.match(evolution.prompt, /upsert_skill/);
    assert.match(evolution.prompt, new RegExp(source.id));
    assert.match(evolution.prompt, new RegExp(DEFAULT_SELF_EVOLUTION_LIBRARY_ID));
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("skill library catalog seeds bundled skills into a stable built-in library", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    const seeded = await catalog.seedBuiltInSkillLibrary(repositoryRoot);
    assert.equal(seeded.id, BUILT_IN_SKILL_LIBRARY_ID);
    assert.ok(seeded.headVersionId);
    const version = await catalog.getVersion(seeded.id, seeded.headVersionId!);
    assert.deepEqual(version.skills.map((skill) => skill.id), [...BUNDLED_SKILL_IDS].sort());

    await catalog.seedBuiltInSkillLibrary(repositoryRoot);
    assert.equal((await catalog.listVersions(BUILT_IN_SKILL_LIBRARY_ID)).length, 1);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});

test("an invalid bundled package is skipped and reported while the built-in library still seeds", async () => {
  const dataDir = await temporaryDataDir();
  const repository = await mkdtemp(resolve(process.cwd(), ".tmp", "built-in-seed-failure-"));
  try {
    await mkdir(resolve(repository, "skills", "idea-tree-team"), { recursive: true });
    await writeFile(resolve(repository, "skills", "idea-tree-team", "SKILL.md"), [
      "---",
      "name: idea-tree-team",
      "description: Use when the user asks for autonomous Idea Tree research: prepare the inputs.",
      "---",
      "",
    ].join("\n"));
    await mkdir(resolve(repository, "skills", "literature-searcher"), { recursive: true });
    await writeFile(resolve(repository, "skills", "literature-searcher", "SKILL.md"), [
      "---",
      "name: literature-searcher",
      "description: Search the literature for evidence.",
      "---",
      "",
    ].join("\n"));

    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    const seeded = await catalog.seedBuiltInSkillLibrary(repository);
    assert.equal(seeded.id, BUILT_IN_SKILL_LIBRARY_ID);
    assert.ok(seeded.headVersionId, "the valid bundled skill still produced a version");
    const version = await catalog.getVersion(seeded.id, seeded.headVersionId!);
    assert.deepEqual(version.skills.map((skill) => skill.id), ["literature-searcher"]);
    const failed = catalog.builtInSeedFailures().find((failure) => failure.id === "idea-tree-team");
    assert.ok(failed, "the skipped package is reported");
    assert.equal(failed.code, "SKILL_VALIDATION");

    // A second startup with the same broken file must not fail either.
    await catalog.seedBuiltInSkillLibrary(repository);
    assert.equal((await catalog.listVersions(BUILT_IN_SKILL_LIBRARY_ID)).length, 1);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
    await rm(repository, { force: true, recursive: true });
  }
});

test("a bundled package whose frontmatter name disagrees with its directory fails both surfaces", async () => {
  // The catalog validates a bundled package against its directory name, so a
  // package written under `skills/literature-searcher` with `name:
  // literature-search` is reported as failed. The built-in library seed has to
  // reach the same verdict, or it would install `literature-search` while the
  // catalog reports `literature-searcher` as broken and the two surfaces would
  // disagree about the same package.
  const dataDir = await temporaryDataDir();
  const repository = await mkdtemp(resolve(process.cwd(), ".tmp", "built-in-seed-name-mismatch-"));
  const writePackage = async (directory: string, name: string) => {
    await mkdir(resolve(repository, "skills", directory), { recursive: true });
    await writeFile(resolve(repository, "skills", directory, "SKILL.md"), [
      "---",
      `name: ${name}`,
      `description: A valid ${name} package.`,
      "---",
      "",
    ].join("\n"));
  };
  try {
    await writePackage("idea-tree-team", "idea-tree-team");
    await writePackage("literature-searcher", "literature-search");

    const catalog = new SkillCatalog(dataDir, repository);
    await catalog.load();
    // The fixture repository ships only the two packages, so every other
    // bundled id is reported as missing; what matters is the verdict on these.
    const catalogFailures = catalog.loadFailures();
    assert.equal(
      catalogFailures.find((failure) => failure.id === "literature-searcher")?.code,
      "SKILL_VALIDATION",
      "the catalog validates the package against its directory name",
    );
    assert.ok(
      !catalogFailures.some((failure) => failure.id === "idea-tree-team"),
      "the agreeing package failed to load",
    );
    assert.equal(catalog.get("literature-search"), undefined, "the catalog installed the frontmatter name");

    const libraries = new SkillLibraryCatalog(dataDir);
    await libraries.load();
    const seeded = await libraries.seedBuiltInSkillLibrary(repository);
    assert.ok(seeded.headVersionId, "the agreeing package still seeded a version");
    const version = await libraries.getVersion(seeded.id, seeded.headVersionId!);
    assert.deepEqual(
      version.skills.map((skill) => skill.id),
      ["idea-tree-team"],
      "the library seeded a package the catalog reports as failed",
    );
    assert.deepEqual(
      version.skills.map((skill) => skill.id),
      catalog.ids(),
      "the library head and the catalog disagree about the same bundled packages",
    );
    const failure = libraries.builtInSeedFailures().find((entry) => entry.id === "literature-searcher");
    assert.ok(failure, "the mismatched package is not reported");
    assert.equal(failure.code, "SKILL_VALIDATION");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
    await rm(repository, { force: true, recursive: true });
  }
});

test("a bundled package that breaks after seeding leaves the built-in library head too", async () => {
  const dataDir = await temporaryDataDir();
  const repository = await mkdtemp(resolve(process.cwd(), ".tmp", "built-in-seed-upgrade-"));
  const valid = (name: string) => [
    "---",
    `name: ${name}`,
    `description: A valid ${name} package.`,
    "---",
    "",
  ].join("\n");
  const writePackage = async (name: string, markdown: string) => {
    await mkdir(resolve(repository, "skills", name), { recursive: true });
    await writeFile(resolve(repository, "skills", name, "SKILL.md"), markdown);
  };
  try {
    await writePackage("idea-tree-team", valid("idea-tree-team"));
    await writePackage("literature-searcher", valid("literature-searcher"));

    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    const first = await catalog.seedBuiltInSkillLibrary(repository);
    const firstVersion = await catalog.getVersion(first.id, first.headVersionId!);
    assert.deepEqual(firstVersion.skills.map((skill) => skill.id), ["idea-tree-team", "literature-searcher"]);

    // The upgrade: one of the already-seeded packages is now malformed.
    await writePackage("idea-tree-team", [
      "---",
      "name: idea-tree-team",
      "description: Use when the user asks for autonomous Idea Tree research: prepare the inputs.",
      "---",
      "",
    ].join("\n"));

    const upgraded = await catalog.seedBuiltInSkillLibrary(repository);
    assert.notEqual(upgraded.headVersionId, first.headVersionId, "the stale package stayed in the head version");
    const upgradedVersion = await catalog.getVersion(upgraded.id, upgraded.headVersionId!);
    assert.deepEqual(
      upgradedVersion.skills.map((skill) => skill.id),
      ["literature-searcher"],
      "the built-in library still resolves the package the catalog reports as failed",
    );
    const failure = catalog.builtInSeedFailures().find((entry) => entry.id === "idea-tree-team");
    assert.ok(failure, "the skipped package is reported");
    assert.equal(failure.code, "SKILL_VALIDATION");
  } finally {
    await rm(dataDir, { force: true, recursive: true });
    await rm(repository, { force: true, recursive: true });
  }
});

test("Git Skill inspect and review stay out of the run registry until publish, then pin an immutable snapshot", async () => {
  const dataDir = await temporaryDataDir();
  try {
    const catalog = new SkillLibraryCatalog(dataDir);
    await catalog.load();
    const library = await catalog.create({ id: "git-closed-loop", name: "Git Closed Loop" });
    const proposal = await catalog.proposeUpdate(library.id, {
      author: { kind: "self-evolution", name: "git-review" },
      baseVersionId: undefined,
      dryRun: true,
      libraryId: library.id,
      operations: [{ package: skillPackage("git-reviewed-skill"), type: "upsert" }],
      rationale: "Import and review a Git Skill before use.",
      sourceRefs: [{ id: "git-commit-1", kind: "run" }],
    });
    assert.equal(proposal.status, "pending");
    await assert.rejects(
      catalog.resolveEnabledRefs([{ libraryId: library.id, versionId: "head" }]),
      /no head version/i,
    );

    const published = await catalog.publishProposal(proposal.id);
    assert.equal(published.proposal.status, "published");
    const version = published.result.version!;
    const refs = await catalog.resolveEnabledRefs([{ libraryId: library.id, versionId: "head" }]);
    assert.deepEqual(refs, [{ libraryId: library.id, versionId: version.id, contentHash: version.contentHash }]);
    const selected = await catalog.search({ libraries: refs, query: "git-reviewed-skill", limit: 1 });
    assert.equal(selected.candidates[0]?.skill.id, "git-reviewed-skill");
    assert.equal(selected.skillLibraryRefs[0]?.contentHash, version.contentHash);
  } finally {
    await rm(dataDir, { force: true, recursive: true });
  }
});
