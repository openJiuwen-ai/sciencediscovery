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
import { access, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, describe, it } from "node:test";

import { gzipSync } from "fflate";

import { sessionCategories } from "./categories.js";
import { exportHub } from "./export.js";
import {
  MAX_SESSION_PACKAGE_BYTES,
  SESSIONS_INDEX,
  collectSessions,
  loadSessionIndex,
  readSessionPackage,
} from "./sessions.js";
import { publishSessions } from "./sessions-index.js";
import { packTar } from "./tar.js";

import {
  createResearchPackage,
  importResearchPackage,
  jsonBytes,
} from "../../packages/research-package/src/index.js";

import type {
  PackageManifest,
  ResearchPackageCounts,
  ResearchPackageExportProfile,
} from "../../packages/research-package/src/index.js";
import type { SessionIndex } from "./sessions.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");
const temporary: string[] = [];

after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { force: true, recursive: true })));
});

async function tempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), prefix));
  temporary.push(dir);
  return dir;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function counts(overrides: Partial<ResearchPackageCounts> = {}): ResearchPackageCounts {
  return {
    artifacts: 0,
    artifactVersions: 0,
    executionRuns: 0,
    fileRevisions: 0,
    memoryEdges: 0,
    memoryNodes: 0,
    messages: 0,
    runEvents: 0,
    runs: 0,
    sessions: 0,
    trajectoryEvents: 0,
    workspaceFiles: 0,
    ...overrides,
  };
}

function exportProfile(): ResearchPackageExportProfile {
  return {
    capabilities: {
      continuation: false,
      fullExecutionHistory: false,
      fullMemoryGraph: false,
      fullTrajectory: false,
      historicalVersions: false,
    },
    included: counts({ artifacts: 6, executionRuns: 9, memoryNodes: 31, messages: 42, sessions: 1, workspaceFiles: 12 }),
    level: "necessary",
    omitted: counts(),
  };
}

function makePackage(options: { readme?: string; withProfile?: boolean } = {}): Uint8Array {
  const object = new TextEncoder().encode("artifact bytes");
  const digest = createHash("sha256").update(object).digest("hex");
  const { bytes } = createResearchPackage({
    ...(options.withProfile === false ? {} : { exportProfile: exportProfile() }),
    objects: [{ bytes: object, path: `objects/${digest}` }],
    producerVersion: "0.4.0",
    readme: options.readme ?? "# Case report\n\nExtracted from the package.\n",
    records: { messages: [] },
    source: { projectId: "project-1", title: "Fixture case" },
  });
  return bytes;
}

function sidecar(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    benchmark: {
      caseId: "response-to-salm-oncostatin",
      dataset: "phylobio/BiomniBench-DA",
      name: "BiomniBench-DA",
      rubric: "original",
      runAt: "2026-11-17T02:14:00Z",
      score: 0.82,
    },
    category: { domain: "biology", source: "biomni", task: "data-analysis" },
    description: "Differential expression, pathway enrichment and a conclusion.",
    name: "Response to SALM / Oncostatin M",
    readme: "# Curated notes\n\nWritten by the producer.\n",
    related: { connectors: ["pubmed"], skills: ["literature-searcher"], specialists: ["analysis-specialist"] },
    run: { durationMs: 3241000, model: "test-model", productVersion: "0.4.0", tokens: 184320 },
    ...overrides,
  };
}

const CATALOG = {
  assets: [
    { id: "literature-searcher", kind: "skill" },
    { id: "analysis-specialist", kind: "specialist" },
    { id: "pubmed", kind: "connector" },
  ],
};

async function writeCatalog(): Promise<string> {
  const dir = await tempDir("hub-catalog-");
  const file = path.join(dir, "catalog.json");
  await writeFile(file, `${JSON.stringify(CATALOG)}\n`);
  return file;
}

