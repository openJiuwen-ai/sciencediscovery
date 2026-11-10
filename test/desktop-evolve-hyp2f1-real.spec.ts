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

import type { ChildProcess } from "node:child_process";
import { writeFile } from "node:fs/promises";

import { expect, type Page } from "@playwright/test";

import {
  allowRealEnvException,
  requireRealEnv,
  requireRealStack,
  test,
} from "./helpers/e2e.ts";
import {
  API_ORIGIN,
  api,
  cleanupDesktopFixture,
  createDesktopFixture,
  openDesktopSession,
  seedDesktopOrigin,
  sendMessage,
  startDesktopEntry,
  stopDesktopEntry,
  uploadWorkspaceFile,
  waitForNewRun,
  type DesktopFixture,
  type DesktopRun,
} from "./helpers/desktop-evolve.ts";
import { positiveNumber } from "./helpers/deepresearchbench.ts";
import { evolutionScorecard } from "./helpers/evolve-result.mjs";

/**
 * The problem statement, verbatim from the operator's record of the 2F1 search.
 * It is the user's input to the design conversation, not a test fixture: the
 * design has to read this, build the evaluator, and submit the search itself.
 *
 * One line is the case's, not the record's: `【参考数据】`. The statement fixes
 * the reference values ahead of time ("mpmath 30 与 60 dps") and forbids
 * mpmath at evaluation time, so the frozen truth has to reach the workspace
 * somehow. `test/fixtures/hyp2f1/` is that frozen side, seeded before the
 * design starts — the same route the LLM-SRBench case takes for its rows.
 */
const PROBLEM = `目标：在 ScienceDiscovery 里复现已记录的 2F1 双精度程序搜索终局配置与任务契约。create_evolve_run 的数值必须按下表。

【接口】
def hyp2f1(a, b, c, z) -> float
实参，返回单个有限 float64。有有限真值的点不得返回 nan/inf。

【参数分布】
a,b,c 独立 U(-30,30)；z ~ U(-40, 0.999)。
剔除：c 距非正整数 < 1e-3；|真值| < 1e-250；高精度两档不一致的点。
评测点总量对齐 3000：gate / rollout / test 各约 1000 点。

【参考真值】
与候选无关的任意精度预先固化（mpmath 30 与 60 dps，仅保留一致到 25 位）。运行时禁止 mpmath、decimal、fractions。

【评分】
correct_digits = min(12, -log10(|est-exact|/|exact|))；抛错/非有限/超时 → 0。
框架分 = mean_digits/12 ∈ [0,1]。主看 test。

【起点】
scipy.special.hyp2f1 的薄包装。不要点名该用哪种变换。

【允许 import】
math, cmath, numpy, scipy，以及 array/bisect/collections/dataclasses/functools/itertools/operator/statistics/typing/warnings。

【create_evolve_run】
algorithm=puct
expansions=40          # 上游 48；可续跑 8
workers=6
thinking=disabled
search.cPuct=1.0
priorExponent 省略
split: gateShards=8, rolloutShards=8, testShards=8, shardRows=125, seed=0
packages=["numpy","scipy"]
custom_script；整候选~60s、单 shard~45s

【参考数据】
评测点与参考真值已预置在工作区 points.json：rows.gate / rows.rollout / rows.test 各
1000 行，每行 [a, b, c, z, exact]，exact 是 30 位有效数字的十进制字符串；shards=8、
shard_rows=125，第 i 片是 rows[i*125:(i+1)*125]。直接读这个文件，不要联网下载，也不要在
运行时重算真值。`;

/**
 * What a Run that failed with an empty terminal turn is sent again.
 *
 * The endpoint sometimes ends a stream with no text and no tool call, and the
 * gateway refuses to advance such a turn. That is the endpoint's failure, not
 * the design's, so the task is sent again a bounded number of times. It is not
 * the answer to a design that finished its turn: that is a failure the case
 * reports (see the checkpoint loop).
 */
const RESUME = "检查点不需要我确认：按记录里的数值直接完成余下步骤并启动搜索。只做 2F1 这一项。";

/**
 * How long to wait for the desktop to carry the design forward. The client
 * sends its "继续步骤 N/4。" as soon as the turn settles, so this is slack, not
 * a poll interval. A completed turn that nothing carries is the failure this
 * case exists to catch.
 */
