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
import { mkdtemp, readFile, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, it } from "node:test";

import { unzipSync } from "fflate";

import { exportHub } from "./export.js";

import type { Catalog, CategoryNode, SkillAsset } from "./types.js";

const repoRoot = path.resolve(import.meta.dirname, "../..");

let catalog: Catalog;
let outDir: string;
const temporary: string[] = [];

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

async function exportTo(): Promise<{ catalog: Catalog; outDir: string }> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "hub-export-"));
  temporary.push(dir);
  return await exportHub({ outDir: dir, repoRoot });
}

function counts(nodes: CategoryNode[]): number {
  return nodes.reduce((total, node) => total + (node.children?.length ? counts(node.children) : node.count), 0);
}

before(async () => {
  ({ catalog, outDir } = await exportTo());
});

after(async () => {
  await Promise.all(temporary.map((dir) => rm(dir, { force: true, recursive: true })));
});

describe("catalog", () => {
  it("exports every built-in asset exactly once", () => {
    const kinds = (kind: string): number => catalog.assets.filter((asset) => asset.kind === kind).length;
    assert.equal(kinds("skill"), 15);
    assert.equal(kinds("team-skill"), 2);
    assert.equal(kinds("specialist"), 8);
    assert.equal(kinds("connector"), 13);
    assert.equal(catalog.assets.length, 38);
    const ids = catalog.assets.map((asset) => asset.id);
    assert.equal(new Set(ids).size, ids.length, "asset ids must be unique");
  });

  it("gives every asset the fields the site renders", () => {
    for (const asset of catalog.assets) {
      assert.ok(asset.id, "id");
      assert.ok(asset.name, `name of ${asset.id}`);
      assert.ok(asset.description, `description of ${asset.id}`);
      assert.ok(asset.download.url, `download url of ${asset.id}`);
      assert.equal(asset.source, "builtin");
      assert.ok(asset.version === null || /^\d+\.\d+\.\d+$/u.test(asset.version), `version of ${asset.id}`);
    }
  });

  it("resolves every cross reference inside the catalog", () => {
    const skills = new Set(catalog.assets.filter((asset) => asset.kind === "skill" || asset.kind === "team-skill").map((asset) => asset.id));
    const specialists = new Set(catalog.assets.filter((asset) => asset.kind === "specialist").map((asset) => asset.id));
    const connectors = new Set(catalog.assets.filter((asset) => asset.kind === "connector").map((asset) => asset.id));
    for (const asset of catalog.assets) {
      for (const id of asset.related?.skills ?? []) assert.ok(skills.has(id), `${asset.id} -> skill ${id}`);
      for (const id of asset.related?.specialists ?? []) assert.ok(specialists.has(id), `${asset.id} -> specialist ${id}`);
      for (const id of asset.related?.connectors ?? []) assert.ok(connectors.has(id), `${asset.id} -> connector ${id}`);
      if (asset.kind === "specialist") {
        for (const id of asset.skills) assert.ok(skills.has(id), `${asset.id} binds skill ${id}`);
        for (const id of asset.connectors) assert.ok(connectors.has(id), `${asset.id} binds connector ${id}`);
      }
    }
  });

  it("declares team members that resolve to specialists and their skills", () => {
    const team = catalog.assets.filter((asset): asset is SkillAsset => asset.kind === "team-skill");
    assert.deepEqual(team.map((asset) => asset.id), ["idea-tree-team", "science-research-team"]);
    for (const asset of team) {
      assert.ok(asset.members?.length, `${asset.id} declares members`);
      assert.deepEqual(asset.related?.specialists, asset.members);
      const skills = (asset.members ?? []).flatMap((member) => {
        const specialist = catalog.assets.find((candidate) => candidate.id === member && candidate.kind === "specialist");
        assert.ok(specialist?.kind === "specialist", `${asset.id} member ${member} resolves to a specialist`);
        return specialist.skills;
      });
      assert.deepEqual(asset.related?.skills, [...new Set(skills)]);
    }
  });

  it("labels every category in both languages and counts what is listed", () => {
    const total = (kind: string): number => catalog.assets.filter((asset) => asset.kind === kind).length;
    // Team skills are their own tab in the site, so the skills tree counts only skills.
    assert.equal(counts(catalog.categories.skill), total("skill"));
    assert.equal(counts(catalog.categories.connector), total("connector"));
    assert.equal(counts(catalog.categories.sessionPackage), 0);
    const walk = (nodes: CategoryNode[]): void => {
      for (const node of nodes) {
        assert.ok(node.label.en, `${node.id} has an English label`);
        assert.ok(node.label.zh, `${node.id} has a Chinese label`);
        if (node.children) walk(node.children);
      }
    };
    walk(catalog.categories.skill);
    walk(catalog.categories.connector);
  });

  it("reads the version the runtime reads, and reports nothing when there is none", () => {
    // metadata.version wins over the bundled table, exactly as the app resolves it.
    assert.equal(catalog.assets.find((asset) => asset.id === "evolve-design")?.version, "1.3.0");
    // No metadata.version: the bundled table is the only source.
    assert.equal(catalog.assets.find((asset) => asset.id === "antibody-design")?.version, "1.0.0");
    // Specialists carry no version at all; the site renders "—" rather than a guess.
    const specialists = catalog.assets.filter((asset) => asset.kind === "specialist");
    assert.ok(specialists.every((asset) => asset.version === null));
  });
});

