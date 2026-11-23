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
import { readFile } from "node:fs/promises";
// The test runner compiles JSX with the classic runtime, so React has to be in
// scope even though the app itself is built with the automatic one.
import React from "react";
import { renderToStaticMarkup } from "react-dom/server";
import type { EvolveRun } from "@sciencediscovery/schema";

import type { ApiClient } from "../src/api/client.js";
import type { EvolveStatus } from "../src/api/evolve.js";
import type { EvolveCandidateView, EvolveRunView } from "../src/evolve/model.js";
import { emptyRunView } from "../src/evolve/model.js";
import { getLanguage, setLanguage, TEXT } from "../src/text.js";
import { CandidateInspector } from "../src/views/evolve/CandidateInspector.js";
import { EvolveCreateDialog } from "../src/views/evolve/EvolveCreateDialog.js";
import { EvolveDetail, lastGain } from "../src/views/evolve/EvolveDetail.js";
import { EvolveNodeList } from "../src/views/evolve/EvolveNodeList.js";
import { EvolveRuntimeDialog } from "../src/views/evolve/EvolveRuntimeDialog.js";
import { EvolveRuns } from "../src/views/evolve/EvolveRuns.js";
import { EvolveTree, layoutTree, zoomToward } from "../src/views/evolve/EvolveTree.js";
import type { TreeView } from "../src/views/evolve/EvolveTree.js";
import { ScoreChart, collectSeries } from "../src/views/evolve/ScoreChart.js";
import { act, create } from "./support/dom-renderer.js";

// `EvolveDetail` and `EvolveRuns` run their elapsed clocks on window timers,
// and this renderer has no window of its own. The static renders below never
// reach the effects; the mounted cases do.
Object.assign(globalThis, {
  window: {
    clearInterval: (timer: ReturnType<typeof setInterval>) => clearInterval(timer),
    setInterval: (callback: () => void, ms: number) => {
      const timer = setInterval(callback, ms);
      // A case that fails before its unmount must not leave the test process
      // waiting on a one-second clock.
      (timer as unknown as { unref?: () => void }).unref?.();
      return timer;
    },
  },
});

const client = {} as ApiClient;

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

/** The words a rendered subtree shows, in document order. */
function nodeText(node: unknown): string {
  if (typeof node === "string") return node;
  const children = (node as { children?: unknown[] }).children ?? [];
  return children.map(nodeText).join(" ");
}

/** The card a hovered point draws. Matched on the base class only: the card's
 *  own children are named `evolve-chart-tooltip-…` and would match a prefix. */
function tooltipOf(chart: ReturnType<typeof create>) {
  return chart.root.findAll((node) =>
    typeof node.props.className === "string"
    && node.props.className.startsWith("evolve-chart-tooltip")
    && !node.props.className.startsWith("evolve-chart-tooltip-"))[0];
}

/** The invisible circle a plotted point answers the pointer and the keyboard
 *  through, found by the label it announces. */
function hitOf(chart: ReturnType<typeof create>, label: string) {
  return chart.root.findAll((node) =>
    node.props.className === "evolve-chart-hit"
    && String(node.props["aria-label"]).startsWith(label))[0];
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

test("the transcript draws nothing for a session that has no searches", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[]} />,
  );
  assert.equal(html, "");
});

test("a search designed without pauses says so on its card", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns
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

test("a card names the search, how long it took and where it stands", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns
      onOpen={() => {}}
      runs={[run({
        finishedAt: "2026-10-01T09:38:20.000Z",
        id: "done",
        status: "succeeded",
      })]}
    />,
  );
  assert.match(html, /evolve-run-title">让压缩比更高</);
  assert.match(html, /已耗时 38分钟/);
  assert.match(html, /evolve-run-state is-good">已完成/);
  // A finished search has no clock to re-render and no spark to spin.
  assert.doesNotMatch(html, /evolve-run-spin/);
});

test("a live card says it is working rather than repeating its status", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[run({ finishedAt: undefined })]} />,
  );
  assert.match(html, /evolve-run-state is-live">/);
  assert.match(html, /正在优化/);
  assert.match(html, /evolve-run-spin/);
});

test("a failed card explains the interruption, in the user's language, and offers retry", () => {
  const failure = {
    code: "service_restart" as const,
    message: "the control plane restarted and this search was interrupted",
  };
  const html = renderToStaticMarkup(
    <EvolveRuns
      onOpen={() => {}}
      onRetry={() => {}}
      runs={[run({ error: failure.message, failure, status: "failed" })]}
    />,
  );
  assert.match(html, /evolve-run-state is-bad">失败/);
  assert.match(html, /服务已重启，搜索被中断/);
  // The explanation is part of the opening button, so clicking the reason
  // still opens the run; retry remains the only sibling action.
  assert.match(html, /<button[^>]*class="evolve-run-open"[\s\S]*?服务已重启，搜索被中断[\s\S]*?<\/button>/);
  assert.match(html, /evolve-run-retry/);
  assert.match(html, />重试</);
  // The persisted message is English prose; a zh card renders the translated
  // category instead of leaking it.
  assert.doesNotMatch(html, /the control plane restarted/);

  const previous = getLanguage();
  try {
    setLanguage("en");
    const english = renderToStaticMarkup(
      <EvolveRuns
        onOpen={() => {}}
        onRetry={() => {}}
        runs={[run({ failure, status: "failed" })]}
      />,
    );
    assert.match(english, /The service restarted and interrupted the search/);
    assert.match(english, />Retry</);
  } finally {
    setLanguage(previous);
  }
});

test("an unavailable sidecar has its own translated reason", () => {
  const failure = { code: "sidecar_unavailable" as const, message: "Evolve service is unavailable or authentication failed" };
  const zh = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[run({ failure, status: "failed" })]} />,
  );
  assert.match(zh, /搜索进程暂时不可用/);
  assert.doesNotMatch(zh, /Evolve service is unavailable/);

  const previous = getLanguage();
  try {
    setLanguage("en");
    const en = renderToStaticMarkup(
      <EvolveRuns onOpen={() => {}} runs={[run({ failure, status: "failed" })]} />,
    );
    assert.match(en, /The search process is temporarily unavailable/);
  } finally {
    setLanguage(previous);
  }
});