const AUTO_CONTINUE_WAIT_MS = 120_000;

/** What a person would reply at a card the client stopped carrying.
 *
 *  A step that ends a second time is refused by the client on purpose: the
 *  push would be a paid turn answering a card that was already answered. The
 *  card says so (`data-auto-continue="stopped"`), and a person who saw it
 *  would answer it — so the case does, with the words the card's own
 *  确认，继续 button stands for. */
const CONFIRM_REPLY = "确认，继续";

/** How many times the case will answer a refused card before calling it stuck. */
const CONFIRM_LIMIT = 4;

/** The Run list entry as the service writes it (`DesktopRun` does not type it). */
interface ListedRun extends DesktopRun {
  createdAt?: string;
}

/** The Run the desktop started after `after`, or `undefined` when the wait runs
 *  out.
 *
 *  Identity is the creation time, not absence from a snapshot: the client
 *  queues its "继续步骤 N/4。" Run within the same second the design turn
 *  settles, so a set of ids read once the watched Run reports `completed` can
 *  already contain the continuation — and a set difference would then wait for
 *  a third Run that never comes.
 *
 *  `[Execution notifications] …` Runs are the platform handing the finished
 *  turn its retained execution statuses. They start on their own and are not
 *  the desktop carrying the design forward, so they are skipped here; the Run
 *  they unblock still matches.
 *
 *  The shared helper's `waitForNewRun` throws at its deadline and keys on a
 *  snapshot; this case needs the absence itself as a result, because "the
 *  desktop did not carry the turn forward" is the failure it reports. */
async function findCarriedRun(
  page: Page,
  sessionId: string,
  after: ListedRun,
  timeout = AUTO_CONTINUE_WAIT_MS,
): Promise<ListedRun | undefined> {
  const since = Date.parse(after.createdAt ?? "");
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    const runs = await api<ListedRun[]>(page, `/api/sessions/${encodeURIComponent(sessionId)}/runs`)
      .catch(() => [] as ListedRun[]);
    const created = runs
      .filter((run) => run.id !== after.id
        && !(run.prompt ?? "").startsWith("[Execution notifications]")
        && (Number.isNaN(since) || Date.parse(run.createdAt ?? "") > since))
      .sort((left, right) => Date.parse(left.createdAt ?? "") - Date.parse(right.createdAt ?? ""))[0];
    if (created !== undefined) return created;
    await page.waitForTimeout(2_000);
  }
  return undefined;
}

/** Whether the card on screen says the client stopped carrying it.
 *
 *  The same step ending twice is refused by design, and the card draws
 *  `data-auto-continue="stopped"` on its band. The badge is written on the
 *  frame the turn settles, a beat after the Run list already says
 *  `completed`, so this waits a moment rather than reading one frame the
 *  client has not reached yet. Absent after the wait means the client did not
 *  refuse this ending (it carried it, or never saw it) — the caller decides
 *  what that means. */
async function refusedAutoContinue(page: Page, timeout = 15_000): Promise<boolean> {
  const badge = page.locator('[data-auto-continue="stopped"]').first();
  const until = Date.now() + timeout;
  while (Date.now() < until) {
    if (await badge.isVisible().catch(() => false)) return true;
    await page.waitForTimeout(1_000);
  }
  return false;
}

/**
 * The recorded contract, as the statement writes it, limited to what
 * `create_evolve_run` actually accepts (`packages/evolve/src/index.ts`).
 *
 * Every field here is recorded, not enforced. The case's bar is that a design
 * starts a search and that the search expands; the numbers the design submits
 * are kept in `metrics.contract` with any difference in `metrics.deviations`,
 * because the probe can legitimately refuse the recorded scoring (a seed at
 * 0.81 leaves too little headroom for `_refuse_thin_headroom`) and a 40-expansion
 * run needs a worker count that divides it — the statement's 6 does not. A
 * strict assertion here would fail every run of this contract on this server,
 * which is a property of the contract, not a defect the case can catch.
 */
