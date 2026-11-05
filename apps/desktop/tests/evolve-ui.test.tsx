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
const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"],
});
import assert from "node:assert/strict";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvolveRun } from "@sciencediscovery/schema";

import type { ApiClient } from "../src/api/client.js";
import type { EvolveStatus } from "../src/api/evolve.js";
import type { WorkspaceActions } from "../src/app/use-workspace.js";
import type { EvolveCandidateView, EvolveRunView } from "../src/evolve/model.js";
import { emptyRunView } from "../src/evolve/model.js";
import { TEXT } from "../src/text.js";
import { CandidateInspector } from "../src/views/evolve/CandidateInspector.js";
import { CandidateTable } from "../src/views/evolve/CandidateTable.js";
import { EvolveCreateDialog } from "../src/views/evolve/EvolveCreateDialog.js";
import { EvolveOverlay } from "../src/views/evolve/EvolveOverlay.js";
import { EvolveShelf } from "../src/views/evolve/EvolveShelf.js";
import { ScoreChart } from "../src/views/evolve/ScoreChart.js";
import { SessionBar } from "../src/views/SessionBar.js";

const client = {} as ApiClient;
const actions = { renameSession: async () => {} } as unknown as WorkspaceActions;

const budget = {
  candidateTimeoutSeconds: 120,
  expansions: 40,
  maxCostCents: 500,
  maxSeconds: 3600,
  maxTokens: 1_000_000,
  maxTokensPerCall: 32_000,
  workers: 1,
};

function run(over: Partial<EvolveRun> = {}): EvolveRun {
  return {
    algorithm: "puct",
    candidates: 12,
    costCents: 0,
    createdAt: "2026-10-01T09:00:00.000Z",
    goal: {
      algorithm: "puct",
      budget,
      frozen: [],
      modelId: "model-1",
      scorecard: { hash: "sha256:card" },
      schemaVersion: 2,
      statement: "让压缩比更高",
    },
    id: "run-1",
    lastSeq: 10,
    sessionId: "session-1",
    startedAt: "2026-10-01T09:00:00.000Z",
    status: "running",
    tokens: 1200,
    ...over,
  } as unknown as EvolveRun;
}

function candidate(over: Partial<EvolveCandidateView>): EvolveCandidateView {
  return {
    depth: 1,
    nodeIndex: 1,
    parentIndex: 0,
    score: 0.5,
    valid: true,
    visits: 0,
    ...over,
  };
}

function switchTag(html: string): string {
  return html.match(/<input[^>]*role="switch"[^>]*>/)?.[0] ?? "";
}


function view(over: Partial<EvolveRunView> = {}): EvolveRunView {
  return {
    ...emptyRunView(),
    baselineScore: 0.4,
    candidates: [
      candidate({ depth: 0, nodeIndex: 0, parentIndex: null, score: 0.4 }),
      candidate({ accepted: true, gateScore: 0.62, nodeIndex: 1, rolloutScore: 0.55 }),
      candidate({ nodeIndex: 2, parentIndex: 1, score: 0.51 }),
      candidate({ nodeIndex: 3, parentIndex: 0, score: null, valid: false }),
    ],
    expansions: 3,
    status: "running",
    ...over,
  };
}

test("the shelf stays out of a session that has no searches", () => {
  const html = renderToStaticMarkup(
    <EvolveShelf onNew={() => {}} onOpen={() => {}} runs={[]} />,
  );
  assert.equal(html, "");
});

test("a search designed without pauses says so on its chip", () => {
  const html = renderToStaticMarkup(
    <EvolveShelf
      onNew={() => {}}
      onOpen={() => {}}
      runs={[
        run({ goal: { ...run().goal, checkpointMode: "auto" }, id: "auto" }),
        run({ id: "confirm" }),
      ]}
    />,
  );
  // Only the auto run is marked; a goal written before the switch existed has
  // no field and therefore no badge.
  assert.equal((html.match(/evolve-chip-auto/g) ?? []).length, 1);
  assert.match(html, />自动</);
});

test("the shelf shows the running search first and folds the rest", () => {
  const runs = [
    run({ createdAt: "2026-10-01T08:00:00.000Z", id: "old", status: "succeeded" }),
    run({ createdAt: "2026-10-01T10:00:00.000Z", id: "live" }),
    run({ createdAt: "2026-10-01T09:00:00.000Z", id: "finished", status: "stopped" }),
    run({ createdAt: "2026-10-01T07:00:00.000Z", id: "older", status: "failed" }),
  ];
  const html = renderToStaticMarkup(
    <EvolveShelf onNew={() => {}} onOpen={() => {}} runs={runs} />,
  );
  assert.match(html, /evolve-shelf/);
  assert.match(html, /1 个实验运行中/);
  assert.match(html, /还有 1 个/);
  assert.match(html, /新建实验/);
  assert.equal(html.indexOf("is-live") < html.indexOf("已停止"), true);
  assert.equal(html.includes("还有 1 个"), true);
});