test("only the failed evolve card grows; the shared idea card stays one line", async () => {
  const css = await readFile(new URL("../src/styles/evolve.css", import.meta.url), "utf8");
  const rule = (selector: string) => {
    const start = css.indexOf(`${selector} {`);
    assert.ok(start >= 0, `${selector} exists`);
    return css.slice(start, css.indexOf("}", start));
  };
  const base = rule(".evolve-run-card");
  assert.doesNotMatch(base, /flex-wrap/);
  assert.doesNotMatch(base, /min-height/);
  assert.doesNotMatch(base, /padding:\s*8px/);

  // The inner open target also lives inside the 60px card. Wrapping there
  // pushed the status chip below the border on long titles even after the
  // outer rule was restored, so only the failed card may wrap it.
  const open = rule(".evolve-run-open");
  assert.doesNotMatch(open, /flex-wrap:\s*wrap/);

  const failed = rule(".evolve-run-card.is-evolve-failed");
  assert.match(failed, /flex-wrap:\s*wrap/);
  assert.match(failed, /min-height:\s*60px/);
  assert.match(failed, /padding:\s*8px 16px/);

  const failedOpen = rule(".evolve-run-card.is-evolve-failed .evolve-run-open");
  assert.match(failedOpen, /flex-wrap:\s*wrap/);
});

test("a read-only failed card keeps the reason but offers no retry", () => {
  const html = renderToStaticMarkup(
    <EvolveRuns
      onOpen={() => {}}
      runs={[run({
        failure: { code: "service_restart", message: "interrupted" },
        status: "failed",
      })]}
    />,
  );
  assert.match(html, /服务已重启，搜索被中断/);
  assert.equal(html.includes("evolve-run-retry"), false);
});

test("a failed record without a reason falls back instead of guessing or leaking prose", () => {
  const unknown = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[run({ status: "failed" })]} />,
  );
  assert.match(unknown, /未记录失败原因/);

  // A pre-field record carries only free text. It is classified, not printed:
  // the message is diagnostic, not UI copy.
  const legacy = renderToStaticMarkup(
    <EvolveRuns
      onOpen={() => {}}
      runs={[run({ error: "something went wrong inside the evaluator", status: "failed" })]}
    />,
  );
  assert.match(legacy, /搜索或评估失败/);
  assert.doesNotMatch(legacy, /something went wrong inside the evaluator/);
});

test("the retry button starts a retry for the failed run's id", async () => {
  const retried: string[] = [];
  const opened: string[] = [];
  let card: ReturnType<typeof create> | undefined;
  await act(async () => {
    card = create(
      <EvolveRuns
        onOpen={(id) => { opened.push(id); }}
        onRetry={(id) => { retried.push(id); }}
        runs={[run({
          failure: { code: "sidecar_disconnected", message: "the sidecar disconnected" },
          id: "broken",
          status: "failed",
        })]}
      />,
    );
  });
  const button = card!.root.findAll((node) =>
    typeof node.props.className === "string" && node.props.className === "evolve-run-retry")[0];
  assert.ok(button, "the failed card has a retry action");
  await act(async () => { (button.props.onClick as () => void)(); });
  assert.deepEqual(retried, ["broken"]);
  assert.deepEqual(opened, [], "retry is a sibling, not the opening target");
  await act(async () => { card!.unmount(); });
});

test("clicking the failure reason opens the run", async () => {
  const opened: string[] = [];
  let card: ReturnType<typeof create> | undefined;
  await act(async () => {
    card = create(
      <EvolveRuns
        onOpen={(id) => { opened.push(id); }}
        onRetry={() => {}}
        runs={[run({
          failure: { code: "sidecar_disconnected", message: "the sidecar disconnected" },
          id: "broken",
          status: "failed",
        })]}
      />,
    );
  });
  const reason = card!.root.findAll((node) =>
    typeof node.props.className === "string" && node.props.className === "evolve-run-reason")[0];
  assert.ok(reason, "the failed card explains itself");
  assert.equal(reason.parent?.props.className, "evolve-run-open", "the reason sits inside the opening target");
  await act(async () => { (reason.parent!.props.onClick as () => void)(); });
  assert.deepEqual(opened, ["broken"]);
  await act(async () => { card!.unmount(); });
});

test("the transcript shows the running search first and folds the rest", () => {
  const runs = [
    run({ createdAt: "2026-10-01T08:00:00.000Z", id: "old", status: "succeeded" }),
    run({ createdAt: "2026-10-01T10:00:00.000Z", id: "live" }),
    run({ createdAt: "2026-10-01T09:00:00.000Z", id: "finished", status: "stopped" }),
    run({ createdAt: "2026-10-01T07:00:00.000Z", id: "older", status: "failed" }),
  ];
  const html = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={runs} />,
  );
  assert.match(html, /evolve-runs/);
  // Three cards, then the fourth behind a count. There is no bar above the
  // conversation any more, so nothing here starts a search from the transcript.
  assert.equal((html.match(/evolve-run-card/g) ?? []).length, 3);
  assert.match(html, /还有 1 个/);
  assert.doesNotMatch(html, /新建实验/);
  assert.equal(html.indexOf("is-live") < html.indexOf("已停止"), true);
});

test("the task panel names the search and offers a stop while it is live", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.match(html, /evolve-detail/);
  assert.match(html, /evolve-task-head/);
  assert.match(html, /让压缩比更高/);
  assert.match(html, />停止</);
  // A search outlives the turn that started it, so the detail is a column
  // rather than a dialog over the conversation.
  assert.equal(html.includes("evolve-overlay"), false);
  assert.equal(html.includes('role="dialog"'), false);
  assert.equal(html.includes("evolve-task-status"), false);
});

test("a long goal reads back in full from the panel that truncates its title", () => {
  const goal = "写一对标准库 Python 函数 pack(text: str) -> bytes 与 unpack(blob: bytes) -> str，两者都必须无损往返，并拒绝损坏的输入";
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({ goal: { ...run().goal, statement: goal } })}
    />,
  );
  // The panel says what it is, and not only which group of the column it is in.
  assert.match(html, /evolve-task-eyebrow[^>]*>程序演进</);
  // The title is the one-line reading; the goal itself is one disclosure away.
  assert.match(html, /<summary>查看完整目标<\/summary>/);
  assert.ok(
    html.replaceAll("&gt;", ">").includes(`<p>${goal}</p>`),
    "the full goal is in the panel",
  );
  assert.match(html, /evolve-task-fullscreen/);
  assert.match(html, />全屏</);
});

test("a short goal is not copied into a second reading", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.equal(html.includes("查看完整目标"), false);
  // Full screen is about the panel, not about a goal that happens to be long.
  assert.match(html, /evolve-task-fullscreen/);
});

