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
import { dirname, resolve } from "node:path";
import test from "node:test";
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
