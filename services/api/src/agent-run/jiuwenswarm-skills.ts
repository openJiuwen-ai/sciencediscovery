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

import { join } from "node:path";

import type { JiuwenSwarmSkill } from "@sciencediscovery/schema";

import type { JiuwenSwarmAgentConfig } from "./jiuwenswarm-agent.js";

/**
 * A run's skills, installed in JiuwenSwarm.
 *
 * With the JiuwenSwarm backend its own skill mechanism is used: its prompt lists the installed skills and the
 * model loads one with `skill_tool` (or reads its SKILL.md). The frozen packages the API staged for the run
 * are imported there through the adapter (`skills.import_local`); a skill whose name JiuwenSwarm already uses
 * is installed as `sciencediscovery-<id>`.
 *
 * Returns, by skill id, the name JiuwenSwarm lists it under. A skill missing from the answer was not
 * imported, and the run offers it the ScienceDiscovery way. Never throws.
 */
export async function importSkillsToJiuwenSwarm(
  config: Pick<JiuwenSwarmAgentConfig, "adapterToken" | "adapterUrl" | "fetch">,
  skills: ReadonlyArray<{ hash: string; id: string }>,
  packagesRoot: string,
  signal?: AbortSignal,
): Promise<Map<string, string>> {
  const imported = new Map<string, string>();
  if (!skills.length) return imported;
  try {
    const response = await (config.fetch ?? fetch)(`${config.adapterUrl}/agent/skills`, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(config.adapterToken ? { authorization: `Bearer ${config.adapterToken}` } : {}),
      },
      body: JSON.stringify({ skills: skills.map(({ hash, id }) => ({ hash, id, path: join(packagesRoot, id) })) }),
      ...(signal ? { signal } : {}),
    });
    if (!response.ok) throw new Error(`HTTP ${response.status} ${(await response.text().catch(() => "")).slice(0, 200)}`);
    const answer = await response.json() as { skills?: Record<string, { error?: string; name?: string }> };
    for (const [id, result] of Object.entries(answer.skills ?? {})) {
      if (result.name) imported.set(id, result.name);
      else console.warn(`[jiuwenswarm] skill ${id} stays with ScienceDiscovery: ${result.error ?? "not imported"}`);
    }
  } catch (error) {
    console.warn(`[jiuwenswarm] could not install the run's skills in JiuwenSwarm: ${error instanceof Error ? error.message : String(error)}`);
  }
  return imported;
}

/**
 * The skill a JiuwenSwarm tool call loaded, by ScienceDiscovery id: `skill_tool` on a skill's SKILL.md, or
 * `read_file` of `.../<name>/SKILL.md`. `ids` maps JiuwenSwarm's names to ours.
 */
export function skillLoadedBy(call: { args: unknown; name: string }, ids: ReadonlyMap<string, string>): string | undefined {
  const args = (call.args ?? {}) as Record<string, unknown>;
  if (call.name === "skill_tool") {
    const file = typeof args.relative_file_path === "string" && args.relative_file_path.trim() ? args.relative_file_path.trim() : "SKILL.md";
    return file.replace(/^\.\//, "") === "SKILL.md" && typeof args.skill_name === "string" ? ids.get(args.skill_name.trim()) : undefined;
  }
  if (call.name === "read_file") {
    const path = [args.file_path, args.path].find((value): value is string => typeof value === "string");
    const name = path?.replaceAll("\\", "/").match(/\/skills\/([^/]+)\/SKILL\.md$/)?.[1];
    return name ? ids.get(name) : undefined;
  }
  return undefined;
}

async function adapterCall<T>(config: Pick<JiuwenSwarmAgentConfig, "adapterToken" | "adapterUrl" | "fetch">, path: string, body?: unknown): Promise<T> {
  const response = await (config.fetch ?? fetch)(`${config.adapterUrl}${path}`, {
    method: body === undefined ? "GET" : "POST",
    headers: {
      ...(body === undefined ? {} : { "content-type": "application/json" }),
      ...(config.adapterToken ? { authorization: `Bearer ${config.adapterToken}` } : {}),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`JiuwenSwarm (through the adapter) answered HTTP ${response.status}: ${(await response.text().catch(() => "")).slice(0, 200)}`);
  return await response.json() as T;
}

/** Every skill JiuwenSwarm has installed and whether it is on. */
export async function listJiuwenSwarmSkills(config: Pick<JiuwenSwarmAgentConfig, "adapterToken" | "adapterUrl" | "fetch">): Promise<JiuwenSwarmSkill[]> {
  return (await adapterCall<{ skills?: JiuwenSwarmSkill[] }>(config, "/agent/skills")).skills ?? [];
}

/** Switch one of JiuwenSwarm's skills on or off. It is one setting for every session; sessions started afterwards see it. */
export async function setJiuwenSwarmSkillEnabled(
  config: Pick<JiuwenSwarmAgentConfig, "adapterToken" | "adapterUrl" | "fetch">, name: string, enabled: boolean,
): Promise<void> {
  await adapterCall(config, `/agent/skills/${encodeURIComponent(name)}/enabled`, { enabled });
}

/**
 * JiuwenSwarm's language, from the UI's: its own prompt, rails and tools, and the language it asks the model to
 * answer in. One setting for every session (sessions started afterwards use it).
 */
export async function setJiuwenSwarmLanguage(
  config: Pick<JiuwenSwarmAgentConfig, "adapterToken" | "adapterUrl" | "fetch">, language: "en" | "zh",
): Promise<void> {
  await adapterCall(config, "/agent/language", { language });
}
