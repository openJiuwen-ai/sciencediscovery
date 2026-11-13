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

import { expect } from "@playwright/test";

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
import { realModelApiVariant, realModelThinking } from "./helpers/real-model-thinking.ts";

/**
 * The problem statement, verbatim. It is the user's input to the design
 * conversation, not a test fixture: the Agent has to read this, build the
 * evaluator, and submit the search itself. Changing it changes the case.
 */
const PROBLEM = `目标：只跑 LLM-SRBench 的一道题 lsr_transform_i.34.1_2_0，配置对齐 era-srbench-deepseek-transform 的旗标。

【唯一题目】
problem_id = lsr_transform_i.34.1_2_0
subset = lsr_transform
input_vars = omega, c, v（顺序与数据列一致）
数据已预置在工作区 lsr_transform_i.34.1_2_0.json：train_input / train_output / test_input /
test_output / input_vars / output_vars，键名与 parquet 列相同；直接读取该文件，不要再联网下载。
训练最多用 4000 行，id_test 用 test_* 全部行。
不要跑其它题。

【协议】
本题单独一棵 PUCT 树（per-problem 语义）。expansions=24，workers=3，同步。

【答案格式 program】
候选定义可拟合的 equation(omega, c, v, params)（或等价入口）：最多 10 个 params[i]；
harness 用 scipy.optimize.minimize(..., method="BFGS")、初值 [1.0]*10 拟合后，在 held-out / id_test 上算 NMSE。
禁止 eval/exec/compile；禁止按题号硬编码答案字符串。

【允许函数】
sin, cos, tan, asin/arcsin, acos/arccos, atan/arctan, sinh, cosh, tanh,
exp, log, log10, log1p, sqrt, cbrt, abs/Abs, sign；pi, e；+ - * / **。
禁止 where/heaviside/比较分段查表。

【起点】
linear：params[0]*omega + params[1]*c + params[2]*v + params[3]。

【评分】
NMSE = MSE/Var(y)；非法/异常/非有限/超时 → 0。
排序用 min(12, -log10(NMSE))/12。
同时报告 Acc(0.1)（最坏相对误差 < 0.1 则 1）。
problem_seconds=20；candidate_timeout=120。

【create_evolve_run】
algorithm=puct
expansions=24
workers=3
thinking=disabled
search.cPuct=1.0
priorExponent 省略
split: gateShards=8, rolloutShards=4, testShards=2, seed=0
# shardRows：把本题验证池按片均分，保证每片有足够样本（对齐上游 6 shard×held_out_frac=0.5 的稳定度）
packages=["numpy","scipy"]
temperature=0.7, max_tokens=12000, reply_attempts=4, staleness=guarded
模型偏好 deepseek-v4-flash

【验收对照】
记录：linear baseline digits≈1.58 → best digits=12、acc=1。你的 run 在 id_test 上报告同样指标。”`;

/** What a turn that ends on a checkpoint without a card is answered with. */
const CONTINUATION = "你决定，按文档推荐规模直接跑；使用 PUCT，完成余下检查点并启动搜索。"
  + "只跑 lsr_transform_i.34.1_2_0，不要跑其它题。";

/**
 * What a design turn that spent its whole turn budget without starting the
 * search is answered with.
 *
 * The design can spend every model turn it has re-deriving the evaluator and
 * the seed program — one turn burned 128 of them and returned nothing — and a
 * second "you decide" invites the same. A person watching it would stop the
 * checking and say start with what is in the workspace.
 */
const START_NOW = "不要再核对评估器或候选程序的细节，用工作区里现有的 evaluator 和 candidate 立即调用 create_evolve_run，"
  + "按文档推荐规模启动 lsr_transform_i.34.1_2_0 的 PUCT 搜索。只跑这一道题。";

/**
 * One problem of `pkuHaowei/llm-srbench` (`lsr_transform`), already extracted
 * from the subset's parquet. The problem allows the data to come from the
 * workspace, and seeding it keeps the case about the desktop flow rather than
 * about whether the sandbox can reach a dataset mirror: `huggingface.co` is
 * unreachable from some runners, the public mirror is slow, and the design
 * spends most of its budget downloading.
 *
 * `test/fixtures/srbench/README.md` records where the file came from.
 */
