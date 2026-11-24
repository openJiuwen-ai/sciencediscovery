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
import type { RunnerTarget, SkillDescriptor, Specialist } from "../src/api/types.js";
import { TEXT } from "../src/text.js";
import { LoadGate, SkeletonRegion } from "../src/views/settings/rows.js";
import { RuntimeSettings } from "../src/views/settings/RuntimeSettings.js";
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

/** The page's whole shape, because the cache is painted as it was written: a
 *  fixture missing a field the pane reads is a crash, not a stale frame. */
function specialistsPage() {
  return {
    connectors: [],
    reviewer: { enabled: true },
    skills: [],
    specialists: [specialist("审稿人")],
  };
}

function skillsPage(skills: SkillDescriptor[], enabled: string[]) {
  return { enabled, jiuwenSwarmSkills: [], native: false, skills, switchesAvailable: true };
}

function runner(over: Partial<RunnerTarget> = {}): RunnerTarget {
  return {
    alias: "gpu-01",
    connectionKind: "ssh",
    createdAt: "2026-10-01T08:00:00.000Z",
    id: "runner-1",
    location: "remote",
    runnerCommand: "sciencediscovery-runner",
    runnerStatus: { hostId: "runner-1", state: "disconnected" },
    status: "ready",
    updatedAt: "2026-10-01T08:00:00.000Z",
    ...over,
  };
}

describe("a settings pane's remembered answer", () => {
  it("paints the last list instead of the loading frame on the next visit", () => {
    const client = new StubClient().asClient();
    writeSettingsCache(client, "specialists", specialistsPage());

    const markup = renderToStaticMarkup(<SpecialistsSettings client={client} onConfirm={noop} />);

    assert.ok(markup.includes("审稿人"), "the remembered list is not on screen");
    assert.ok(!markup.includes(TEXT.settings.loading), "the loading frame is still drawn over a remembered list");
  });

  it("does not paint a remembered list under another client", () => {
    const visited = new StubClient().asClient();
    writeSettingsCache(visited, "specialists", specialistsPage());

    const fresh = new StubClient().asClient();
    const markup = renderToStaticMarkup(<SpecialistsSettings client={fresh} onConfirm={noop} />);

    assert.ok(markup.includes(TEXT.settings.loading), "a page that has never been visited starts at the loading frame");
    assert.ok(!markup.includes("审稿人"), "another client's list leaked into this one");
  });

  it("paints the remembered Skills for the client that visited, and not for another", () => {
    const client = new StubClient().asClient();
    writeSettingsCache(client, "skills:jiuwenswarm", skillsPage([skill("draft-review", "draft-review")], ["draft-review"]));

    const visited = renderToStaticMarkup(
      <SkillsSettings client={client} />,
    );
    assert.ok(visited.includes("draft-review"), "the remembered Skills are not on screen");
    assert.ok(!visited.includes(TEXT.settings.loading), "the loading frame is still drawn over remembered Skills");

    const fresh = new StubClient().asClient();
    const other = renderToStaticMarkup(
      <SkillsSettings client={fresh} />,
    );
    assert.ok(other.includes(TEXT.settings.loading), "a client that never visited starts at the loading frame");
    assert.ok(!other.includes("draft-review"), "another client's remembered Skills leaked into this one");
  });

  it("paints the remembered Runner catalog instead of the runtime skeleton", () => {
    const client = new StubClient().asClient();
    writeSettingsCache(client, "runner-catalog", [runner()]);

    const markup = renderToStaticMarkup(<RuntimeSettings client={client} onConfirm={noop} />);

    assert.ok(markup.includes("gpu-01"), "the remembered Runner is not on screen");
    assert.ok(!markup.includes('aria-busy="true"'), "the skeleton is still drawn over a remembered catalog");
    assert.ok(!markup.includes(TEXT.settings.system.migrated.environments.skeleton),
      "the runtime pane fell back to its first-paint skeleton");
  });

  it("does not paint a remembered Runner catalog under another client", () => {
    const visited = new StubClient().asClient();
    writeSettingsCache(visited, "runner-catalog", [runner()]);

    const fresh = new StubClient().asClient();
    const markup = renderToStaticMarkup(<RuntimeSettings client={fresh} onConfirm={noop} />);

    assert.ok(markup.includes(TEXT.settings.system.migrated.environments.skeleton),
      "a client that never visited does not paint the runtime skeleton");
    assert.ok(markup.includes('aria-busy="true"'), "the first paint is not marked busy");
    assert.ok(!markup.includes("gpu-01"), "another client's Runner catalog leaked into this one");
  });
});