/** Writes a `<id>.sdresearch` + `<id>.json` drop and returns its directory. */
async function drop(id: string, bytes: Uint8Array, sidecarValue: unknown = sidecar()): Promise<string> {
  const dir = await tempDir("hub-sessions-");
  await writeFile(path.join(dir, `${id}.sdresearch`), bytes);
  await writeFile(path.join(dir, `${id}.json`), `${JSON.stringify(sidecarValue)}\n`);
  return dir;
}

async function publish(sessionsDir: string, options: {
  outDir?: string;
  previousIndex?: SessionIndex;
  unpublish?: string[];
} = {}): Promise<{
  added: string[];
  index: SessionIndex;
  indexFile: string;
  kept: number;
  outDir: string;
  unpublished: string[];
  warnings: string[];
}> {
  const outDir = options.outDir ?? await tempDir("hub-publish-");
  return {
    ...await publishSessions({
      catalogPath: await writeCatalog(),
      outDir,
      previousIndex: options.previousIndex,
      sessionsDir,
      unpublish: options.unpublish,
    }),
    outDir,
  };
}

/** Rebuilds a package with a mutated manifest, keeping every payload byte. */
async function repack(bytes: Uint8Array, mutate: (manifest: PackageManifest) => void): Promise<Uint8Array> {
  const imported = importResearchPackage(bytes);
  const manifest = structuredClone(imported.manifest);
  mutate(manifest);
  return gzipSync(await packTar([
    { bytes: new TextEncoder().encode(JSON.stringify(manifest)), path: "manifest.json" },
    { bytes: jsonBytes(imported.records), path: "records.json" },
    { bytes: imported.readme, path: "README.md" },
    ...[...imported.objects].map(([digest, object]) => ({ bytes: object, path: `objects/${digest}` })),
  ]), { level: 6 });
}