test("the task panel's new controls speak the interface language", () => {
  const previous = getLanguage();
  const goal = "Write standard-library Python functions pack(text: str) -> bytes and unpack(blob: bytes) -> str that round-trip losslessly and reject corrupted input";
  try {
    setLanguage("en");
    const html = renderToStaticMarkup(
      <EvolveDetail
        client={client}
        onError={() => {}}
        onRunChanged={() => {}}
        run={run({ goal: { ...run().goal, statement: goal } })}
      />,
    );
    assert.match(html, /evolve-task-eyebrow[^>]*>Program evolution</);
    assert.match(html, /<summary>Show the full goal<\/summary>/);
    assert.match(html, />Full screen</);
  } finally {
    setLanguage(previous);
  }
});

test("full screen fills the window, and Escape returns to the column with the run intact", async () => {
  // A React effect needs the document the app actually has in the browser;
  // this file has no DOM, so the listeners are recorded and pressed here.
  type KeyEvent = { defaultPrevented: boolean; key: string; preventDefault: () => void };
  const listeners = new Set<(event: KeyEvent) => void>();
  const scope = globalThis as { document?: unknown };
  const originalDocument = scope.document;
  scope.document = {
    addEventListener: (type: string, listener: (event: KeyEvent) => void) => {
      if (type === "keydown") listeners.add(listener);
    },
    removeEventListener: (type: string, listener: (event: KeyEvent) => void) => {
      if (type === "keydown") listeners.delete(listener);
    },
  };
  const mounted: Array<ReturnType<typeof create>> = [];
  try {
    await act(async () => {
      mounted.push(create(<EvolveDetail
        client={client}
        onError={() => {}}
        onRunChanged={() => {}}
        run={run()}
      />));
    });
    const view = mounted[0];
    assert.ok(view, "the task panel mounted");
    const button = () => {
      const [toggle] = view.root.findAllByProps({ className: "evolve-task-fullscreen" });
      assert.ok(toggle, "the full-screen toggle is drawn");
      return toggle;
    };
    assert.equal(button().props["aria-pressed"], false);
    assert.deepEqual(button().children, ["全屏"]);

    await act(async () => { button().props.onClick?.(); });
    assert.equal(view.root.findAllByProps({ className: "evolve-detail is-fullscreen" }).length, 1);
    assert.equal(button().props["aria-pressed"], true);
    assert.deepEqual(button().children, ["退出全屏"]);
    assert.equal(listeners.size, 1, "full screen owns Escape while it is open");

    const escape: KeyEvent = {
      defaultPrevented: false,
      key: "Escape",
      preventDefault: () => { escape.defaultPrevented = true; },
    };
    await act(async () => { for (const listener of [...listeners]) listener(escape); });

    assert.equal(escape.defaultPrevented, true);
    assert.equal(listeners.size, 0, "the listener leaves with the mode");
    assert.equal(view.root.findAllByProps({ className: "evolve-detail" }).length, 1);
    assert.equal(button().props["aria-pressed"], false);
    assert.deepEqual(button().children, ["全屏"]);
    // Leaving full screen is not a new panel: the same reading is still there.
    assert.equal(view.root.findAllByProps({ className: "evolve-overview" }).length, 1);
    const title = view.root.findAllByProps({ id: "evolve-panel-title" })[0];
    assert.ok(title, "the task title is drawn");
    assert.deepEqual(title.children, ["让压缩比更高"]);
    assert.equal(view.root.findAll((node) => node.props.className === "evolve-task-stop").length, 1);
  } finally {
    const view = mounted[0];
    if (view) await act(async () => { view.unmount(); });
    // The file's own window stub is shared with the other mounted cases, so
    // only the document this case replaced is put back.
    if (originalDocument === undefined) delete scope.document;
    else scope.document = originalDocument;
  }
});

test("the task panel leads with the totals, the chart, the tree and the budget", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({
        finishedAt: "2026-10-01T09:38:20.000Z",
        status: "succeeded",
      })}
    />,
  );

  for (const label of ["最优解", "有效节点数/总数", "层数", "算法", "Token"]) {
    assert.match(html, new RegExp(label), `${label}: the overview has a cell`);
  }
  assert.equal((html.match(/evolve-overview-cell/g) ?? []).length, 5);
  // The run's algorithm stands in before the first event arrives.
  assert.match(html, />puct</);

  // The handoff's order: how far, how it got there, what it tried, what it cost.
  const overview = html.indexOf("evolve-overview");
  const chart = html.indexOf("实时算法优化结果");
  const tree = html.indexOf("优化树");
  const budget = html.indexOf(">预算<");
  assert.equal(overview < chart && chart < tree && tree < budget, true);

  // Budget rows read value over limit, with the clock taken from the record.
  assert.match(html, /0 \/ 1,000,000/);
  assert.match(html, /38m20s \/ 1h00m/);
  assert.match(html, /0 \/ 40/);
  assert.equal((html.match(/role="progressbar"/g) ?? []).length, 3);
});

test("a finished run drops the stop button and keeps the panel", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({ finishedAt: "2026-10-01T09:20:00.000Z", status: "succeeded" })}
    />,
  );
  assert.match(html, /evolve-detail/);
  assert.equal(html.includes(">停止<"), false);
});

/**
 * A client whose event stream the test writes to frame by frame.
 *
 * The stop cases have to watch the panel while the run is between "stop asked"
 * and "run settled": a static render cannot press the button, and a stub that
 * closes the stream at once cannot feed a realistic PUCT log into the panel.
 */
function controlledStream() {
  let controller: ReadableStreamDefaultController<Uint8Array> | undefined;
  const body = new ReadableStream<Uint8Array>({
    start(start) { controller = start; },
  });
  const encoder = new TextEncoder();
  const client = {
    fetchStream: () => Promise.resolve(new Response(body)),
    request: () => Promise.resolve({ stopping: true }),
  } as unknown as ApiClient;
  return {
    client,
    send(sequence: number, event: unknown) {
      controller?.enqueue(encoder.encode(
        `id: ${sequence}\ndata: ${JSON.stringify({
          createdAt: "2026-10-01T09:00:00.000Z",
          event,
          sequence,
        })}\n\n`,
      ));
    },
  };
}

/** Let the stream's reader fold the frames just written, inside `act`. */
async function settle() {
  await act(async () => { await new Promise((resolve) => setTimeout(resolve, 0)); });
}

function stopButton(detail: ReturnType<typeof create>) {
  return detail.root.findAll((node) =>
    node.type === "button" && node.props.className === "evolve-task-stop")[0];
}

function stopBar(detail: ReturnType<typeof create>) {
  return detail.root.findAll((node) =>
    node.props.className === "evolve-stop-bar")[0];
}