test("the cockpit names the run and offers a stop while it is live", () => {
  const html = renderToStaticMarkup(
    <EvolveOverlay
      client={client}
      onClose={() => {}}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.match(html, /evolve-panel/);
  assert.match(html, /让压缩比更高/);
  assert.match(html, /运行中/);
  assert.match(html, />停止</);
  assert.match(html, /最优得分/);
  // The goal is the title, so the full-statement fold is not drawn twice.
  assert.equal(html.includes("查看完整目标"), false);
});

test("the cockpit marks a run that was designed without pauses", () => {
  const render = (checkpointMode?: "auto" | "confirm") => renderToStaticMarkup(
    <EvolveOverlay
      client={client}
      onClose={() => {}}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({ goal: { ...run().goal, checkpointMode } })}
    />,
  );

  assert.match(render("auto"), /evolve-pace/);
  assert.match(render("auto"), />自动</);
  assert.equal(render("confirm").includes("evolve-pace"), false);
  assert.equal(render().includes("evolve-pace"), false);
});

test("a finished run drops the stop button and keeps the panel", () => {
  const html = renderToStaticMarkup(
    <EvolveOverlay
      client={client}
      onClose={() => {}}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({ finishedAt: "2026-10-01T09:20:00.000Z", status: "succeeded" })}
    />,
  );
  assert.match(html, /已完成/);
  assert.equal(html.includes(">停止<"), false);
});

test("the chart draws a rising line and says what its axes mean", () => {
  const html = renderToStaticMarkup(<ScoreChart view={view()} />);
  assert.match(html, /最优得分随扩展次数变化/);
  assert.match(html, /evolve-chart-line/);
  assert.match(html, /起点 0\.4000/);
  assert.match(html, /扩展次数/);
  assert.match(html, /0\.6200/);
});

test("a chart with nothing measured says so instead of drawing an empty frame", () => {
  const html = renderToStaticMarkup(<ScoreChart view={emptyRunView()} />);
  assert.match(html, /还没有可以画出的得分/);
  assert.equal(html.includes("<svg"), false);
});

test("the table keeps the four outcomes apart", () => {
  const html = renderToStaticMarkup(
    <CandidateTable candidates={view().candidates} onSelect={() => {}} />,
  );
  assert.match(html, /#3/);
  assert.match(html, /起点/);
  assert.match(html, /已接受/);
  assert.match(html, /次优/);
  assert.match(html, /未跑起来/);
});

test("the inspector explains a root instead of diffing it against nothing", () => {
  const root = candidate({ depth: 0, nodeIndex: 0, parentIndex: null, score: 0.4 });
  const html = renderToStaticMarkup(
    <CandidateInspector candidate={root} client={client} onClose={() => {}} runId="run-1" />,
  );
  assert.match(html, /这是起点，没有父代/);
});

test("the inspector asks for a selection before there is one", () => {
  const html = renderToStaticMarkup(
    <CandidateInspector client={client} onClose={() => {}} runId="run-1" />,
  );
  assert.match(html, /选择一个候选/);
});

test("the create dialog asks for a goal and an algorithm once the runtime is ready", () => {
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const html = renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );
  assert.match(html, /新建程序演进实验/);
  assert.match(html, /优化目标/);
  assert.match(html, /PUCT/);
  assert.match(html, /OpenEvolve/);
  assert.match(html, /开始设计/);
});

test("the create dialog pauses at checkpoints unless the command said otherwise", () => {
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const render = (checkpointMode?: "auto" | "confirm") => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initialCheckpointMode={checkpointMode}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );

  const byDefault = render();
  assert.match(byDefault, /检查点需要人工确认/);
  assert.match(byDefault, /等你确认后再继续/);
  assert.equal(switchTag(byDefault).includes("checked"), true);

  // A `--no-confirm` draft that had to detour through setup comes back with
  // the switch still off, so the detour does not silently undo the choice.
  const auto = render("auto");
  assert.match(auto, /连续完成设计与启动/);
  assert.equal(switchTag(auto).includes("checked"), false);
});