describe("session package publication", () => {
  it("merges the manifest with the sidecar and copies both files", async () => {
    const bytes = makePackage();
    const sessionsDir = await drop("biomni-salm-20261117", bytes);
    const outDir = await tempDir("hub-publish-");
    const { entries, index, indexFile } = await publishSessions({
      catalogPath: await writeCatalog(),
      now: () => new Date("2026-11-17T09:00:00Z"),
      outDir,
      sessionsDir,
    });

    assert.equal(entries.length, 1);
    assert.equal(index.sessions.length, 1);
    assert.equal(indexFile, path.join(outDir, "sessions", SESSIONS_INDEX));
    assert.equal(index.updatedAt, "2026-11-17T09:00:00.000Z");

    const entry = index.sessions[0]!;
    assert.equal(entry.id, "biomni-salm-20261117");
    assert.equal(entry.name, "Response to SALM / Oncostatin M");
    assert.deepEqual(entry.benchmark, {
      caseId: "response-to-salm-oncostatin",
      dataset: "phylobio/BiomniBench-DA",
      name: "BiomniBench-DA",
      rubric: "original",
      runAt: "2026-11-17T02:14:00Z",
      score: 0.82,
    });
    assert.deepEqual(entry.category, { domain: "biology", source: "biomni", task: "data-analysis" });
    assert.deepEqual(entry.run, { durationMs: 3241000, model: "test-model", productVersion: "0.4.0", tokens: 184320 });
    assert.deepEqual(entry.contents, {
      artifacts: 6,
      executions: 9,
      files: 12,
      memoryNodes: 31,
      messages: 42,
      trajectory: "summary",
    });
    assert.equal(entry.producer.version, "0.4.0");
    assert.equal(entry.packageKind, "evidence");
    assert.equal(entry.createdAt, importResearchPackage(bytes).manifest.createdAt);
    assert.equal(entry.download.url, "biomni-salm-20261117.sdresearch");
    assert.equal(entry.download.size, bytes.byteLength);
    assert.equal(entry.download.sha256, sha256(bytes));
    assert.equal(entry.readme, "biomni-salm-20261117/README.md");
    assert.deepEqual(entry.related, {
      connectors: ["pubmed"],
      skills: ["literature-searcher"],
      specialists: ["analysis-specialist"],
    });

    const copied = new Uint8Array(await readFile(path.join(outDir, "sessions", "biomni-salm-20261117.sdresearch")));
    assert.deepEqual(copied, new Uint8Array(bytes));
    const readme = await readFile(path.join(outDir, "sessions", "biomni-salm-20261117", "README.md"), "utf8");
    assert.equal(readme, "# Curated notes\n\nWritten by the producer.\n");
    const written = JSON.parse(await readFile(indexFile, "utf8")) as SessionIndex;
    assert.deepEqual(written, index);
  });

  it("keeps the README extracted from the package when the sidecar does not override it", async () => {
    const value = sidecar();
    delete value.readme;
    const sessionsDir = await drop("extracted-readme", makePackage({ readme: "# From the package\n\nEvidence summary.\n" }), value);
    const { outDir } = await publish(sessionsDir);
    const readme = await readFile(path.join(outDir, "sessions", "extracted-readme", "README.md"), "utf8");
    assert.equal(readme, "# From the package\n\nEvidence summary.\n");
  });

  it("marks a package with a full trajectory as complete", async () => {
    // The manifest, not the sidecar, decides whether the trajectory is complete.
    const bytes = await repack(makePackage(), (manifest) => {
      if (!manifest.exportProfile) throw new Error("the fixture has no exportProfile");
      manifest.exportProfile.capabilities.fullTrajectory = true;
    });
    const sessionsDir = await drop("complete-trajectory", bytes);
    const { index } = await publish(sessionsDir);
    assert.equal(index.sessions[0]!.contents.trajectory, "complete");
  });

  it("turns the published index into catalog assets", async () => {
    const sessionsDir = await drop("biomni-salm-20261117", makePackage());
    const { index } = await publish(sessionsDir);
    const assets = collectSessions(index, "https://hub.example.test/sessions/");
    assert.equal(assets.length, 1);
    const asset = assets[0]!;
    assert.equal(asset.kind, "session-package");
    assert.equal(asset.source, "manual");
    assert.equal(asset.version, "0.4.0");
    assert.equal(asset.download.url, "https://hub.example.test/sessions/biomni-salm-20261117.sdresearch");
    assert.equal(asset.readme, "https://hub.example.test/sessions/biomni-salm-20261117/README.md");
    assert.equal(asset.run?.model, "test-model");
    assert.deepEqual(asset.contents, index.sessions[0]!.contents);
    assert.deepEqual(asset.benchmark, index.sessions[0]!.benchmark);
  });

  it("reads a published index and treats a missing one as empty", async () => {
    const empty = await tempDir("hub-empty-");
    assert.deepEqual(await loadSessionIndex({ dir: empty }), { schemaVersion: 1, sessions: [], updatedAt: null });

    const sessionsDir = await drop("biomni-salm-20261117", makePackage());
    const { outDir } = await publish(sessionsDir);
    const loaded = await loadSessionIndex({ dir: path.join(outDir, "sessions") });
    assert.equal(loaded.sessions.length, 1);
    assert.equal(loaded.sessions[0]!.id, "biomni-salm-20261117");
  });

  it("rejects a package whose sidecar is missing", async () => {
    const sessionsDir = await tempDir("hub-sessions-");
    await writeFile(path.join(sessionsDir, "lonely.sdresearch"), makePackage());
    await assert.rejects(
      () => publish(sessionsDir),
      /lonely\.sdresearch: sidecar lonely\.json is missing/,
    );
  });

  it("rejects a sidecar without a package", async () => {
    const sessionsDir = await tempDir("hub-sessions-");
    await writeFile(path.join(sessionsDir, "ghost.json"), `${JSON.stringify(sidecar())}\n`);
    await assert.rejects(
      () => publish(sessionsDir),
      /ghost\.json: there is no ghost\.sdresearch package/,
    );
  });

  it("rejects a package whose bytes do not match its manifest", async () => {
    const corrupted = await repack(makePackage(), (manifest) => {
      manifest.inventory.find((entry) => entry.path === "records.json")!.checksum = "0".repeat(64);
    });
    await assert.rejects(
      () => readSessionPackage(corrupted),
      /records\.json does not match its manifest checksum/,
    );

    const sessionsDir = await drop("corrupted", corrupted);
    await assert.rejects(() => publish(sessionsDir), /corrupted\.sdresearch:.*records\.json does not match its manifest checksum/);
  });

  it("rejects a package over the 50 MiB limit", async () => {
    const sessionsDir = await tempDir("hub-sessions-");
    await writeFile(path.join(sessionsDir, "huge.sdresearch"), Buffer.alloc(MAX_SESSION_PACKAGE_BYTES + 1));
    await writeFile(path.join(sessionsDir, "huge.json"), `${JSON.stringify(sidecar())}\n`);
    await assert.rejects(() => publish(sessionsDir), /huge\.sdresearch: the package is 50\.0 MiB, over the 50 MiB limit/);
  });

  it("rejects a package without an export profile", async () => {
    const sessionsDir = await drop("no-profile", makePackage({ withProfile: false }));
    await assert.rejects(() => publish(sessionsDir), /exportProfile is missing/);
  });

  it("rejects a sidecar that names a related id the catalog does not have", async () => {
    const sessionsDir = await drop("missing-related", makePackage(), sidecar({ related: { skills: ["no-such-skill"] } }));
    await assert.rejects(
      () => publish(sessionsDir),
      /missing-related\.json: field "related\.skills" names "no-such-skill", which is not in the catalog/,
    );
  });

  it("rejects a related id of the wrong kind", async () => {
    const sessionsDir = await drop("wrong-kind", makePackage(), sidecar({ related: { skills: ["pubmed"] } }));
    await assert.rejects(() => publish(sessionsDir), /which is a connector in the catalog/);
  });

  it("reports a bad sidecar field with its file and field name", async () => {
    const sessionsDir = await drop("bad-field", makePackage(), sidecar({ benchmark: { name: "BiomniBench-DA" } }));
    await assert.rejects(() => publish(sessionsDir), /bad-field\.json: field "benchmark\.caseId" must be a non-empty string/);
  });

  it("files an unknown task under uncategorized and warns", async () => {
    const sessionsDir = await drop("unknown-task", makePackage(), sidecar({ category: { source: "manual", task: "hypothesis-design" } }));
    const { index, warnings } = await publish(sessionsDir);
    assert.match(warnings[0]!, /unknown category\.task "hypothesis-design"/);
    assert.deepEqual(sessionCategories(collectSessions(index, "/sessions")).map((node) => node.id), ["uncategorized"]);
  });

  it("keeps published entries a later run does not deliver", async () => {
    const sessionsDir = await tempDir("hub-sessions-");
    await writeFile(path.join(sessionsDir, "kept.sdresearch"), makePackage());
    await writeFile(path.join(sessionsDir, "kept.json"), `${JSON.stringify(sidecar())}\n`);
    await writeFile(path.join(sessionsDir, "old.sdresearch"), makePackage());
    await writeFile(path.join(sessionsDir, "old.json"), `${JSON.stringify(sidecar())}\n`);
    const first = await publish(sessionsDir);
    assert.deepEqual(first.index.sessions.map((entry) => entry.id), ["kept", "old"]);

    // A later run delivers only `kept`; `old` must survive the merge.
    await rm(path.join(sessionsDir, "old.sdresearch"));
    await rm(path.join(sessionsDir, "old.json"));
    const second = await publish(sessionsDir, { outDir: first.outDir, previousIndex: first.index });
    assert.deepEqual(second.index.sessions.map((entry) => entry.id), ["kept", "old"]);
    assert.deepEqual(second.added, ["kept"]);
    assert.equal(second.kept, 1);
  });

  it("unpublishes only explicitly named entries and leaves their files", async () => {
    const sessionsDir = await tempDir("hub-sessions-");
    for (const id of ["kept", "removed"]) {
      await writeFile(path.join(sessionsDir, `${id}.sdresearch`), makePackage());
      await writeFile(path.join(sessionsDir, `${id}.json`), `${JSON.stringify(sidecar())}\n`);
    }
    const first = await publish(sessionsDir);

    // An empty drop is allowed when a previous index anchors the merge.
    const empty = await tempDir("hub-empty-drop-");
    const second = await publish(empty, {
      outDir: first.outDir,
      previousIndex: first.index,
      unpublish: ["removed"],
    });
    assert.deepEqual(second.index.sessions.map((entry) => entry.id), ["kept"]);
    assert.deepEqual(second.unpublished, ["removed"]);
    assert.match(second.warnings[0]!, /no new session packages/);
    // The old URL keeps working because the uploaded object is never deleted.
    await access(path.join(first.outDir, "sessions", "removed.sdresearch"));
  });

  it("rejects an unpublish that is unknown or delivered by the same run", async () => {
    const sessionsDir = await drop("same-run", makePackage());
    const first = await publish(sessionsDir);

    await assert.rejects(
      () => publish(sessionsDir, { outDir: first.outDir, previousIndex: first.index, unpublish: ["missing"] }),
      /cannot unpublish "missing": it is not in the published index/,
    );
    await assert.rejects(
      () => publish(sessionsDir, { outDir: first.outDir, previousIndex: first.index, unpublish: ["same-run"] }),
      /cannot unpublish "same-run": the same publish delivers it/,
    );
  });

  it("lets a delivered package replace its earlier entry", async () => {
    const sessionsDir = await drop("replaced", makePackage());
    const first = await publish(sessionsDir);
    const republishedDrop = await drop("replaced", makePackage(), sidecar({ name: "Updated title" }));
    const second = await publish(republishedDrop, {
      outDir: first.outDir,
      previousIndex: first.index,
    });
    assert.deepEqual(second.added, ["replaced"]);
    assert.equal(second.kept, 0);
    assert.equal(second.index.sessions.length, 1);
    assert.equal(second.index.sessions[0]!.name, "Updated title");
  });

  it("rejects an empty drop when there is no published index to merge", async () => {
    const empty = await tempDir("hub-empty-drop-");
    await assert.rejects(() => publish(empty), /no \.sdresearch packages to publish/);
  });
});