test("pressing stop is busy and disabled until the run settles, not until the request returns", async () => {
  const stream = controlledStream();
  const errors: string[] = [];
  let detail!: ReturnType<typeof create>;
  await act(async () => {
    detail = create(<EvolveDetail
      client={stream.client}
      onError={(message) => errors.push(message)}
      onRunChanged={() => {}}
      run={run()}
    />);
  });

  assert.equal(nodeText(stopButton(detail)!).trim(), "停止");
  assert.equal(stopButton(detail)!.props.disabled, false);

  await act(async () => { (stopButton(detail)!.props.onClick as () => void)(); });
  // The stop request resolved inside `act`, and the record still says the run
  // is running. The old code cleared its flag in `finally`, which is exactly
  // the 4.6-second silent window the issue measured; the control has to stay
  // busy until the status lands.
  assert.equal(nodeText(stopButton(detail)!).trim(), "正在停止…");
  assert.equal(stopButton(detail)!.props.disabled, true);
  assert.equal(stopButton(detail)!.props["aria-busy"], true);
  const bar = stopBar(detail)!;
  assert.match(nodeText(bar), /正在结束进行中的候选…/);
  // The line is outside the scrolling body, so it cannot scroll out of view:
  // it comes before .evolve-detail-scroll and is not one of its descendants.
  assert.equal(
    bar.findAll((node) => node.props.className === "evolve-detail-scroll").length,
    0,
  );
  const scroll = detail.root.findAll((node) =>
    node.props.className === "evolve-detail-scroll")[0]!;
  assert.equal(
    scroll.findAll((node) => node.props.className === "evolve-stop-bar").length,
    0,
  );
  assert.deepEqual(
    detail.root.findAll((node) =>
      node.props.className === "evolve-stop-bar"
      || node.props.className === "evolve-detail-scroll")
      .map((node) => node.props.className),
    ["evolve-stop-bar", "evolve-detail-scroll"],
  );
  assert.deepEqual(errors, []);

  await act(async () => { detail.unmount(); });
});

test("a real PUCT log gets the honest winding-down line, not an invented candidate count", async () => {
  const stream = controlledStream();
  let detail!: ReturnType<typeof create>;
  await act(async () => {
    detail = create(<EvolveDetail
      client={stream.client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />);
  });

  // The PUCT sequence: `selected` names the parent being expanded, and the
  // child only appears in `expanded` already scored. Counting null-score
  // candidate rows would therefore read zero while a proposal is in flight,
  // so the panel deliberately says what is ending without claiming a number.
  await act(async () => {
    stream.send(1, { algorithm: "puct", scorecardHash: "sha256:card", type: "search_started" });
    stream.send(2, { baselineScore: 0.41, codeHash: "sha256:root", nodeIndex: 0, type: "seeded" });
    stream.send(3, { ancestorVisits: [{ nodeIndex: 0, visits: 1 }], nodeIndex: 0, type: "selected" });
    stream.send(4, {
      depth: 1,
      nodeIndex: 1,
      parentIndex: 0,
      score: 0.5,
      type: "expanded",
      valid: true,
    });
    stream.send(5, { ancestorVisits: [{ nodeIndex: 0, visits: 2 }], nodeIndex: 1, type: "selected" });
  });
  await settle();

  await act(async () => { (stopButton(detail)!.props.onClick as () => void)(); });
  assert.match(nodeText(stopBar(detail)!), /正在结束进行中的候选…/);
  assert.doesNotMatch(nodeText(detail.root), /正在取消 \d/);

  // The pending proposal lands while the stop is waiting; the line stays true
  // rather than depending on a count that PUCT cannot supply.
  await act(async () => {
    stream.send(6, {
      depth: 2,
      nodeIndex: 2,
      parentIndex: 1,
      score: 0.62,
      type: "expanded",
      valid: true,
    });
    stream.send(7, { ancestorVisits: [{ nodeIndex: 1, visits: 1 }], nodeIndex: 2, type: "selected" });
  });
  await settle();
  assert.match(nodeText(stopBar(detail)!), /正在结束进行中的候选…/);
  assert.doesNotMatch(nodeText(detail.root), /正在取消 \d/);

  // The run settles at 已停止: the stop control and the winding-down line go.
  await act(async () => {
    stream.send(8, {
      bestNodeIndex: 1,
      candidates: 3,
      status: "stopped",
      type: "search_finished",
    });
  });
  await settle();
  assert.equal(stopButton(detail), undefined);
  assert.equal(stopBar(detail), undefined);
  assert.doesNotMatch(nodeText(detail.root), /正在停止|正在取消|正在结束/);

  await act(async () => { detail.unmount(); });
});

test("a refused stop puts the button back and reports why", async () => {
  const errors: string[] = [];
  const refused = {
    fetchStream: () => Promise.resolve(new Response("")),
    request: () => Promise.reject(new Error("stop refused")),
  } as unknown as ApiClient;
  let detail!: ReturnType<typeof create>;
  await act(async () => {
    detail = create(<EvolveDetail
      client={refused}
      onError={(message) => errors.push(message)}
      onRunChanged={() => {}}
      run={run()}
    />);
  });

  await act(async () => { (stopButton(detail)!.props.onClick as () => void)(); });
  assert.equal(nodeText(stopButton(detail)!).trim(), "停止");
  assert.equal(stopButton(detail)!.props.disabled, false);
  assert.deepEqual(errors, ["stop refused"]);

  await act(async () => { detail.unmount(); });
});

test("the run card says its click opens the task panel, and still opens it", async () => {
  const html = renderToStaticMarkup(<EvolveRuns onOpen={() => {}} runs={[run()]} />);
  // Words on the card, not only a hover title: the affordance a reader acts on
  // is the one they can see. The hint is a span inside main's opening button;
  // .evolve-run-open is the button itself, so the two classes must stay apart.
  assert.match(html, /evolve-run-panel-hint">打开任务面板</);
  assert.match(html, /title="[^"]*打开任务面板/);
  assert.match(html, /<button[^>]*class="evolve-run-open"[\s\S]*?evolve-run-panel-hint/);

  const opened: string[] = [];
  let runs!: ReturnType<typeof create>;
  await act(async () => {
    runs = create(<EvolveRuns onOpen={(id) => opened.push(id)} runs={[run()]} />);
  });
  const card = runs.root.findAll((node) =>
    node.type === "button" && node.props.className === "evolve-run-open")[0]!;
  await act(async () => { (card.props.onClick as () => void)(); });
  assert.deepEqual(opened, ["run-1"]);

  await act(async () => { runs.unmount(); });
});

test("the card hint yields to the clock, and the stop line is outside the scroller", async () => {
  const css = await readFile(new URL("../src/styles/evolve.css", import.meta.url), "utf8");
  // The card width follows the conversation column, which the open task panel
  // narrows: below 400px the hint and the auto badge fold away so the elapsed
  // clock keeps its width, while the title/accessible name still say both.
  assert.match(css, /\.evolve-runs \{ container-type: inline-size; \}/);
  const narrow = css.slice(css.indexOf("@container (max-width: 400px)"));
  assert.match(narrow.slice(0, 240), /\.evolve-run-panel-hint,[\s\S]*?\.evolve-chip-auto \{ display: none; \}/);
  // The opening button must never be hidden on a narrow card.
  assert.doesNotMatch(narrow.slice(0, 240), /\.evolve-run-open\s*[,{]/);
  // The hint is the AA-legible cue, not the faintest text on the card.
  assert.match(css, /\.evolve-run-panel-hint \{[^}]*color: var\(--text-secondary\);/);
  assert.match(css, /\.evolve-run-elapsed \{[^}]*min-width: 0;/);
  // A fixed bar between the header and the scroll body cannot scroll away.
  assert.match(css, /\.evolve-stop-bar \{[^}]*flex: 0 0 auto;/);
});

test("the overview's delta is the last step of the best staircase", () => {
  // Baseline 0.4, then a gate-measured 0.62: the one improvement is +55%.
  assert.ok(Math.abs((lastGain(view()) ?? 0) - 55) < 1e-9);
  // Nothing has beaten the starting point yet.
  assert.equal(lastGain({ ...emptyRunView(), baselineScore: 0.5 }), undefined);
  // A run with no baseline still reports the step that set the first best.
  const gained = lastGain({
    ...emptyRunView(),
    baselineScore: null,
    candidates: [
      candidate({ gateScore: 0.2, nodeIndex: 1 }),
      candidate({ gateScore: 0.25, nodeIndex: 2 }),
    ],
  });
  assert.ok(Math.abs((gained ?? 0) - 25) < 1e-9);
});

test("the budget reads the node count, the tokens and the clock, and no cost", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  // Three rows, in the order they are read: what the search spent, against
  // the budget it was given. Cost is not one of them: no price table exists,
  // and a row that can never move is not a budget.
  assert.match(html, /Token/);
  assert.match(html, /耗时/);
  assert.match(html, /节点/);
  assert.match(html, /0 \/ 40/);
  assert.doesNotMatch(html, /费用|未配置价格表/);
});

test("a run past its clock budget marks the row rather than clipping the bar", () => {
  // The test run started in 2026, so a live one has already outlived the
  // hour-long clock in its budget.
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run()}
    />,
  );
  assert.match(html, /evolve-budget-track[^"]*is-over/);
  assert.match(html, /class="is-over"/);
});

test("a legacy failed record is translated in the panel, with its detail only in English", () => {
  const legacy = run({ error: "sidecar exited", status: "failed" });
  const zh = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={legacy}
    />,
  );
  assert.match(zh, /evolve-notice is-error/);
  assert.match(zh, /搜索或评估失败/);
  assert.doesNotMatch(zh, /sidecar exited/);

  const previous = getLanguage();
  try {
    setLanguage("en");
    const en = renderToStaticMarkup(
      <EvolveDetail
        client={client}
        onError={() => {}}
        onRunChanged={() => {}}
        run={legacy}
      />,
    );
    assert.match(en, /The search or its evaluation failed/);
    assert.match(en, /sidecar exited/);
  } finally {
    setLanguage(previous);
  }
});