test("only a host with no sandbox warns that candidates run unconfined", () => {
  // The warning is a statement under the title, not a switch: consent is asked
  // when the search is started, so the form must not offer to give it early.
  const render = (sandbox: EvolveStatus["sandbox"]) => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={{ canInitialize: true, sandbox, state: "ready" }}
    />,
  );

  const direct = render("direct");
  assert.match(direct, /class="evolve-create-alert"/);
  assert.match(direct, /role="note"/);
  assert.match(direct, /没有沙箱的情况下运行候选代码/);
  assert.match(direct, /可以读写你的文件、访问网络/);
  assert.match(direct, /会再确认一次/);
  // The warning sits above the first field, where a title-adjacent banner is
  // read before anything is typed.
  assert.equal(direct.indexOf("evolve-create-alert") < direct.indexOf("优化目标"), true);
  // No control carries the consent: the only switch left is the checkpoint one.
  assert.equal(direct.includes("允许无隔离直接运行候选代码"), false);
  assert.equal((direct.match(/role="switch"/g) ?? []).length, 1);

  for (const sandbox of ["bwrap", "seatbelt", null, undefined] as const) {
    assert.equal(
      render(sandbox).includes("evolve-create-alert"),
      false,
      `${String(sandbox)}: a sandboxed host must not warn about unconfined runs`,
    );
  }
});

test("a search that ran without a sandbox is marked in the shelf and the panel", () => {
  const marked = run({ goal: { ...run().goal, allowUnisolated: true } });
  const shelf = renderToStaticMarkup(
    <EvolveShelf onNew={() => {}} onOpen={() => {}} runs={[marked, run({ id: "isolated" })]} />,
  );
  // Only the run whose goal recorded the confirmation is marked.
  assert.equal((shelf.match(/evolve-chip-unisolated/g) ?? []).length, 1);
  assert.match(shelf, />无隔离</);
  assert.match(shelf, /候选代码没有在沙箱中执行/);

  const overlay = renderToStaticMarkup(
    <EvolveOverlay
      client={client}
      onClose={() => {}}
      onError={() => {}}
      onRunChanged={() => {}}
      run={marked}
    />,
  );
  assert.match(overlay, /evolve-unisolated/);
  assert.match(overlay, />无隔离</);

  // A goal written before the field existed has no badge.
  const plain = renderToStaticMarkup(
    <EvolveOverlay
      client={client}
      onClose={() => {}}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.equal(plain.includes("无隔离"), false);
});

test("the create dialog offers the install when the runtime is missing", () => {
  const status: EvolveStatus = { canInitialize: true, state: "not_initialized" };
  const html = renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );
  assert.match(html, /需要准备演化运行时/);
  assert.match(html, /准备运行时/);
  assert.equal(html.includes("开始设计"), false);
});

test("the create dialog explains a runtime the deployment will not install", () => {
  const status: EvolveStatus = { canInitialize: false, state: "not_initialized" };
  const html = renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );
  assert.match(html, /请联系管理员/);
});

function header(over: { live?: boolean; state?: "error" | "installing" | "not_initialized" | "ready" } = {}): string {
  return renderToStaticMarkup(
    <SessionBar
      actions={actions}
      evolveLive={over.live ?? false}
      evolveState={over.state ?? "ready"}
      onEvolve={() => {}}
      onExpandSidebar={() => {}}
      onToggleWorkspace={() => {}}
      workspaceOpen={false}
    />,
  );
}

test("the header's evolve control is a capsule that says whether a search can run", () => {
  const html = header();
  assert.match(html, /class="evolve-capsule is-good"/);
  assert.match(html, new RegExp(TEXT.evolve.title));
  assert.match(html, new RegExp(TEXT.evolve.runtime.ready));
});

test("a live search outranks the runtime state in the capsule", () => {
  const html = header({ live: true });
  assert.match(html, /class="evolve-capsule is-live"/);
  assert.match(html, new RegExp(TEXT.evolve.runtime.running));
  assert.doesNotMatch(html, new RegExp(TEXT.evolve.runtime.ready));
});

test("a capsule with no runtime says so instead of promising a search", () => {
  const html = header({ state: "not_initialized" });
  assert.match(html, /class="evolve-capsule is-quiet"/);
  assert.match(html, new RegExp(TEXT.evolve.runtime.not_initialized));

  const broken = header({ state: "error" });
  assert.match(broken, /class="evolve-capsule is-bad"/);
  assert.match(broken, new RegExp(TEXT.evolve.runtime.error));
});
