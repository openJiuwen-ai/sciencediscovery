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
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { gunzipSync, unzipSync } from "fflate";

import { createServer } from "node:http";

import { collectExternalSkills, loadExternalSnapshot } from "./external-skills.js";
import { exportHub } from "./export.js";
import { buildSnapshot, parseReadmeTables, syncExternalSkills } from "./sync-external-skills.js";
import { packTar, unpackTar } from "./tar.js";

import type { SkillAsset } from "./types.js";

const FIXTURE = path.resolve(import.meta.dirname, "__fixtures__/external");
const LONG_PATH = "chemistry_and_materials/quantum_chemistry/a-very-long-skill-directory-name-for-tar-prefix-handling";
const NOW = (): Date => new Date("2026-11-17T08:00:00.000Z");

async function tempDir(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "hub-external-"));
}

test("tar round-trips long paths and binary bytes", async () => {
  const bytes = new Uint8Array(1024).map((_, index) => index % 251);
  const archive = await packTar([
    { bytes, path: `${LONG_PATH}/SKILL.md` },
    { bytes: new TextEncoder().encode("hello"), path: "a/b/c.txt" },
  ]);
  const files = await unpackTar(archive);
  assert.deepEqual([...files.keys()], ["a/b/c.txt", `${LONG_PATH}/SKILL.md`]);
  assert.deepEqual(files.get(`${LONG_PATH}/SKILL.md`), bytes);
  assert.equal(new TextDecoder().decode(files.get("a/b/c.txt")), "hello");
});

test("tar output is byte-identical regardless of input order", async () => {
  const left = await packTar([
    { bytes: new TextEncoder().encode("one"), path: "b.md" },
    { bytes: new TextEncoder().encode("two"), path: "a.md" },
  ]);
  const right = await packTar([
    { bytes: new TextEncoder().encode("two"), path: "a.md" },
    { bytes: new TextEncoder().encode("one"), path: "b.md" },
  ]);
  assert.deepEqual(left, right);
});

test("syncing the same fixture twice produces identical snapshot bytes", async () => {
  const first = await tempDir();
  const second = await tempDir();
  try {
    const one = await syncExternalSkills({ fixtureDir: FIXTURE, now: NOW, outDir: first });
    const two = await syncExternalSkills({ fixtureDir: FIXTURE, now: NOW, outDir: second });
    assert.deepEqual(await readFile(path.join(first, "index.json")), await readFile(path.join(second, "index.json")));
    assert.deepEqual(await readFile(path.join(first, "snapshot.tar.gz")), await readFile(path.join(second, "snapshot.tar.gz")));
    assert.deepEqual(one.tarGz, two.tarGz);
    assert.equal(one.index.skills.length, 4);
    assert.equal(one.index.fetchedAt, "2026-11-17T08:00:00.000Z");
  } finally {
    await rm(first, { force: true, recursive: true });
    await rm(second, { force: true, recursive: true });
  }
});

test("the index parses README_ZH.md and keeps skills the README forgot", async () => {
  const outDir = await tempDir();
  try {
    const { index, warnings } = await syncExternalSkills({ fixtureDir: FIXTURE, now: NOW, outDir });
    const byPath = new Map(index.skills.map((skill) => [skill.path, skill]));
    assert.deepEqual(byPath.get("biology/bioinformatics/abalign"), {
      hardware: "cpu",
      path: "biology/bioinformatics/abalign",
      sha256: byPath.get("biology/bioinformatics/abalign")!.sha256,
      size: byPath.get("biology/bioinformatics/abalign")!.size,
      type: "know-how",
    });
    assert.equal(byPath.get("biology/general_tools/two-word-tool")?.hardware, "gpu-cpu");
    assert.equal(byPath.get(LONG_PATH)?.type, "ai-model");
    assert.equal(byPath.get("research_tools/general_tools/unsorted-tool")?.type, null);
    assert.equal(byPath.get("research_tools/general_tools/unsorted-tool")?.hardware, null);
    assert.ok(warnings.some((warning) => warning.includes("research_tools/general_tools/unsorted-tool: absent from README_ZH.md")));
    assert.ok(warnings.some((warning) => warning.includes("listed more than once")));
    assert.ok(warnings.some((warning) => warning.includes("biology/general_tools/ghost-tool: listed in README_ZH.md but there is no such directory")));
    assert.ok(warnings.some((warning) => warning.includes('labels the skill "long-name-alias"')));
  } finally {
    await rm(outDir, { force: true, recursive: true });
  }
});