test("a structured failure is translated in the panel too", () => {
  const html = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={run({
        error: "the control plane restarted and this search was interrupted",
        failure: { code: "service_restart", message: "the control plane restarted and this search was interrupted" },
        status: "failed",
      })}
    />,
  );
  assert.match(html, /服务已重启，搜索被中断/);
  assert.doesNotMatch(html, /the control plane restarted/);
});

test("the chart draws a rising line and says what its axes mean", () => {
  const html = renderToStaticMarkup(<ScoreChart view={view()} />);
  assert.match(html, /evolve-chart-line/);
  assert.match(html, /evolve-chart-baseline/);
  assert.match(html, /evolve-chart-best-line/);
  // The x axis counts expansions, not wall-clock minutes.
  assert.match(html, /扩展次数/);
  assert.match(html, /evolve-chart-x/);
  // Every reading has a key in the legend.
  // Every plotted point was scored by the gate, so the key names the reading
  // rather than a class of node: "显著" would describe a distinction the chart
  // no longer draws.
  for (const label of ["最优产物", "得分节点", "测试", "失败", "低于基线"]) {
    assert.match(html, new RegExp(label), `${label}: the legend names it`);
  }
});

test("the chart keeps the gate and the failures apart", () => {
  const series = collectSeries(view());
  // Only a candidate the acceptance gate measured is plotted; a rollout score
  // alone is not a comparable reading, and an invalid node never reached the
  // floor.
  assert.deepEqual(series.significant.map((point) => point.index), [1]);
  assert.deepEqual(series.failed, [3]);

  const html = renderToStaticMarkup(<ScoreChart view={view()} />);
  assert.match(html, /evolve-chart-dot is-significant/);
  assert.doesNotMatch(html, /is-insignificant/);
  assert.match(html, /evolve-chart-failed/);
  assert.match(html, /evolve-chart-best/);
  // The significant point's title carries its score.
  assert.match(html, /0\.6200/);
});