const CONTRACT = [
  { label: "algorithm", keys: ["algorithm"], expected: "puct" },
  { label: "expansions", keys: ["expansions"], expected: 40 },
  { label: "workers", keys: ["workers"], expected: 6 },
  { label: "mode", keys: ["mode"], expected: "custom_script" },
  { label: "cPuct", keys: ["search.cPuct", "cPuct"], expected: 1.0 },
  { label: "gateShards", keys: ["split.gateShards", "gateShards"], expected: 8 },
  { label: "rolloutShards", keys: ["split.rolloutShards", "rolloutShards"], expected: 8 },
  { label: "testShards", keys: ["split.testShards", "testShards"], expected: 8 },
  { label: "shardRows", keys: ["split.shardRows", "shardRows"], expected: 125 },
  { label: "seed", keys: ["split.seed", "seed"], expected: 0 },
  { label: "thinking", keys: ["thinking"], expected: "disabled" },
  { label: "priorExponent", keys: ["search.priorExponent", "priorExponent"], expected: undefined },
] as const;

/**
 * The frozen truth for the problem: 3000 points and their reference values.
 * `test/fixtures/hyp2f1/README.md` records how they were produced.
 */
const DATASET_FILE = {
  name: "points.json",
  path: new URL("./fixtures/hyp2f1/points.json", import.meta.url).pathname,
};

let desktop: ChildProcess | undefined;

test.beforeAll(async () => {
  desktop = await startDesktopEntry();
});

test.afterAll(async () => {
  await stopDesktopEntry(desktop);
});

/**
 * E2E-META
 * Purpose: The new desktop entry designs against the 2F1 double-precision
 *          problem with checkpoints off, starts a real PUCT search, and drives
 *          it past three expansions.
 * Steps:
 *   1. Open a desktop Session pointed at the real endpoint and seed the 2F1
 *      evaluation points and frozen reference values into its workspace.
 *   2. Choose PUCT in 程序演进实验 with 检查点需要人工确认 off, then send the
 *      recorded 2F1 problem from the composer, where the dialog leaves its
 *      flags as a token.
 *   3. Let the design run its four steps unattended: the desktop carries a
 *      turn that ended on a recorded card (pace `auto`) until the design calls
 *      create_evolve_run. A step that ends a second time is refused by the
 *      client on purpose, and its card says 已停止自动续跑; the case answers
 *      that card the way a person would (确认，继续), a bounded number of
 *      times. Any other completed turn the desktop does not carry forward is
 *      a failure, and the case sends no reply.
 *   4. Keep the create_evolve_run call the run recorded as evidence of what
 *      the probe accepted, check the one field that proves the pace switch
 *      reached the tool (`checkpointMode: auto`), and record every number that
 *      differs from the statement in metrics.deviations. The numbers are not a
 *      gate — the probe can ask the design to change them — but a difference
 *      is never silent.
 *   5. Watch the background search expand, open it from the runs list, then
 *      stop it; the scores are recorded, never used as a gate.
 * Environment: Linux Swarm stack selected by E2E_BASE_URL, with bubblewrap,
 *              scientific Python and the evolve sidecar, plus the desktop Vite
 *              entry on 4178 proxied to that stack.
 *              E2E_HYP2F1_SMOKE_TIMEOUT_MS bounds design plus expansions
 *              (default one hour) and E2E_HYP2F1_MIN_EXPANSIONS the bar
 *              (default three).
 * Type: real
 * LLM: Real configured model designs the evaluator, lists the fields and
 *      generates candidates.
 * WebSearch: none required; the points and their truth are seeded into the
 *            workspace from test/fixtures/hyp2f1 and the design reads them.
 * PaperSources: none.
 * MCP: platform tools if selected by the Agent; no scripted model or mocked
 *      execution.
 * OtherExternal: Configured model endpoint; the sandbox installs numpy and
 *                scipy from its configured package index.
 * Credentials: E2E_API_TOKEN and E2E_MODEL_ID or E2E_LLM_BASE_URL/
 *              E2E_LLM_MODEL/E2E_LLM_TOKEN.
 * CostSideEffects: Billable model calls and sandbox evaluations; temporary
 *                  Project, Session and model are removed in finally.
 */
