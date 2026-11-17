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

import { createHash } from "node:crypto";

import { BUILTIN_SPECIALISTS } from "../../packages/specialist/src/builtins.js";

import type { SpecialistAsset } from "./types.js";

export interface CollectedSpecialist {
  asset: SpecialistAsset;
  json: Uint8Array;
  markdown: string;
}

function sha256(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

function markdownFor(asset: SpecialistMarkdownInput): string {
  return `# ${asset.name}\n\n${asset.description}\n\n## Instructions\n\n${asset.instructions}\n`;
}

type SpecialistMarkdownInput = Pick<SpecialistAsset, "description" | "instructions" | "name">;

export function collectSpecialists(): CollectedSpecialist[] {
  return BUILTIN_SPECIALISTS.map((specialist) => {
    const markdown = markdownFor(specialist);
    // The download is the specialist record itself, so it can be re-imported
    // without the hub having to explain its own schema.
    const json = Buffer.from(`${JSON.stringify(specialist, null, 2)}\n`, "utf8");
    const asset: SpecialistAsset = {
      author: null,
      connectors: [...specialist.connectorIds],
      description: specialist.description,
      download: {
        sha256: sha256(json),
        size: json.byteLength,
        text: `specialists/${specialist.id}.md`,
        url: `specialists/${specialist.id}.json`,
      },
      id: specialist.id,
      instructions: specialist.instructions,
      kind: "specialist",
      name: specialist.name,
      runtime: specialist.runtime ? structuredClone(specialist.runtime) as unknown as Record<string, unknown> : null,
      skills: [...specialist.enabledSkillIds],
      source: "builtin",
      tags: [],
      version: null,
    };
    return { asset, json, markdown };
  });
}
