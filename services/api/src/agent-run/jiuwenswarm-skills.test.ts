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
import { createTest } from "../../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });

import { importSkillsToJiuwenSwarm, listJiuwenSwarmSkills, setJiuwenSwarmLanguage, setJiuwenSwarmSkillEnabled, skillLoadedBy } from "./jiuwenswarm-skills.js";

const ids = new Map([["evolve-design", "evolve-design"], ["sciencediscovery-skill-creator", "skill-creator"]]);

test("skill_tool on a skill's SKILL.md, or read_file of it, loads that skill", () => {
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "evolve-design" } }, ids), "evolve-design");
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "sciencediscovery-skill-creator", relative_file_path: "SKILL.md" } }, ids), "skill-creator");
  assert.equal(skillLoadedBy({ name: "read_file", args: { file_path: "/home/jiuwenswarm-user/.jiuwenswarm-instances/x/agent/workspace/skills/evolve-design/SKILL.md" } }, ids), "evolve-design");
});

test("a supporting file, another skill or another tool is not a load", () => {
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "evolve-design", relative_file_path: "references/a.md" } }, ids), undefined);
  assert.equal(skillLoadedBy({ name: "skill_tool", args: { skill_name: "skill-creator" } }, ids), undefined, "JiuwenSwarm's own skill-creator is not ours");
  assert.equal(skillLoadedBy({ name: "read_file", args: { file_path: "/w/notes/SKILL.md" } }, ids), undefined);
  assert.equal(skillLoadedBy({ name: "bash", args: { command: "cat skills/evolve-design/SKILL.md" } }, ids), undefined);
});

test("an adapter that cannot install skills leaves them all ours", async () => {
  const failing = (async () => new Response("down", { status: 502 })) as unknown as typeof fetch;
  const imported = await importSkillsToJiuwenSwarm({ adapterUrl: "http://a", fetch: failing }, [{ id: "x", hash: "h" }], "/skill-packages");
  assert.equal(imported.size, 0);
});

test("the skill list and the on/off switch go to the adapter with its token", async () => {
  const calls: Array<{ url: string; method: string; body?: string; auth?: string }> = [];
  const fake = (async (url: string, init: RequestInit) => {
    calls.push({ url, method: String(init.method), body: init.body as string | undefined, auth: (init.headers as Record<string, string>).authorization });
    return new Response(JSON.stringify(url.endsWith("/agent/skills") ? { skills: [{ name: "xlsx", description: "d", enabled: true, source: "builtin" }] } : { name: "xlsx", enabled: false }));
  }) as unknown as typeof fetch;
  const config = { adapterUrl: "http://a", adapterToken: "t", fetch: fake };
  assert.deepEqual(await listJiuwenSwarmSkills(config), [{ name: "xlsx", description: "d", enabled: true, source: "builtin" }]);
  await setJiuwenSwarmSkillEnabled(config, "xlsx", false);
  assert.deepEqual(calls, [
    { url: "http://a/agent/skills", method: "GET", body: undefined, auth: "Bearer t" },
    { url: "http://a/agent/skills/xlsx/enabled", method: "POST", body: JSON.stringify({ enabled: false }), auth: "Bearer t" },
  ]);
});

test("a refused switch is an error, not silence", async () => {
  const refusing = (async () => new Response("no", { status: 502 })) as unknown as typeof fetch;
  await assert.rejects(setJiuwenSwarmSkillEnabled({ adapterUrl: "http://a", fetch: refusing }, "xlsx", false), /HTTP 502/);
});

test("the UI's language is sent to the adapter as JiuwenSwarm's", async () => {
  const calls: Array<{ url: string; body?: string }> = [];
  const fake = (async (url: string, init: RequestInit) => { calls.push({ url, body: init.body as string }); return new Response("{}"); }) as unknown as typeof fetch;
  await setJiuwenSwarmLanguage({ adapterUrl: "http://a", fetch: fake }, "en");
  assert.deepEqual(calls, [{ url: "http://a/agent/language", body: JSON.stringify({ language: "en" }) }]);
});