test("desktop /evolve-design starts a 2F1 PUCT search that expands", {
  tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l4", "@sandbox:bubblewrap"],
}, async ({ page, journey }, info) => {
  const budget = positiveNumber("E2E_HYP2F1_SMOKE_TIMEOUT_MS", 3_600_000);
  test.setTimeout(budget + 300_000);
  const deadline = Date.now() + budget;

  if (process.env.E2E_MODEL_ID?.trim()) {
    allowRealEnvException(info, "Reuse the real model profile already configured on the stack.");
  } else {
    requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  }
  await requireRealStack(info, API_ORIGIN);
  await seedDesktopOrigin(page);

  const metrics: Record<string, any> = {
    case: "DESKTOP-PUCT-HYP2F1",
    problem_id: "hyp2f1",
    entry: "desktop",
    integration_status: "running",
    started_at: new Date().toISOString(),
    turns: [],
  };
  const save = async (name: string, data: unknown) => {
    await writeFile(info.outputPath(name), JSON.stringify(data, null, 2));
  };

  let fixture: DesktopFixture | undefined;
  let runId: string | undefined;
  let searches: any[] = [];
  const sessionRuns = () => `/api/sessions/${encodeURIComponent(fixture!.session.id)}/runs`;
  const searchList = () => `/api/evolve/runs?sessionId=${encodeURIComponent(fixture!.session.id)}`;

  journey.scenario({
    goal: "Reproduce the recorded 2F1 double-precision contract from the desktop create dialog and start the search it describes.",
    preconditions: ["Real model", "Working sandbox, Python environment and evolve sidecar", "Desktop entry on 4178"],
  });

  try {
    await journey.step("Open a desktop Session with the real model", "The new entry reaches the workspace, not the wizard.", async () => {
      fixture = await createDesktopFixture(page);
      metrics.session_id = fixture.session.id;
      metrics.model = fixture.model?.model ?? null;
      await openDesktopSession(page, fixture);
    });

    await journey.step("Seed the 2F1 points and their frozen truth", "The design reads the points from the workspace instead of rebuilding them.", async () => {
      await uploadWorkspaceFile(page, fixture!.session.id, DATASET_FILE);
      // Read it back the way the UI opens a workspace file: an upload that
      // answered 200 but landed elsewhere would leave the design looking for
      // a file the sandbox does not have.
      const stored = await page.request.get(
        `${API_ORIGIN}/api/sessions/${encodeURIComponent(fixture!.session.id)}/file?path=${encodeURIComponent(DATASET_FILE.name)}`,
        { headers: { authorization: `Bearer ${process.env.E2E_API_TOKEN ?? ""}`, connection: "close" } },
      );
      expect(stored.ok(), `the seeded points must be readable back (HTTP ${stored.status()})`).toBe(true);
      const text = await stored.text();
      expect(text, "the seeded file must carry the problem's splits").toContain("\"rows\"");
      expect(text, "the seeded file must carry the frozen reference values").toContain("\"shard_rows\"");
    });

    await journey.step("Start the design from 程序演进实验 with PUCT", "The dialog's flags and the composer's sentence leave as one command.", async () => {
      const settings = page.getByRole("button", { name: "会话设置" });
      await expect(settings).toBeVisible({ timeout: 120_000 });
      await settings.click();
      const capsule = page.getByRole("button", { name: "程序演进实验" });
      await expect(capsule).toBeVisible({ timeout: 30_000 });
      await capsule.click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("新建程序演进实验");

      const start = dialog.getByRole("button", { name: "开始设计" });
      const deadlineReady = Date.now() + 90_000;
      let runtimeReady = false;
      while (Date.now() < deadlineReady) {
        if (await start.isEnabled().catch(() => false)) { runtimeReady = true; break; }
        await page.waitForTimeout(1_000);
      }
      if (!runtimeReady) {
        const runtimeBanner = dialog.locator(".evolve-create-runtime");
        await runtimeBanner.getByRole("button", { name: "查看详情" }).click();
        await page.getByRole("button", { name: "准备运行时" }).click();
        // Two buttons read 关闭 — the header's × and the footer's.
        await page.locator(".evolve-runtime-dialog .modal-footer")
          .getByRole("button", { name: "关闭" }).click();
      }
      await expect(start).toBeEnabled({ timeout: 15 * 60_000 });

      const puct = dialog.getByRole("radio", { name: /PUCT/ });
      await puct.click();
      await expect(puct).toHaveAttribute("aria-checked", "true");

      // Checkpoints off: the design records each step as a card and starts the
      // search in one pass. The statement no longer asks for a confirmation,
      // so the case is that this pace reaches `create_evolve_run` unattended.
      const pause = dialog.getByRole("switch", { name: /检查点需要人工确认/ });
      await expect(pause).toBeChecked();
      await pause.click();
      await expect(pause).not.toBeChecked();

      await start.click();

      const unisolated = page.getByRole("alertdialog").getByRole("button", { name: "仍然继续" });
      await unisolated.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      if (await unisolated.isVisible().catch(() => false)) await unisolated.click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });

      const area = page.locator("#composer-textarea");
      await expect(area).toBeVisible({ timeout: 30_000 });
      await area.fill(PROBLEM);
      const before = new Set((await api<DesktopRun[]>(page, sessionRuns())).map((run) => run.id));
      await area.press("Enter");

      const design = await waitForNewRun(page, fixture!.session.id, before);
      // The switch is the only thing that decides this, so the command is
      // where the case checks it: a dialog that drew the switch but dropped it
      // from the flags would leave every later step looking the same.
      expect(design.prompt ?? "", "the pace switch must reach the command").toContain("--no-confirm");
      runId = design.id;
      metrics.turns.push({ id: runId, kind: "design", prompt: design.prompt ?? PROBLEM });
    });

    await journey.step("Let the design run its checkpoints without a confirmation", "With the pace switch off, the design records each step and reaches create_evolve_run in one pass.", async () => {
      let resends = 0;
      let started = false;
      let carried = 0;
      let confirms = 0;

      while (Date.now() < deadline) {
        const runs = await api<ListedRun[]>(page, sessionRuns());
        const run = runs.find((candidate) => candidate.id === runId) ?? runs.at(-1);
        searches = await api<any[]>(page, searchList());
        metrics.latest_run = run ?? null;
        metrics.searches = searches;
        metrics.checkpoint_cards = await checkpointCards(page);
        await save("desktop-evolve-metrics.json", metrics);

        if (searches.length > 0) {
          started = true;
          break;
        }
        if (run?.status === "failed") {
          const error = String((run as any).error ?? "");
          if (/empty terminal turn/i.test(error) && resends++ < 4 && Date.now() < deadline) {
            const before = new Set(runs.map((candidate) => candidate.id));
            await sendMessage(page, fixture!.session.id, RESUME);
            const next = await waitForNewRun(page, fixture!.session.id, before, 180_000);
            metrics.turns.push({ id: next.id, kind: "resend", prompt: RESUME, after: error.slice(0, 300) });
            runId = next.id;
            continue;
          }
          throw new Error(`Main run failed before any search: ${error || "see trajectory"}`);
        }
        if (run?.status === "cancelled") {
          throw new Error("Main run cancelled before any search: see trajectory");
        }
        if (run?.status === "blocked") {
          // A configuration checkpoint waits for a person; an unattended design
          // has none. Naming it here beats burning the budget polling a Run
          // that will not move.
          throw new Error(`Run ${run.id} is blocked on a configuration request; an unattended design cannot answer it`);
        }

        if (run?.status === "completed") {
          // The same step ending twice is refused by the client: one more push
          // would answer a card that was already answered. The card says so,
          // and a person who saw it would confirm — the case does the same
          // rather than reporting a stall the UI has already explained.
          if (await refusedAutoContinue(page)) {
            if (confirms >= CONFIRM_LIMIT) {
              throw new Error(
                `The desktop refused to carry the design ${confirms} times; it is not advancing. `
                + `checkpoint cards: ${JSON.stringify(metrics.checkpoint_cards)}`,
              );
            }
            confirms += 1;
            const before = new Set(runs.map((candidate) => candidate.id));
            await sendMessage(page, fixture!.session.id, CONFIRM_REPLY);
            const confirmed = await waitForNewRun(page, fixture!.session.id, before, AUTO_CONTINUE_WAIT_MS);
            metrics.turns.push({ id: confirmed.id, kind: "confirm", prompt: CONFIRM_REPLY });
            runId = confirmed.id;
            continue;
          }
          // The pace is off, so a turn that ended on a recorded card is carried
          // forward by the desktop — not by this case. Wait for the Run it
          // starts before deciding this turn did not advance: sending a reply
          // here would paper over exactly the stall the case exists to catch.
          const next = await findCarriedRun(page, fixture!.session.id, run, AUTO_CONTINUE_WAIT_MS);
          if (next !== undefined) {
            carried += 1;
            metrics.turns.push({ id: next.id, kind: "auto", prompt: next.prompt ?? null });
            runId = next.id;
            continue;
          }
          metrics.turns.push({ id: run.id, kind: "stalled" });
          throw new Error(
            `Run ${run.id} completed without calling create_evolve_run and the desktop did not carry it forward `
            + `within ${AUTO_CONTINUE_WAIT_MS / 1000}s; checkpoint cards: ${JSON.stringify(metrics.checkpoint_cards)}`,
          );
        }

        // One checkpoint is one model turn; there is no faster state to poll.
        await page.waitForTimeout(5_000);
      }

      metrics.auto_continues = carried;
      metrics.auto_confirms = confirms;
      const cards = (metrics.checkpoint_cards ?? []) as Array<{ pace: string | null; waiting: boolean }>;
      metrics.checkpoint_waiting = cards.filter((card) => card.waiting).length;
      expect(started, "The design must call create_evolve_run within the run budget").toBe(true);
      metrics.search_id = latestSearch(searches).id;
    });

    await journey.step("Record the submitted numbers against the recorded contract", "create_evolve_run carries the statement's numbers; any difference is recorded in metrics.deviations rather than failing the run.", async () => {
      const search = latestSearch(searches);
      // The call itself is the authority: a search record keeps a summary, and
      // the statement fixes the request. The event stream is the only place
      // the call's own arguments are kept.
      const args = await evolveCallArgs(page, fixture!.session.id, runId!);
      metrics.evolve_call = args ?? null;

      // The pace the dialog sent lives in the call, and `checkpointMode` is
      // the only field that proves `--no-confirm` survived the composer. It is
      // optional in the schema, so an omission is recorded rather than failed.
      const mode = args?.checkpointMode;
      metrics.checkpoint_mode = mode ?? null;
      if (mode !== undefined) {
        expect(mode, "the dialog's pace switch must reach create_evolve_run").toBe("auto");
      }

      const observed: Record<string, unknown> = {};
      const deviations: Array<{ field: string; expected: unknown; observed: unknown }> = [];
      const same = (actual: unknown, expected: unknown) => {
        if (typeof expected === "number") return Number(actual) === expected;
        return String(actual).toLowerCase() === String(expected).toLowerCase();
      };
      for (const field of CONTRACT) {
        const value = args === undefined ? undefined : pick(args, ...field.keys);
        observed[field.label] = value === undefined ? null : value;
        if (field.expected === undefined) {
          // "priorExponent 省略": recorded when present, never asserted.
          if (value !== undefined) deviations.push({ field: field.label, expected: null, observed: value });
          continue;
        }
        // Not in the call? The search record is the fallback; a field neither
        // side names is a deviation too.
        const actual = value === undefined ? fromSearch(search, field.label) : value;
        if (actual === undefined) observed[field.label] = null;
        if (!same(actual, field.expected)) deviations.push({ field: field.label, expected: field.expected, observed: actual ?? null });
      }
      metrics.contract = observed;

      const packages = (args === undefined ? undefined : pick(args, "packages")) ?? search.goal?.packages;
      metrics.packages = packages ?? null;
      if (packages !== undefined) {
        const named = (Array.isArray(packages) ? packages : [packages]).map(String);
        for (const required of ["numpy", "scipy"]) {
          if (!named.includes(required)) deviations.push({ field: "packages", expected: required, observed: named });
        }
      }
      metrics.deviations = deviations;

      // The search's own record is reported beside the call. The compact form
      // is what a reader needs after the call has been accepted.
      metrics.search_record = {
        algorithm: search.algorithm ?? null,
        expansions: search.goal?.budget?.expansions ?? null,
        workers: search.goal?.budget?.workers ?? null,
        packages: search.goal?.packages ?? null,
        measureKind: search.goal?.scorecard?.criteria?.[0]?.measure?.kind ?? null,
      };

      await save("desktop-evolve-metrics.json", metrics);
    });

    await journey.step("Watch the search expand and read each candidate by its hash", "The tree expands past the starting program, and each candidate is readable by its hash.", async () => {
      const target = positiveNumber("E2E_HYP2F1_MIN_EXPANSIONS", 3);
      const search = latestSearch(searches);
      const eventsPath = `/api/evolve/runs/${encodeURIComponent(search.id)}/events`;
      let events: any[] = [];
      let expanded: any[] = [];
      let status = search.status;

      await expect.poll(async () => {
        const current = (await api<any[]>(page, searchList())).find((run) => run.id === search.id);
        status = current?.status ?? status;
        events = await api<any[]>(page, eventsPath);
        // An expansion that recorded its source is the thing this case asks
        // for; `valid` says whether it also ran, and is reported rather than
        // required — a PUCT run continues through candidates that fail.
        expanded = events.filter((record) => record.event.type === "expanded" && typeof record.event.codeHash === "string");
        metrics.search_status = status;
        metrics.expansions = expanded.length;
        await save("desktop-evolve-metrics.json", metrics);
        return expanded.length >= target
          || ["budget_exhausted", "failed", "stopped", "succeeded"].includes(status);
      }, {
        timeout: Math.max(60_000, deadline - Date.now()),
        intervals: [10_000, 15_000, 30_000],
        message: `the search should record ${target} expansions`,
      }).toBe(true);

      await save("evolve-events.json", events);
      expect(expanded.length, `The search must record at least ${target} expansions`).toBeGreaterThanOrEqual(target);

      const recorded: any[] = [];
      for (const record of expanded.slice(0, target)) {
        const hash = String(record.event.codeHash);
        const candidate = await api<{ hash: string; source: string }>(
          page,
          `${eventsPath.slice(0, -"/events".length)}/candidates/${encodeURIComponent(hash)}`,
        );
        expect(candidate.source.trim().length, `Candidate ${hash} must be readable by its hash`).toBeGreaterThan(0);
        recorded.push({
          nodeIndex: record.event.nodeIndex,
          hash,
          valid: record.event.valid,
          score: record.event.score,
          codeChars: record.event.codeChars ?? candidate.source.length,
        });
      }
      await save("candidates.json", recorded);
      metrics.candidates = recorded;
      await info.attach("candidates", { body: JSON.stringify(recorded, null, 2), contentType: "application/json" });

      const current = latestSearch(await api<any[]>(page, searchList()));
      const scorecard = evolutionScorecard(current, events);
      await save("quality-scorecard.json", {
        ...scorecard,
        acceptance: {
          expected: { correct_digits_target: 12, framework_score_range: [0, 1] },
          observed: {
            baseline_gate_score: scorecard.baseline_gate_score,
            best_gate_score: scorecard.best_gate_score,
            best_test_score: scorecard.score,
            best_node_index: scorecard.best_node_index,
          },
          gating: false,
        },
      });
    });

    await journey.step("Open the running search from the runs list, then stop it", "The runs list keeps the search reachable, and stopping it leaves nothing running.", async () => {
      const runs = page.locator(".evolve-runs");
      await expect(runs).toBeVisible({ timeout: 120_000 });
      await runs.locator(".evolve-run-card").first().click();
      await expect(page.locator("#evolve-panel-title")).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: info.outputPath("running.png"), fullPage: true });

      const search = latestSearch(searches);
      await page.request.post(`${API_ORIGIN}/api/evolve/runs/${encodeURIComponent(search.id)}/stop`, {
        headers: { authorization: `Bearer ${process.env.E2E_API_TOKEN?.trim() ?? ""}` },
      });
      await expect.poll(async () => (await api<any[]>(page, searchList())).find((run) => run.id === search.id)?.status, {
        timeout: 120_000,
        intervals: [2_000, 5_000],
        message: "the stopped search should reach a terminal status",
      }).toMatch(/^(budget_exhausted|failed|stopped|succeeded)$/);

      metrics.integration_status = "passed";
    });
  } catch (error) {
    metrics.integration_status = "failed";
    metrics.error = error instanceof Error ? error.message : String(error);
    throw error;
  } finally {
    metrics.finished_at = new Date().toISOString();
    if (fixture) {
      searches = await api<any[]>(page, `/api/evolve/runs?sessionId=${encodeURIComponent(fixture.session.id)}`)
        .catch(() => searches);
      metrics.searches = searches;
    }
    await save("desktop-evolve-metrics.json", metrics);
    if (fixture) {
      const prefix = `/api/sessions/${encodeURIComponent(fixture.session.id)}`;
      await save("session.json", await api<any>(page, prefix).catch(() => null));
      await save("children.json", await api<any[]>(page, `${prefix}/subagents`).catch(() => []));
      for (const search of searches) {
        await save(`evolve-${search.id}.json`, {
          search,
          events: await api<any[]>(page, `/api/evolve/runs/${encodeURIComponent(search.id)}/events`).catch(() => []),
        });
        if (["pending", "running"].includes(search.status)) {
          await page.request.post(`${API_ORIGIN}/api/evolve/runs/${encodeURIComponent(search.id)}/stop`, {
            headers: { authorization: `Bearer ${process.env.E2E_API_TOKEN?.trim() ?? ""}` },
          }).catch(() => undefined);
        }
      }
      if (runId) {
        await page.request.post(`${API_ORIGIN}${prefix}/runs/${encodeURIComponent(runId)}/cancel`, {
          headers: { authorization: `Bearer ${process.env.E2E_API_TOKEN?.trim() ?? ""}` },
        }).catch(() => undefined);
      }
    }
    await cleanupDesktopFixture(fixture);
  }
});