test("README rows survive a trailing slash and a hyphenated subdomain", () => {
  const warnings: string[] = [];
  const rows = parseReadmeTables("| [x](biology/general-tools/x/) | general-tools | AI model | GPU |", warnings);
  assert.deepEqual(rows.get("biology/general_tools/x"), {
    hardware: "gpu",
    name: "x",
    path: "biology/general_tools/x",
    type: "ai-model",
  });
});

test("the snapshot tarball carries SKILL.md byte for byte", async () => {
  const outDir = await tempDir();
  try {
    await syncExternalSkills({ fixtureDir: FIXTURE, now: NOW, outDir });
    const files = await unpackTar(gunzipSync(await readFile(path.join(outDir, "snapshot.tar.gz"))));
    assert.equal(files.size, 4);
    for (const skillPath of files.keys()) {
      assert.ok(skillPath.endsWith("/SKILL.md"));
      const source = skillPath.slice(0, -"/SKILL.md".length);
      assert.deepEqual(files.get(skillPath), new Uint8Array(await readFile(path.join(FIXTURE, source, "SKILL.md"))));
    }
  } finally {
    await rm(outDir, { force: true, recursive: true });
  }
});

test("a failed sync leaves the previous snapshot untouched", async () => {
  const fixture = await tempDir();
  const outDir = await tempDir();
  try {
    await cp(FIXTURE, fixture, { recursive: true });
    await rm(path.join(fixture, "biology/general_tools/two-word-tool/SKILL.md"));
    await mkdir(outDir, { recursive: true });
    await writeFile(path.join(outDir, "index.json"), "previous index\n");
    await writeFile(path.join(outDir, "snapshot.tar.gz"), "previous snapshot\n");
    await assert.rejects(() => syncExternalSkills({ fixtureDir: fixture, now: NOW, outDir }), /ENOENT/);
    assert.equal(await readFile(path.join(outDir, "index.json"), "utf8"), "previous index\n");
    assert.equal(await readFile(path.join(outDir, "snapshot.tar.gz"), "utf8"), "previous snapshot\n");
  } finally {
    await rm(fixture, { force: true, recursive: true });
    await rm(outDir, { force: true, recursive: true });
  }
});

test("external assets carry author, category, version and a byte-faithful package", async () => {
  const outDir = await tempDir();
  try {
    await syncExternalSkills({ fixtureDir: FIXTURE, now: NOW, outDir });
    const snapshot = await loadExternalSnapshot({ dir: outDir });
    assert.ok(snapshot);
    const { assets, warnings } = collectExternalSkills(snapshot);
    assert.deepEqual(warnings, []);
    const abalign = assets.find((entry) => entry.asset.id === "biology/bioinformatics/abalign");
    assert.ok(abalign);
    const asset = abalign.asset as SkillAsset;
    assert.equal(asset.name, "abalign");
    assert.equal(asset.author, "Co-authored by Yang Cao Lab and MindSpore Science Team");
    assert.deepEqual(asset.category, { domain: "biology", subdomain: "bioinformatics" });
    assert.equal(asset.version, "snapshot-20261117");
    assert.equal(asset.type, "know-how");
    assert.equal(asset.hardware, "cpu");
    assert.equal(asset.source, "mindscience");
    assert.equal(asset.download.url, "packages/bioinformatics-abalign.zip");
    assert.equal(asset.readme, "skills/external/biology/bioinformatics/abalign.md");
    assert.equal(abalign.markdown.split("\n")[0], "# abalign");

    const packaged = unzipSync(abalign.zip);
    assert.deepEqual(Object.keys(packaged), ["SKILL.md"]);
    assert.deepEqual(packaged["SKILL.md"], new Uint8Array(await readFile(path.join(FIXTURE, "biology/bioinformatics/abalign/SKILL.md"))));

    const twoWord = assets.find((entry) => entry.asset.id === "biology/general_tools/two-word-tool");
    assert.equal(twoWord?.asset.author, null);
    const unsorted = assets.find((entry) => entry.asset.id === "research_tools/general_tools/unsorted-tool");
    assert.equal(unsorted?.asset.type, null);
    assert.equal(unsorted?.asset.hardware, null);
  } finally {
    await rm(outDir, { force: true, recursive: true });
  }
});

