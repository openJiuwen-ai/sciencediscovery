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

/**
 * The settings dialog unmounts a pane when the user picks another group, so
 * without a cache every visit paints `TEXT.settings.loading` before the answer
 * arrives — the frame a user reads as "the app is slow". These tests pin the
 * two properties that make the next visit paint immediately: the last answer
 * is kept, and it is kept under the client and page it belongs to.
 */

import { createTest } from "../../../test/support/tagged/compat.mjs";
const { describe, it } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself uses the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";

import { writeSettingsCache } from "../src/app/settings-cache.js";
import type { RuntimeSettingsOverrides, SkillDescriptor, Specialist } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { SkillsSettings } from "../src/views/settings/SkillsSettings.js";
import { SpecialistsSettings } from "../src/views/settings/system/Specialists.js";
import { StubClient } from "./api-stub.js";

const noop = () => {};

function skill(id: string, name: string): SkillDescriptor {
  return {
    currentRevision: 1,
    description: `${name} 的说明`,
    diagnostics: [],
    hash: "hash",
    id,
    name,
    readOnly: false,
    resourceSummary: { bytes: 0, files: 0, kinds: { asset: 0, other: 0, reference: 0, script: 0 } },
    source: "managed",
    version: "revision:1",
  } as SkillDescriptor;
}

function specialist(name: string): Specialist {
  return {
    connectorIds: [],
    createdAt: "2026-01-01T00:00:00.000Z",
    description: "审阅初稿",
    enabledSkillIds: [],
    id: `spec-${name}`,
    instructions: "先读再评。",
    name,
    runtime: { kind: "native" },
    updatedAt: "2026-01-01T00:00:00.000Z",
  } as Specialist;
}

function skillsPage(skills: SkillDescriptor[], enabled: string[]) {
  return { enabled, overrides: {} as RuntimeSettingsOverrides, skills };
}

describe("a settings pane's remembered answer", () => {
  it("paints the last list instead of the loading frame on the next visit", () => {
    const client = new StubClient().asClient();
    writeSettingsCache(client, "specialists", {
      connectors: [],
      skills: [],
      specialists: [specialist("审稿人")],
    });

    const markup = renderToStaticMarkup(<SpecialistsSettings client={client} onConfirm={noop} />);

    assert.ok(markup.includes("审稿人"), "the remembered list is not on screen");
    assert.ok(!markup.includes(TEXT.settings.loading), "the loading frame is still drawn over a remembered list");
  });

  it("does not paint a remembered list under another client", () => {
    const visited = new StubClient().asClient();
    writeSettingsCache(visited, "specialists", {
      connectors: [],
      skills: [],
      specialists: [specialist("审稿人")],
    });

    const fresh = new StubClient().asClient();
    const markup = renderToStaticMarkup(<SpecialistsSettings client={fresh} onConfirm={noop} />);

    assert.ok(markup.includes(TEXT.settings.loading), "a page that has never been visited starts at the loading frame");
    assert.ok(!markup.includes("审稿人"), "another client's list leaked into this one");
  });

  it("does not paint one Project's enabled Skills as another's", () => {
    const client = new StubClient().asClient();
    writeSettingsCache(client, "skills:project-a", skillsPage([skill("draft-review", "draft-review")], ["draft-review"]));

    const visited = renderToStaticMarkup(
      <SkillsSettings activeProjectId="project-a" adding={false} client={client} onAddingChange={noop} />,
    );
    assert.ok(visited.includes("draft-review"), "the remembered Skills are not on screen");
    assert.ok(!visited.includes(TEXT.settings.loading), "the loading frame is still drawn over remembered Skills");

    const other = renderToStaticMarkup(
      <SkillsSettings activeProjectId="project-b" adding={false} client={client} onAddingChange={noop} />,
    );
    assert.ok(other.includes(TEXT.settings.loading), "an unvisited Project does not start at the loading frame");
    assert.ok(!other.includes("draft-review"), "one Project's enabled Skills leaked into another");
  });
});