const DATASET_FILE = {
  name: "lsr_transform_i.34.1_2_0.json",
  path: new URL("./fixtures/srbench/lsr_transform_i.34.1_2_0.json", import.meta.url).pathname,
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
 * Purpose: The new desktop entry starts a real PUCT search for one LLM-SRBench
 *          problem and watches it expand past the starting program.
 * Steps:
 *   1. Open a desktop Session pointed at the real endpoint and seed the
 *      problem's rows into its workspace.
 *   2. Choose PUCT in 程序演进实验, then send the documented LLM-SRBench goal
 *      from the composer, where the dialog leaves its flags as a token.
 *   3. Answer the design checkpoints through the card, or with the documented
 *      "you decide" reply when the model ends a turn without one, until the
 *      design calls create_evolve_run.
 *   4. Watch the background search reach three expansions and read each
 *      candidate by the hash its event recorded.
 *   5. Open the running search from the runs list, then stop it; the scores are
 *      recorded, never used as a gate. The search does not have to finish.
 * Environment: Linux Swarm stack selected by E2E_BASE_URL, with bubblewrap,
 *              scientific Python and the evolve sidecar, plus the desktop Vite
 *              entry on 4178 proxied to that stack.
 *              E2E_SRBENCH_SMOKE_TIMEOUT_MS bounds design plus expansions
 *              (default one hour) and E2E_SRBENCH_MIN_EXPANSIONS the bar
 *              (default three).
 * Type: real
 * LLM: Real configured model designs the evaluator and generates candidates.
 * WebSearch: none required; the problem's rows are seeded into the workspace
 *            from test/fixtures/srbench and the design reads them there.
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
test("desktop /evolve-design reaches three PUCT expansions on an LLM-SRBench problem", {
  tag: ["@real", "@category:e2e", "@os:linux", "@arch:amd64", "@model:real", "@tier:l4", "@sandbox:bubblewrap"],
}, async ({ page, journey }, info) => {
  // One design conversation plus three expansions, not a whole search: an hour
  // is generous for both, and the smoke case is over as soon as the third
  // expansion lands.
  const budget = positiveNumber("E2E_SRBENCH_SMOKE_TIMEOUT_MS", 3_600_000);
  test.setTimeout(budget + 300_000);
  // One clock for the whole smoke: the design and the expansions share it, so
  // a slow design cannot hand the search a second, fresh hour.
  const deadline = Date.now() + budget;

  // A stack whose key is stored server-side names its profile by id instead of
  // exporting the credential; both forms reach the same real endpoint.
  if (process.env.E2E_MODEL_ID?.trim()) {
    allowRealEnvException(info, "Reuse the real model profile already configured on the stack.");
  } else {
    requireRealEnv(info, "E2E_LLM_BASE_URL", "E2E_LLM_MODEL", "E2E_LLM_TOKEN");
  }
  // Same origin the helper talks to: a health probe against a different port
  // would gate on one stack and then drive another.
  await requireRealStack(info, API_ORIGIN);
  await seedDesktopOrigin(page);

  const metrics: Record<string, any> = {
    case: "DESKTOP-PUCT-SRBENCH",
    problem_id: "lsr_transform_i.34.1_2_0",
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
    goal: "Start one LLM-SRBench PUCT search from the desktop create dialog and watch it expand three times.",
    preconditions: ["Real model", "Working sandbox, Python environment and evolve sidecar", "Desktop entry on 4178"],
  });

  try {
    await journey.step("Open a desktop Session with the real model", "The new entry reaches the workspace, not the wizard.", async () => {
      const thinking = realModelThinking();
      fixture = await createDesktopFixture(page, {
        model: { apiVariant: realModelApiVariant(), ...thinking },
        session: thinking,
      });
      metrics.session_id = fixture.session.id;
      metrics.model = fixture.model?.model ?? null;
      await openDesktopSession(page, fixture);
    });

    await journey.step("Seed the problem's data into the workspace", "The design reads the problem's rows from the workspace, not from a dataset mirror.", async () => {
      // The seed is the same upload route the composer's paperclip uses, so
      // the file lands where the sandbox sees it — and before the design
      // starts, so its first turn already has the data to read.
      await uploadWorkspaceFile(page, fixture!.session.id, DATASET_FILE);
      // Read it back through the route the UI opens a workspace file with: an
      // upload that answered 200 but landed elsewhere would leave the design
      // searching a workspace that does not have the data.
      const stored = await page.request.get(
        `${API_ORIGIN}/api/sessions/${encodeURIComponent(fixture!.session.id)}/file?path=${encodeURIComponent(DATASET_FILE.name)}`,
        { headers: { authorization: `Bearer ${process.env.E2E_API_TOKEN ?? ""}`, connection: "close" } },
      );
      expect(stored.ok(), `the seeded dataset must be readable back (HTTP ${stored.status()})`).toBe(true);
      const text = await stored.text();
      expect(text, "the seeded dataset must be the extracted problem").toContain("lsr_transform_i.34.1_2_0");
    });

    await journey.step("Start the design from 程序演进实验 with PUCT", "The dialog's flags and the composer's sentence leave as one command.", async () => {
      // The entry is a row of 会话设置, the menu behind the sliders beside the
      // composer's plus — not a capsule of its own in the session bar.
      const settings = page.getByRole("button", { name: "会话设置" });
      await expect(settings).toBeVisible({ timeout: 120_000 });
      await settings.click();
      const capsule = page.getByRole("button", { name: "程序演进实验" });
      await expect(capsule).toBeVisible({ timeout: 30_000 });
      await capsule.click();

      const dialog = page.getByRole("dialog");
      await expect(dialog).toContainText("新建程序演进实验");

      const start = dialog.getByRole("button", { name: "开始设计" });
      // The submit is greyed for two independent reasons now: no task yet, or
      // no ready runtime. Write the task first, so what the probe below reads
      // is the runtime alone — with an empty task the button never enables and
      // a ready host would still be mistaken for a missing install.
      await dialog.getByLabel("任务描述").fill(PROBLEM);
      // The submit stays greyed until the runtime reports ready, and that read
      // lands after the dialog opens — the banner is drawn meanwhile, so
      // "banner is up" is not the same as "the runtime is missing". Give the
      // read a moment before concluding the install is needed.
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
        // The install runs in the background; the runtime dialog stays on top
        // of the create dialog until it is closed. Two buttons read 关闭 — the
        // header's × and the footer's — so name the footer's.
        await page.locator(".evolve-runtime-dialog .modal-footer")
          .getByRole("button", { name: "关闭" }).click();
      }
      await expect(start).toBeEnabled({ timeout: 15 * 60_000 });

      const puct = dialog.getByRole("radio", { name: /PUCT/ });
      await puct.click();
      await expect(puct).toHaveAttribute("aria-checked", "true");

      // Pausing is the default and the case keeps it: the checkpoints are the
      // new surface, and a design that runs through them unattended would not
      // exercise it.
      await expect(dialog.getByRole("switch", { name: /检查点需要人工确认/ })).toBeChecked();

      await start.click();

      // Windows has no sandbox; the dialog asks there and the command carries
      // `--allow-direct` only after this answer. On the CI host this is absent.
      const unisolated = page.getByRole("alertdialog").getByRole("button", { name: "仍然继续" });
      // The dialog asks in the same interaction as the submit; give the prompt
      // a moment to land before concluding this host has a sandbox.
      await unisolated.waitFor({ state: "visible", timeout: 3_000 }).catch(() => undefined);
      if (await unisolated.isVisible().catch(() => false)) await unisolated.click();
      await expect(dialog).toBeHidden({ timeout: 60_000 });

      // The dialog places its flags as a token in the composer and the task as
      // the sentence after it, and stops there: the message leaves once the
      // user confirms the settings for that task. The task was written in the
      // dialog, so the composer already holds it — retyping it here would
      // prove nothing about the handoff.
      const area = page.locator("#composer-textarea");
      await expect(area).toBeVisible({ timeout: 30_000 });
      await expect(area).toHaveValue(PROBLEM);
      await expect(page.locator(".composer-command")).toContainText("/evolve-design");
      const before = new Set((await api<DesktopRun[]>(page, sessionRuns())).map((run) => run.id));
      await area.press("Enter");
      const confirmation = page.getByRole("dialog", { name: /^(Confirm evolution settings|确认演进设置)$/ });
      await confirmation.getByRole("button", { name: /^(Start evolution|开始演进)$/ }).click();
      await expect.poll(async () => await unisolated.isVisible() || !(await confirmation.isVisible())).toBe(true);
      if (await unisolated.isVisible()) await unisolated.click();
      await expect(confirmation).toBeHidden();

      runId = (await waitForNewRun(page, fixture!.session.id, before)).id;
      metrics.turns.push({ id: runId, kind: "design", prompt: PROBLEM });
    });

    await journey.step("Answer the checkpoints until the search is created", "Each checkpoint is answered where it is asked, and the design reaches create_evolve_run.", async () => {
      let confirmations = 0;
      let resends = 0;
      let started = false;
      /** The steps this case has already answered, so a card that comes back
       *  is treated as a repeat rather than a new question. */
      const answered = new Set<number>();

      while (Date.now() < deadline) {
        const runs = await api<DesktopRun[]>(page, sessionRuns());
        const run = runs.find((candidate) => candidate.id === runId) ?? runs.at(-1);
        searches = await api<any[]>(page, searchList());
        metrics.latest_run = run ?? null;
        metrics.searches = searches;
        await save("desktop-evolve-metrics.json", metrics);

        if (searches.length > 0) {
          started = true;
          break;
        }
        if (run?.status === "failed") {
          const error = String((run as any).error ?? "");
          // A reasoning-only turn is the endpoint's, not the design's: the
          // model finished its stream with no text and no tool call, and the
          // gateway refuses to advance such a turn. A person would send the
          // sentence again; so does the case, a bounded number of times.
          if (/empty terminal turn/i.test(error) && resends++ < 4 && Date.now() < deadline) {
            const before = new Set(runs.map((candidate) => candidate.id));
            await sendMessage(page, fixture!.session.id, CONTINUATION);
            const next = await waitForNewRun(page, fixture!.session.id, before, 180_000);
            metrics.turns.push({ id: next.id, kind: "resend", prompt: CONTINUATION, after: error.slice(0, 300) });
            runId = next.id;
            continue;
          }
          throw new Error(`Main run failed before any search: ${error || "see trajectory"}`);
        }
        if (run?.status === "cancelled") {
          throw new Error("Main run cancelled before any search: see trajectory");
        }

        if (run?.status === "completed") {
          // The design ended its turn before starting a search. Confirm the
          // card the new UI drew; if there is none, fall back to the documented
          // sentence. A reply is a turn, so a new Run is the signal that it was
          // accepted.
          if (confirmations++ >= 8) throw new Error("No search started after eight design replies");
          // The first fruitless turn gets the documented sentence; after that
          // the answer is the one that starts the search with what is there.
          const nudge = confirmations > 1 ? START_NOW : CONTINUATION;
          const before = new Set(runs.map((candidate) => candidate.id));
          const checkpoint = await visibleCheckpoint(page);
          // A step that comes back has already been answered: pressing the same
          // button again would have the design rewrite the same card and loop
          // there until the budget ran out. Answer it with the sentence that
          // settles the pace instead — "you decide, run at the documented
          // scale" — which is what a person who saw the repeat would say.
          const repeated = checkpoint !== undefined && answered.has(checkpoint.step);
          const confirmed = checkpoint !== undefined && !repeated;
          if (confirmed) {
            await checkpoint!.card.getByRole("button", { name: "确认，继续", exact: true }).click();
            answered.add(checkpoint!.step);
          } else {
            await sendMessage(page, fixture!.session.id, nudge);
          }
          const next = await waitForNewRun(page, fixture!.session.id, before, 180_000);
          metrics.turns.push({ id: next.id, kind: confirmed ? "checkpoint" : "continuation", prompt: confirmed ? null : nudge });
          runId = next.id;
          continue;
        }

        // One checkpoint is one model turn; there is no faster state to poll.
        await page.waitForTimeout(5_000);
      }

      expect(started, "The design must call create_evolve_run within the run budget").toBe(true);
      metrics.search_id = latestSearch(searches).id;
    });

    await journey.step("Watch the search reach three expansions", "The tree expands past the starting program, and each candidate is readable by its hash.", async () => {
      const target = positiveNumber("E2E_SRBENCH_MIN_EXPANSIONS", 3);
      const search = latestSearch(searches);
      const eventsPath = `/api/evolve/runs/${encodeURIComponent(search.id)}/events`;
      let events: any[] = [];
      let expanded: any[] = [];
      let status = search.status;

      await expect.poll(async () => {
        const current = (await api<any[]>(page, searchList())).find((run) => run.id === search.id);
        status = current?.status ?? status;
        events = await api<any[]>(page, eventsPath);
        // An expansion that recorded its source is the thing the smoke case
        // asks for; `valid` says whether it also ran, and is reported rather
        // than required — a PUCT run continues through candidates that fail.
        expanded = events.filter((record) => record.event.type === "expanded" && typeof record.event.codeHash === "string");
        metrics.search_status = status;
        metrics.expansions = expanded.length;
        await save("desktop-evolve-metrics.json", metrics);
        // Stop as soon as the bar is met: the search does not have to finish,
        // and every further expansion is model calls the smoke does not need.
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

      // The acceptance figures from the problem statement are recorded beside
      // the search's own numbers, never turned into a pass gate: three
      // expansions is the bar, and the digits are what a reader checks later.
      const current = latestSearch(await api<any[]>(page, searchList()));
      expect(current.algorithm, "The desktop command must select PUCT").toBe("puct");
      const scorecard = evolutionScorecard(current, events);
      await save("quality-scorecard.json", {
        ...scorecard,
        acceptance: {
          expected: { linear_baseline_digits: 1.58, best_digits: 12, acc_0_1: 1 },
          observed: {
            baseline_gate_score: scorecard.baseline_gate_score,
            best_gate_score: scorecard.best_gate_score,
            best_test_score: scorecard.score,
            best_node_index: scorecard.best_node_index,
          },
          gating: false,
        },
      });

      // The new entry is what this case exists for: the runs list is the
      // handle that keeps a running search reachable, and opening its card
      // must read the same run the API just returned. The list lives in the
      // task panel, so opening it is a card press, not a dialog.
      const runs = page.locator(".evolve-runs");
      await expect(runs).toBeVisible({ timeout: 120_000 });
      await runs.locator(".evolve-run-card").first().click();
      await expect(page.locator("#evolve-panel-title")).toBeVisible({ timeout: 60_000 });
      await page.screenshot({ path: info.outputPath("running.png"), fullPage: true });

      // Nothing is left running: the smoke case owns this search.
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
      // The last poll may predate a search the design started just before it
      // failed; read the session's searches once more so nothing is left
      // running after the Project is gone.
      searches = await api<any[]>(page, `/api/evolve/runs?sessionId=${encodeURIComponent(fixture.session.id)}`)
        .catch(() => searches);
      metrics.searches = searches;
    }
    await save("desktop-evolve-metrics.json", metrics);
    if (fixture) {
      const prefix = `/api/sessions/${encodeURIComponent(fixture.session.id)}`;
      await save("session.json", await api<any>(page, prefix).catch(() => null));
      await save("children.json", await api<any[]>(page, `${prefix}/subagents`).catch(() => []));
      await save("artifacts.json", await api<any[]>(page, `${prefix}/artifacts`).catch(() => []));
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

/** The checkpoint card the new UI is waiting on, if there is one.
 *
 *  The step comes back with the card so the caller can tell a new checkpoint
 *  from one it has already answered: the design sometimes writes the same step
 *  again, and pressing the same button a second time only repeats the turn. */
async function visibleCheckpoint(
  page: import("@playwright/test").Page,
): Promise<{ card: import("@playwright/test").Locator; step: number } | undefined> {
  const card = page.locator(".evolve-checkpoint:not(.is-answered)").last();
  const confirm = card.getByRole("button", { name: "确认，继续", exact: true });
  if (!(await confirm.isVisible().catch(() => false))) return undefined;
  if (!(await confirm.isEnabled().catch(() => false))) return undefined;
  const step = Number(await card.getAttribute("data-step"));
  return { card, step: Number.isFinite(step) ? step : 0 };
}