describe("session packages in the catalog", () => {
  it("adds the session asset, its category tree and the source summary", async () => {
    const sessionsDir = await drop("biomni-salm-20261117", makePackage());
    const { outDir: publishOutDir, index } = await publish(sessionsDir);
    const outDir = await tempDir("hub-export-");
    const { catalog } = await exportHub({
      outDir,
      repoRoot,
      sessionsBaseUrl: "/sessions",
      sessionsDir: path.join(publishOutDir, "sessions"),
    });

    const session = catalog.assets.find((asset) => asset.kind === "session-package");
    assert.ok(session);
    assert.equal(session.id, "biomni-salm-20261117");
    assert.equal(session.download.url, "/sessions/biomni-salm-20261117.sdresearch");
    assert.equal(session.readme, "/sessions/biomni-salm-20261117/README.md");
    assert.equal(session.contents.messages, 42);

    const tasks = catalog.categories.sessionPackage;
    assert.deepEqual(tasks.map((node) => node.id), ["data-analysis"]);
    assert.equal(tasks[0]!.count, 1);
    assert.deepEqual(tasks[0]!.children?.map((node) => node.id), ["biology"]);
    assert.deepEqual(catalog.sources.sessions, { count: 1, updatedAt: index.updatedAt });

    // The exported catalog must stay valid JSON on disk, not just in memory.
    const written = JSON.parse(await readFile(path.join(outDir, "catalog.json"), "utf8")) as typeof catalog;
    assert.ok(written.assets.some((asset) => asset.id === "biomni-salm-20261117"));
  });

  it("keeps the other tabs unchanged when no sessions are configured", async () => {
    const outDir = await tempDir("hub-export-");
    const { catalog } = await exportHub({ outDir, repoRoot });
    assert.equal(catalog.assets.filter((asset) => asset.kind === "session-package").length, 0);
    assert.deepEqual(catalog.categories.sessionPackage, []);
    assert.equal(catalog.sources.sessions, undefined);
  });
});