test("the exporter folds external skills into the catalog and its categories", async () => {
  const outDir = await tempDir();
  const snapshotDir = await tempDir();
  try {
    await syncExternalSkills({ fixtureDir: FIXTURE, now: NOW, outDir: snapshotDir });
    const { catalog } = await exportHub({ externalSkillsDir: snapshotDir, outDir });
    const skills = catalog.assets.filter((asset): asset is SkillAsset => asset.kind === "skill");
    assert.equal(skills.length, 15 + 4);
    assert.equal(catalog.assets.filter((asset) => asset.kind === "team-skill").length, 2);
    assert.deepEqual(catalog.sources.externalSkills, {
      commit: "fixture",
      fetchedAt: "2026-11-17T08:00:00.000Z",
      ref: "fixture",
      repo: "fixture",
    });
    const external = skills.filter((asset) => asset.source === "mindscience");
    assert.equal(external.length, 4);
    const biology = catalog.categories.skill.find((node) => node.id === "biology");
    assert.ok(biology);
    assert.equal(biology.count, 2 + external.filter((asset) => asset.category.domain === "biology").length);
    const categoryTotal = catalog.categories.skill.reduce((total, node) => total + node.count, 0);
    assert.equal(categoryTotal, catalog.assets.filter((asset) => asset.kind === "skill").length);

    const abalign = external.find((asset) => asset.id === "biology/bioinformatics/abalign")!;
    const readme = await readFile(path.join(outDir, abalign.readme), "utf8");
    assert.ok(readme.startsWith("# abalign"));
    const packaged = unzipSync(new Uint8Array(await readFile(path.join(outDir, abalign.download.url))));
    assert.deepEqual(packaged["SKILL.md"], new Uint8Array(await readFile(path.join(FIXTURE, "biology/bioinformatics/abalign/SKILL.md"))));
  } finally {
    await rm(outDir, { force: true, recursive: true });
    await rm(snapshotDir, { force: true, recursive: true });
  }
});

test("buildSnapshot rejects a malformed SKILL.md instead of publishing it", async () => {
  const fixture = await tempDir();
  try {
    await cp(FIXTURE, fixture, { recursive: true });
    await writeFile(path.join(fixture, "biology/general_tools/two-word-tool/SKILL.md"), "no frontmatter here");
    const source = {
      commit: "test",
      description: "test",
      ref: "test",
      repo: "test",
      async listSkillPaths(): Promise<string[]> {
        return ["biology/general_tools/two-word-tool"];
      },
      async readSkill(): Promise<Uint8Array> {
        return readFile(path.join(fixture, "biology/general_tools/two-word-tool/SKILL.md"));
      },
      async readme(): Promise<Uint8Array> {
        return readFile(path.join(fixture, "README_ZH.md"));
      },
    };
    await assert.rejects(() => buildSnapshot(source, NOW), /frontmatter/);
  } finally {
    await rm(fixture, { force: true, recursive: true });
  }
});


test("a bucket without a snapshot publishes the built-in catalogue", async () => {
  const server = createServer((_request, response) => {
    response.writeHead(404);
    response.end("not found");
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address ? address.port : 0;
  try {
    const snapshot = await loadExternalSnapshot({
      url: `http://127.0.0.1:${port}/external-skills`,
    });
    assert.equal(snapshot, null);
  } finally {
    server.close();
  }
});