describe("downloads", () => {
  it("ships a zip whose SKILL.md matches the repository byte for byte", async () => {
    const samples = ["literature-searcher", "evolve-design", "structure-pocket-inspection"];
    for (const id of samples) {
      const asset = catalog.assets.find((candidate) => candidate.id === id);
      assert.ok(asset && (asset.kind === "skill" || asset.kind === "team-skill"));
      const zip = await readFile(path.join(outDir, asset.download.url));
      assert.equal(sha256(zip), asset.download.sha256, `${id} sha256`);
      assert.equal(zip.byteLength, asset.download.size, `${id} size`);
      const files = unzipSync(zip);
      const markdown = files["SKILL.md"];
      assert.ok(markdown, `${id} zip contains SKILL.md`);
      assert.deepEqual(Buffer.from(markdown), await readFile(path.join(repoRoot, "skills", id, "SKILL.md")), `${id} SKILL.md`);
    }
  });

  it("rebuilds identical bytes for the same sources", async () => {
    const second = await exportTo();
    for (const asset of catalog.assets.filter((candidate) => candidate.kind !== "specialist")) {
      const first = await readFile(path.join(outDir, asset.download.url));
      const again = await readFile(path.join(second.outDir, asset.download.url));
      assert.deepEqual(again, first, `${asset.id} is reproducible`);
    }
  });

  it("publishes the full SKILL.md body the detail page renders", async () => {
    const asset = catalog.assets.find((candidate) => candidate.id === "life-science-evidence-brief");
    assert.ok(asset && (asset.kind === "skill" || asset.kind === "team-skill"));
    const body = await readFile(path.join(outDir, asset.readme), "utf8");
    assert.ok(body.includes("# "), "body keeps its headings");
    assert.ok(!body.startsWith("---"), "frontmatter is not part of the rendered body");
  });

  it("serves every skill file so the Files tab can preview it", async () => {
    const skills = catalog.assets.filter((asset): asset is SkillAsset => asset.kind === "skill" || asset.kind === "team-skill");
    let served = 0;
    for (const skill of skills) {
      for (const resource of skill.resources) {
        assert.equal(resource.url, `skills/${skill.id}/${resource.path}`, `${skill.id} serves ${resource.path}`);
        const bytes = await readFile(path.join(outDir, resource.url));
        assert.equal(bytes.byteLength, resource.size, `${skill.id}/${resource.path} size`);
        assert.deepEqual(bytes, await readFile(path.join(repoRoot, "skills", skill.id, resource.path)), `${skill.id}/${resource.path} bytes`);
        served += 1;
      }
    }
    // The built-in skills carry scripts and references, so an empty result means
    // the exporter stopped publishing them.
    assert.ok(served > 20, `served ${served} skill files`);
  });

  it("ships a connector launch block that the import dialog accepts verbatim", async () => {
    const asset = catalog.assets.find((candidate) => candidate.id === "pubmed");
    assert.ok(asset?.kind === "connector");
    const file = JSON.parse(await readFile(path.join(outDir, asset.download.url), "utf8")) as {
      mcpServers: Record<string, Record<string, unknown>>;
    };
    assert.deepEqual(Object.keys(file), ["mcpServers"]);
    const entry = file.mcpServers[asset.name];
    assert.ok(entry, `launch block is keyed by ${asset.name}`);
    assert.equal(entry.type, "stdio");
    assert.equal(typeof entry.command, "string");
    assert.ok(Array.isArray(entry.args));
    assert.equal(entry.timeoutSeconds, 60);
    assert.equal(asset.toolCount, asset.tools.length);
  });

  it("ships a specialist record that round-trips its bindings", async () => {
    const asset = catalog.assets.find((candidate) => candidate.id === "builtin-literature-searcher");
    assert.ok(asset?.kind === "specialist");
    const record = JSON.parse(await readFile(path.join(outDir, asset.download.url), "utf8")) as {
      connectorIds: string[];
      enabledSkillIds: string[];
      instructions: string;
    };
    assert.deepEqual(record.connectorIds, asset.connectors);
    assert.deepEqual(record.enabledSkillIds, asset.skills);
    assert.equal(record.instructions, asset.instructions);
    const markdown = await readFile(path.join(outDir, asset.download.text), "utf8");
    assert.ok(markdown.includes(asset.instructions));
  });
});