test("pointing at a node names it, its generation and its score", async () => {
  let chart;
  await act(async () => { chart = create(<ScoreChart view={view()} />); });
  try {
    // Nothing follows the pointer until one is over a point.
    assert.equal(
      chart.root.findAll((node) => node.props.className === "evolve-chart-tooltip").length,
      0,
    );

    const hit = hitOf(chart, "#1");
    assert.ok(hit, "the best node has a hit area larger than its dot");
    await act(async () => { (hit.props.onMouseEnter as () => void)(); });

    // The dashed rule marks the expansion the point belongs to.
    assert.equal(chart.root.findAll((node) => node.props.className === "evolve-chart-guide").length, 1);
    const text = nodeText(tooltipOf(chart));
    assert.match(text, /Node #1/);
    assert.match(text, /层数 01/);
    // The handoff tags the best node rather than leaving the reader to compare
    // the score with the rule above.
    assert.match(text, /最佳/);
    assert.match(
      String(chart.root.findByProps({ className: "evolve-chart-tooltip-score" }).children),
      /0\.6200/,
    );

    // Leaving the point takes the reading with it.
    await act(async () => { (hit.props.onMouseLeave as () => void)(); });
    assert.equal(
      chart.root.findAll((node) => node.props.className === "evolve-chart-tooltip").length,
      0,
    );
    assert.equal(chart.root.findAll((node) => node.props.className === "evolve-chart-guide").length, 0);
  } finally {
    await act(async () => { chart.unmount(); });
  }
});

test("pressing a plotted node opens its detail, as a row of the list does", async () => {
  const picked: number[] = [];
  let chart;
  await act(async () => {
    chart = create(<ScoreChart onSelect={(index) => picked.push(index)} view={view()} />);
  });
  try {
    const hit = (label: string) => hitOf(chart, label);
    await act(async () => { (hit("#1").props.onClick as () => void)(); });
    // A failed node is still a node: its detail says why it never ran.
    await act(async () => { (hit("#3").props.onClick as () => void)(); });
    // Enter does what a click does, for the keyboard.
    await act(async () => {
      (hit("#1").props.onKeyDown as (event: { key: string; preventDefault: () => void }) => void)({
        key: "Enter",
        preventDefault: () => {},
      });
    });
    assert.deepEqual(picked, [1, 3, 1]);
  } finally {
    await act(async () => { chart.unmount(); });
  }
});

test("a failed node answers the pointer with its verdict, not a score", async () => {
  let chart;
  await act(async () => { chart = create(<ScoreChart view={view()} />); });
  try {
    const hit = hitOf(chart, "#3");
    assert.ok(hit, "the failed node is hoverable too");
    await act(async () => { (hit.props.onMouseEnter as () => void)(); });

    const text = nodeText(tooltipOf(chart));
    assert.match(text, /Node #3/);
    assert.match(text, /失败/);
    // It never ran, so there is no score to print.
    assert.equal(chart.root.findAll((node) => node.props.className === "evolve-chart-tooltip-score").length, 0);
  } finally {
    await act(async () => { chart.unmount(); });
  }
});

test("a chart with nothing measured says so instead of drawing an empty frame", () => {
  const html = renderToStaticMarkup(<ScoreChart view={emptyRunView()} />);
  assert.match(html, /还没有可以画出的得分/);
  assert.equal(html.includes("<svg"), false);
});

test("the node list reads the tree as rows and marks the winner", () => {
  const html = renderToStaticMarkup(
    <EvolveNodeList
      bestIndex={1}
      candidates={view().candidates}
      onSelect={() => {}}
      selectedIndex={2}
    />,
  );
  assert.match(html, /节点列表/);
  assert.equal((html.match(/class="evolve-node-row /g) ?? []).length, 4);
  assert.match(html, /Node #1/);
  assert.match(html, /层数 01/);
  // The best row is badged; the time-sort column from the handoff is absent.
  assert.equal((html.match(/最佳/g) ?? []).length, 1);
  assert.match(html, /evolve-node-row is-best/);
  assert.match(html, /evolve-node-row is-quiet/);
  assert.match(html, /evolve-node-row is-failed/);
  assert.match(html, /is-quiet is-selected/);
  assert.equal(html.includes("按时间"), false);
  // An invalid node has no score to print.
  assert.match(html, /class="evolve-node-score">-</);
});

test("the tree lays each parent over the middle of its children", () => {
  const layout = layoutTree(view().candidates);
  const at = (index: number) => {
    const node = layout.nodes.find((placed) => placed.candidate.nodeIndex === index);
    assert.ok(node, `node ${index} is placed`);
    return node;
  };
  // Node 1 has one child, node 3 is a leaf, and node 0 sits between them.
  assert.equal(at(2).x, 0);
  assert.equal(at(3).x, 1);
  assert.equal(at(1).x, 0);
  assert.equal(at(0).x, 0.5);
  assert.equal(at(2).depth, 2);
  assert.equal(layout.edges.length, 3);
  // 44px padding each side, a 32px radius, 82px between columns and 200
  // between generations.
  assert.equal(layout.width, 44 * 2 + 32 * 2 + 1 * 82);
  assert.equal(layout.height, 44 * 2 + 32 * 2 + 2 * 200);
});

/** The drawing coordinate under a screen point, mirroring where the canvas
 *  rests: centred horizontally while it fits, flush left and top after. */
function drawingPoint(
  view: TreeView,
  cursor: { x: number; y: number },
  viewport: { height: number; width: number },
  content: { height: number; width: number },
) {
  const baseX = Math.max(0, (viewport.width - content.width * view.zoom) / 2);
  return {
    x: (cursor.x - baseX - view.pan.x) / view.zoom,
    y: (cursor.y - view.pan.y) / view.zoom,
  };
}

test("a wheel step zooms about the cursor, not about a fixed corner", () => {
  const viewport = { height: 600, width: 800 };
  const content = { height: 900, width: 1000 };
  const start: TreeView = { pan: { x: 0, y: 0 }, zoom: 1 };
  const cursor = { x: 640, y: 180 };
  const zoomed = zoomToward(start, cursor, 2, viewport, content);
  assert.equal(zoomed.zoom, 2);
  // The drawing point under the pointer has to be the same one after the
  // zoom. The canvas rests flush left once it outgrows the column, so that
  // point is read against that origin, not against the viewport centre.
  const before = drawingPoint(start, cursor, viewport, content);
  const after = drawingPoint(zoomed, cursor, viewport, content);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `x drifted by ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `y drifted by ${after.y - before.y}`);
});

test("a wheel step keeps the anchor when the view is already panned", () => {
  const viewport = { height: 600, width: 800 };
  const content = { height: 900, width: 1000 };
  // Zoomed out past the point where the canvas is wider than the column, so
  // the resting position itself changes from flush left to centred.
  const start: TreeView = { pan: { x: -120, y: -40 }, zoom: 1 };
  const cursor = { x: 500, y: 300 };
  const zoomed = zoomToward(start, cursor, 0.5, viewport, content);
  assert.equal(zoomed.zoom, 0.5);
  const before = drawingPoint(start, cursor, viewport, content);
  const after = drawingPoint(zoomed, cursor, viewport, content);
  assert.ok(Math.abs(after.x - before.x) < 1e-9, `x drifted by ${after.x - before.x}`);
  assert.ok(Math.abs(after.y - before.y) < 1e-9, `y drifted by ${after.y - before.y}`);
});

test("zooming stops at its limits instead of running away", () => {
  const viewport = { height: 600, width: 800 };
  const content = { height: 900, width: 1000 };
  const centre = { x: 400, y: 300 };
  const maxed = zoomToward({ pan: { x: 0, y: 0 }, zoom: 1 }, centre, 100, viewport, content);
  assert.equal(zoomToward(maxed, centre, 100, viewport, content), maxed);
  const floored = zoomToward({ pan: { x: 0, y: 0 }, zoom: 0.3 }, centre, 0.01, viewport, content);
  assert.equal(floored.zoom, 0.3);
});

test("the tree draws the four node tones in a draggable viewport", () => {
  const html = renderToStaticMarkup(
    <EvolveTree bestIndex={1} candidates={view().candidates} onSelect={() => {}} />,
  );
  assert.match(html, /aria-label="优化树，共 4 个节点"/);
  assert.match(html, /evolve-tree-node is-best/);
  assert.match(html, /evolve-tree-node is-quiet/);
  assert.match(html, /evolve-tree-node is-failed/);
  assert.match(html, /evolve-tree-edge/);
  assert.match(html, /evolve-tree-badge/);
  assert.match(html, /evolve-tree-viewport/);
  assert.doesNotMatch(html, /evolve-tree-zoom/);
});

test("a tree with no nodes says so instead of drawing an empty frame", () => {
  const html = renderToStaticMarkup(
    <EvolveTree candidates={[]} onSelect={() => {}} />,
  );
  assert.match(html, /还没有节点/);
  // Nothing to place: no node canvas is drawn.
  assert.equal(html.includes("evolve-tree-canvas"), false);
});

test("the inspector explains a root instead of diffing it against nothing", () => {
  const root = candidate({ depth: 0, nodeIndex: 0, parentIndex: null, score: 0.4 });
  const html = renderToStaticMarkup(
    <CandidateInspector candidate={root} client={client} onClose={() => {}} runId="run-1" />,
  );
  assert.match(html, /这是起点，没有父代/);
  assert.match(html, /evolve-drawer-meta">起点/);
});

test("the node drawer shows the score, the parent and one way to expand the diff", () => {
  const html = renderToStaticMarkup(
    <CandidateInspector
      best
      candidate={candidate({ codeHash: "sha256:child", depth: 2 })}
      childCount={3}
      client={client}
      onClose={() => {}}
      parent={candidate({ codeHash: "sha256:parent", depth: 1, nodeIndex: 0, parentIndex: null })}
      runId="run-1"
    />,
  );
  assert.match(html, /Node #1/);
  assert.match(html, /最佳/);
  assert.match(html, /父代 #0/);
  assert.match(html, /层数 02/);
  assert.match(html, /优化分数/);
  assert.match(html, /0\.5000/);
  assert.match(html, /子节点数/);
  assert.match(html, />3</);
  assert.match(html, /代码变更/);
  assert.match(html, /aria-label="展开代码变更"/);
  // The handoff's copy button and the modal's footer are deliberately absent.
  assert.equal(html.includes("复制"), false);
  assert.equal(html.includes("aria-modal"), false);
});

test("the create dialog collects the task, the search and the pace on one form", () => {
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
  assert.match(html, /选择搜索算法/);
  assert.match(html, /PUCT算法/);
  assert.match(html, /OpenEvolve算法/);
  // Each search is one chip; its description is the illustrated card that
  // floats under the row, so the form stays short and the reading is on demand.
  assert.equal((html.match(/class="evolve-algorithm-chip/g) ?? []).length, 2);
  assert.equal((html.match(/evolve-algorithm-art is-/g) ?? []).length, 2);
  // Neither card is laid out until a pointer or the keyboard asks for one;
  // both stay in the DOM so `aria-describedby` resolves for both chips.
  assert.equal((html.match(/class="evolve-algorithm-detail/g) ?? []).length, 2);
  assert.equal(html.includes("evolve-algorithm-detail is-open"), false);
  assert.match(html, /id="evolve-algorithm-detail-puct"/);
  assert.match(html, /逐步改进/);
  assert.match(html, /搜索空间窄/);
  assert.match(html, /基于PUCT策略，优先扩展高潜力节点/);
  assert.match(html, /搜索空间宽/);
  assert.match(html, /避免过早收敛/);
  assert.match(html, /MAP-Elites网格保留多样化优质候选/);
  // The task is asked here, and it is required: the design conversation has
  // nothing to start from without it.
  assert.match(html, /任务描述/);
  const taskField = html.match(/<textarea[^>]*>/)?.[0] ?? "";
  assert.match(taskField, /class="evolve-create-task-input"/);
  assert.match(taskField, /required=""/);
  assert.match(html, /自定义演进参数/);
  // The starting values and the editable set stay folded away until asked for.
  assert.match(html, /class="evolve-create-direction" hidden=""/);
  assert.match(html, /开始设计/);
});

test("the create dialog starts from the task the composer already held", () => {
  const html = renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initialGoal="让压缩比更高且完全无损"
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={{ canInitialize: true, state: "ready" }}
    />,
  );
  // A sentence typed before the surface opened is carried in, not asked for
  // twice.
  assert.match(html, /<textarea[^>]*>让压缩比更高且完全无损<\/textarea>/);
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

test("the create dialog opens on the search the command named", () => {
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const render = (initialAlgorithm?: "puct" | "openevolve") => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initialAlgorithm={initialAlgorithm}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );

  // A `--algorithm openevolve` draft that had to detour through setup comes
  // back with that search selected, not on the dialog's own default.
  const openEvolve = render("openevolve");
  assert.match(openEvolve, /aria-checked="true"[\s\S]{0,600}?evolve-algorithm-name">OpenEvolve算法/);
  assert.match(openEvolve, /aria-checked="false"[\s\S]{0,600}?evolve-algorithm-name">PUCT算法/);

  const byDefault = render();
  assert.match(byDefault, /aria-checked="true"[\s\S]{0,600}?evolve-algorithm-name">PUCT算法/);
});

test("the generate action names the real reason it is unavailable", () => {
  // `onGenerateDirection` reaches the input only while the dialog has both a
  // session detail to draft from and a task typed in the field — App.tsx
  // derives it from `state.detail` and the dialog gates it on the goal — so
  // its absence is not something retyping the task can fix. The hint names
  // what the user can still do instead: upload a file or add parameters.
  const status: EvolveStatus = { canInitialize: true, state: "ready" };
  const render = (
    onGenerateDirection?: (task: string, signal: AbortSignal) => Promise<{ baseline: string; editable: string[] }>,
    goal = "",
  ) => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initialGoal={goal}
      initializing={false}
      onClose={() => {}}
      onGenerateDirection={onGenerateDirection}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={status}
    />,
  );
  const button = /<button[^>]*>生成起始参数<\/button>/;
  const disabled = (html: string) => /<button[^>]*disabled=""[^>]*>生成起始参数<\/button>/.test(html);

  const withoutSession = render();
  // Still offered, but now visibly unavailable and explained.
  assert.match(withoutSession, button);
  assert.equal(disabled(withoutSession), true);
  assert.match(withoutSession, /无法自动生成/);
  assert.equal(withoutSession.includes("先在会话输入框写下任务"), false);

  // With a session detail but no task there is nothing to draft from either,
  // so the button stays gated until the task field has something in it.
  const withoutTask = render(async () => ({ baseline: "{}", editable: [] }));
  assert.match(withoutTask, button);
  assert.equal(disabled(withoutTask), true);
  assert.match(withoutTask, /无法自动生成/);

  const ready = render(async () => ({ baseline: "{}", editable: [] }), "压缩并解压文本，往返完全无损");
  assert.match(ready, button);
  assert.equal(disabled(ready), false);
  assert.equal(ready.includes("无法自动生成"), false);
});

test("a host with no sandbox warns that candidates run unconfined", () => {
  // The warning is a statement under the title, not a switch: consent is asked
  // when the search is started, so the form must not offer to give it early.
  const render = (sandbox: EvolveStatus["sandbox"], state: EvolveStatus["state"]) => renderToStaticMarkup(
    <EvolveCreateDialog
      archived={false}
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      onSend={() => {}}
      running={false}
      status={{ canInitialize: true, sandbox, state }}
    />,
  );

  const direct = render("direct", "ready");
  assert.match(direct, /class="evolve-create-notice"/);
  assert.match(direct, /role="note"/);
  assert.match(direct, /没有沙箱的情况下运行候选代码/);
  assert.match(direct, /这台机器没有可用的沙箱/);
  assert.match(direct, /可以读写你的文件、访问网络/);
  assert.match(direct, /会再确认一次/);
  // The warning sits above the search cards, where a title-adjacent banner is
  // read before anything is chosen.
  assert.equal(direct.indexOf("evolve-create-notice") < direct.indexOf("选择搜索算法"), true);
  // No control carries the consent: the switches on the form are the pace and
  // the parameter scope, and neither can grant it.
  assert.equal((direct.match(/role="switch"/g) ?? []).length, 2);

  // Before the runtime is ready it has not said which isolation it will use,
  // so the dialog states the risk instead of promising one.
  assert.match(render("bwrap", "not_initialized"), /class="evolve-create-notice"/);

  // A ready runtime on a sandboxed host has nothing to warn about.
  for (const sandbox of ["bwrap", "seatbelt", null, undefined] as const) {
    assert.equal(
      render(sandbox, "ready").includes("evolve-create-notice"),
      false,
      `${String(sandbox)}: a sandboxed host must not warn about unconfined runs`,
    );
  }
});

test("a runtime warning is drawn only while the runtime is not usable", () => {
  const render = (status: EvolveStatus) => renderToStaticMarkup(
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

  // A ready runtime states itself by the absence of the warning, even on a host
  // with no sandbox — that host has its own, separate notice.
  const ready = render({ canInitialize: true, sandbox: "direct", state: "ready" });
  assert.equal(ready.includes("优化进程不可用"), false);
  assert.equal(ready.includes("查看详情"), false);

  for (const state of ["not_initialized", "installing", "error"] as const) {
    const html = render({ canInitialize: true, state });
    assert.match(html, /优化进程不可用|优化进程正在准备/, `${state}: the warning names the problem`);
    assert.match(html, /查看详情/, `${state}: the warning leads somewhere`);
    assert.equal(html.indexOf("查看详情") < html.indexOf("选择搜索算法"), true, `${state}: above the choice`);
  }
});

test("a search that ran without a sandbox is not marked in the transcript or the panel", () => {
  // The risk is named once, where it is decided: the confirmation the reader
  // answers before the search starts. Afterwards the card and the panel carry
  // the search's own readings, and a badge that stays on every surface the run
  // touches reads as noise rather than as a warning.
  const marked = run({ goal: { ...run().goal, allowUnisolated: true } });
  const cards = renderToStaticMarkup(
    <EvolveRuns onOpen={() => {}} runs={[marked, run({ id: "isolated" })]} />,
  );
  assert.equal(cards.includes("无隔离"), false);

  const detail = renderToStaticMarkup(
    <EvolveDetail
      client={client}
      onError={() => {}}
      onRunChanged={() => {}}
      run={marked}
    />,
  );
  assert.equal(detail.includes("候选代码没有在沙箱中执行"), false);
});

test("an unusable runtime keeps the form and greys out the start", () => {
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
  // The choice the user made is not replaced by a setup pane: only the button
  // that cannot work is disabled.
  assert.match(html, /选择搜索算法/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>开始设计<\/button>/);
  // The install lives behind 查看详情, not in the form.
  assert.equal(html.includes("准备运行时"), false);
});

test("the runtime details name the files and the install that fix it", () => {
  const status: EvolveStatus = {
    canInitialize: true,
    error: "Evolve service is unavailable or authentication failed.",
    state: "error",
  };
  const html = renderToStaticMarkup(
    <EvolveRuntimeDialog
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      status={status}
    />,
  );
  assert.match(html, /演化运行时不可用/);
  // The server's own words are kept verbatim.
  assert.match(html, /Evolve service is unavailable or authentication failed\./);
  // The Windows paths a desktop user can actually open.
  assert.match(html, /%USERPROFILE%\\\.sciencediscovery\\logs\\api\.log/);
  assert.match(html, /%USERPROFILE%\\\.sciencediscovery\\logs\\evolve\.log/);
  assert.match(html, /%USERPROFILE%\\\.sciencediscovery\\evolve/);
  assert.match(html, /shell\.log/);
  // And the one action the dialog can take for the user.
  assert.match(html, /<button[^>]*>准备运行时<\/button>/);
});

test("a deployment that will not install says so instead of offering a dead button", () => {
  const status: EvolveStatus = { canInitialize: false, state: "not_initialized" };
  const html = renderToStaticMarkup(
    <EvolveRuntimeDialog
      initializing={false}
      onClose={() => {}}
      onInitialize={() => {}}
      status={status}
    />,
  );
  assert.match(html, /请联系管理员/);
  assert.match(html, /<button[^>]*disabled=""[^>]*>准备运行时<\/button>/);
});