/**
 * A page with a layout of its own draws that layout on the cache-miss frame,
 * and a page with a remembered answer never draws it at all. This is the
 * `LoadGate` seam both heavy panes share.
 */
describe("a page's first-paint skeleton", () => {
  const skeleton = <SkeletonRegion label="正在读取页面…"><span className="settings-skeleton-block" /></SkeletonRegion>;

  it("replaces the single loading line only while there is no answer", () => {
    const first = renderToStaticMarkup(
      <LoadGate loaded={{ loading: true, reload: noop }} skeleton={skeleton}>
        {() => <p>never drawn</p>}
      </LoadGate>,
    );
    assert.ok(first.includes('aria-busy="true"'), "the skeleton is not marked busy");
    assert.ok(first.includes("正在读取页面…"), "the skeleton carries no accessible label");
    assert.ok(!first.includes(TEXT.settings.loading), "the single loading line is still drawn");
    assert.ok(!first.includes("never drawn"), "a page with no answer drew content anyway");

    const answered = renderToStaticMarkup(
      <LoadGate loaded={{ loading: false, reload: noop, value: ["已读"] }} skeleton={skeleton}>
        {(names) => <p>{names.join(",")}</p>}
      </LoadGate>,
    );
    assert.ok(answered.includes("已读"), "the answer is not on screen");
    assert.ok(!answered.includes('aria-busy="true"'), "the skeleton survived the answer");
  });

  it("keeps the single loading line for pages without a layout skeleton", () => {
    const markup = renderToStaticMarkup(
      <LoadGate loaded={{ loading: true, reload: noop }}>
        {() => <p>never drawn</p>}
      </LoadGate>,
    );
    assert.ok(markup.includes(TEXT.settings.loading), "a page without a skeleton lost its loading frame");
  });
});

/**
 * A remembered answer is painted before the refresh behind it answers, so the
 * refresh can fail while a list is on screen. Keeping that list is the point:
 * the failure is drawn above it, with the retry the error section already had.
 */
describe("a pane whose refresh fails", () => {
  it("keeps the answer it painted, above the failure", () => {
    const markup = renderToStaticMarkup(
      <LoadGate loaded={{ error: "无法刷新列表", loading: false, reload: noop, value: ["分子绘图"] }}>
        {(names) => <p>{names.join(",")}</p>}
      </LoadGate>,
    );

    assert.ok(markup.includes("无法刷新列表"), "the failure is not on screen");
    assert.ok(markup.includes("分子绘图"), "the list the pane had painted was thrown away");
    assert.ok(
      markup.indexOf("无法刷新列表") < markup.indexOf("分子绘图"),
      "the failure is drawn below the stale list instead of above it",
    );
    assert.ok(markup.includes(TEXT.settings.retry), "the failure offers no retry");
  });

  it("draws the failure alone when there is no answer to keep", () => {
    const markup = renderToStaticMarkup(
      <LoadGate loaded={{ error: "无法刷新列表", loading: false, reload: noop, value: undefined }}>
        {() => <p>never drawn</p>}
      </LoadGate>,
    );

    assert.ok(markup.includes("无法刷新列表"));
    assert.ok(!markup.includes("never drawn"), "a page with no answer drew content anyway");
  });
});