/** The newest search in a session's list. */
function latestSearch(searches: any[]): any {
  return [...searches]
    .sort((left, right) => String(left.createdAt).localeCompare(String(right.createdAt)))
    .at(-1)!;
}

/** Every checkpoint card on screen, as the design wrote it.
 *
 *  `pace` is the durable half: the card keeps `data-pace` after it folds, so a
 *  card written as `confirm` is still visible as a mistake in the metrics. A
 *  `waiting` card is one still offering 确认，继续 — with the pace switch off
 *  there should never be one, and the case never presses one. */
async function checkpointCards(
  page: Page,
): Promise<Array<{ step: number | null; pace: string | null; waiting: boolean }>> {
  const cards = page.locator(".evolve-checkpoint");
  const out: Array<{ step: number | null; pace: string | null; waiting: boolean }> = [];
  const count = await cards.count();
  for (let index = 0; index < count; index += 1) {
    const card = cards.nth(index);
    const step = Number(await card.getAttribute("data-step"));
    const confirm = card.getByRole("button", { name: "确认，继续", exact: true });
    out.push({
      step: Number.isFinite(step) ? step : null,
      pace: await card.getAttribute("data-pace"),
      waiting: await confirm.isVisible().catch(() => false),
    });
  }
  return out;
}

/** The `create_evolve_run` call the design made, read from the run's events.
 *
 *  A search record keeps a summary of the request; the call keeps the request.
 *  The statement fixes the request, so this is what the case reads. */
async function evolveCallArgs(page: Page, sessionId: string, runId: string): Promise<Record<string, any> | undefined> {
  const events = await api<any[]>(
    page,
    `/api/sessions/${encodeURIComponent(sessionId)}/runs/${encodeURIComponent(runId)}/events`,
  ).catch(() => [] as any[]);
  for (const record of [...events].reverse()) {
    const event = record?.event ?? record;
    const name = event?.trace?.name ?? event?.name;
    if (name !== "create_evolve_run") continue;
    const args = event?.trace?.args ?? event?.args;
    if (args && typeof args === "object") return args as Record<string, any>;
  }
  return undefined;
}

/** Read a dotted path, trying each spelling the schema may use. */
function pick(args: Record<string, any>, ...keys: string[]): any {
  for (const key of keys) {
    const value = key.split(".").reduce<any>((node, part) => (node == null ? node : node[part]), args);
    if (value !== undefined) return value;
  }
  return undefined;
}

/** The same field on the search record, for a call the events did not keep. */
function fromSearch(search: any, label: string): unknown {
  const budget = search?.goal?.budget ?? {};
  const split = search?.goal?.scorecard?.criteria?.[0]?.measure?.split ?? {};
  switch (label) {
    case "algorithm": return search?.algorithm;
    case "expansions": return budget.expansions;
    case "workers": return budget.workers;
    case "gateShards": return split.gateShards;
    case "rolloutShards": return split.rolloutShards;
    case "testShards": return split.testShards;
    case "shardRows": return split.shardRows;
    case "seed": return split.seed;
    default: return undefined;
  }
}

