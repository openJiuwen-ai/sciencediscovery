import test from "node:test";
import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import {
  COLD_BACKEND_TIMEOUT_MS,
  PROVISIONING_BACKEND_TIMEOUT_MS,
  killStackTree,
  nextPollDelayMs,
  stackArgs,
  startupBudgetMs,
  summarizeStackFailure,
  waitHealthy,
  waitHealthyOrExited,
} from "../src/stack.ts";

test("stack args pin the start-stack contract", () => {
  const { entry, args } = stackArgs("R");
  assert.ok(entry.replace(/\\/g, "/").endsWith("R/scripts/start-stack.mjs"));
  assert.deepEqual(args, ["--mode", "local", "--no-node-build"]);
});

test("poll delay stays fast for the first minute, then doubles, caps at 5s, gives up past the max", () => {
  // Fast window: flat base interval (default 250ms) until 60s.
  assert.equal(nextPollDelayMs(0, 120_000), 250);
  assert.equal(nextPollDelayMs(30_000, 120_000), 250);
  assert.equal(nextPollDelayMs(59_999, 120_000), 250);
  // Backoff after 60s: doubles every 10s, capped at 5s.
  assert.equal(nextPollDelayMs(60_000, 120_000), 250);
  assert.equal(nextPollDelayMs(70_000, 120_000), 500);
  assert.equal(nextPollDelayMs(80_000, 120_000), 1000);
  assert.equal(nextPollDelayMs(90_000, 120_000), 2000);
  assert.equal(nextPollDelayMs(120_000, 120_000), -1);   // give up
  // Explicit baseMs still honored (legacy callers).
  assert.equal(nextPollDelayMs(0, 60_000, 1000), 1000);
});

// --- Staged startup budgets (cold start measured 2:23 vs the old flat
// 120s that misrouted the window to the auth fallback) --------------------------

test("startup budget is staged: 1200s provisioning, 600s cold, env override wins", () => {
  assert.equal(PROVISIONING_BACKEND_TIMEOUT_MS, 1_200_000);
  assert.equal(COLD_BACKEND_TIMEOUT_MS, 600_000);
  assert.equal(startupBudgetMs(true, {}), PROVISIONING_BACKEND_TIMEOUT_MS);
  assert.equal(startupBudgetMs(false, {}), COLD_BACKEND_TIMEOUT_MS);
  // The test hook overrides both branches.
  assert.equal(startupBudgetMs(true, { SD_SHELL_STARTUP_TIMEOUT_MS: "15000" }), 15_000);
  assert.equal(startupBudgetMs(false, { SD_SHELL_STARTUP_TIMEOUT_MS: "15000" }), 15_000);
  // Junk is ignored, not fatal.
  assert.equal(startupBudgetMs(false, { SD_SHELL_STARTUP_TIMEOUT_MS: "abc" }), COLD_BACKEND_TIMEOUT_MS);
  assert.equal(startupBudgetMs(false, { SD_SHELL_STARTUP_TIMEOUT_MS: "0" }), COLD_BACKEND_TIMEOUT_MS);
  assert.equal(startupBudgetMs(false, { SD_SHELL_STARTUP_TIMEOUT_MS: "-5" }), COLD_BACKEND_TIMEOUT_MS);
});

test("waitHealthy returns true on first ok response", async () => {
  const okFetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  assert.equal(await waitHealthy("http://x/health", 1000, okFetch), true);
});

test("waitHealthy gives up after maxMs of failures", async () => {
  const badFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const start = Date.now();
  assert.equal(await waitHealthy("http://x/health", 1500, badFetch), false);
  assert.ok(Date.now() - start >= 1400, "should have kept polling until the budget ran out");
});

// --- Fail fast when the stack process dies instead of polling the
// health port for the whole budget ---------------------------------------------

test("summarizeStackFailure names the exit code and the last stderr lines", () => {
  const msg = summarizeStackFailure(1, [
    "Starting the control API...", // old noise — beyond the 8-line tail
    ...Array.from({ length: 8 }, (_, i) => `noise ${i}`),
    "JiuwenSwarm did not come up within 240s (probes: 16); diagnostics: C:\\d",
    "unrelated noise",
    "final line",
  ]);
  assert.match(msg, /退出码 1/);
  assert.match(msg, /JiuwenSwarm did not come up/);
  assert.match(msg, /final line/);
  assert.doesNotMatch(msg, /Starting the control API/, "only the last lines matter");
  assert.doesNotMatch(msg, /noise 0/, "the 8-line window holds, old lines drop");
});

test("summarizeStackFailure surfaces every named port occupant", () => {
  // The start-stack port-conflict report: one line per conflicted port (up
  // to 5) + one bilingual guidance line — all of it must reach the wizard.
  const msg = summarizeStackFailure(1, [
    "Cannot bind the ports this stack needs:",
    "  - runner 127.0.0.1:4311 — occupied by ScienceDiscovery.exe (PID 26716).",
    "  - api 127.0.0.1:4410 — occupied by ScienceDiscovery.exe (PID 40936).",
    "  - adapter 127.0.0.1:4310 — occupied by python.exe (PID 37600).",
    "  - memory-graph 127.0.0.1:17674 — occupied by python.exe (PID 21120).",
    "  - evolve 127.0.0.1:4313 — occupied by python.exe (PID 40060).",
    "Close the occupying program(s) (or exit the other ScienceDiscovery from its tray icon), then retry / 请关闭占用端口的程序（或退出托盘里已有的 ScienceDiscovery）后重试。",
  ]);
  for (const port of ["4311", "4410", "4310", "17674", "4313"]) {
    assert.ok(msg.includes(port), `${port} conflict must be visible`);
  }
  assert.match(msg, /请关闭占用端口的程序/);
});

test("summarizeStackFailure survives empty stderr, blanks and unknown exit codes", () => {
  assert.match(summarizeStackFailure(1, []), /无错误输出/);
  assert.match(summarizeStackFailure(null, []), /退出码 未知/);
  assert.match(summarizeStackFailure(null, ["  ", "", "boom"]), /boom/);
});

test("waitHealthyOrExited reports exited when the process dies and health never binds", async () => {
  const badFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const handle = { exited: Promise.resolve(1) };
  const result = await waitHealthyOrExited(handle, "http://x/health", 120_000, badFetch);
  assert.deepEqual(result, { kind: "exited", code: 1 });
});

test("waitHealthyOrExited double-checks health on exit (simultaneous-ready race)", async () => {
  // Exit resolves immediately AND health answers: whichever wins the race,
  // the outcome must be healthy — the retry probe closes the race.
  const okFetch = (() => Promise.resolve(new Response("{}", { status: 200 }))) as typeof fetch;
  const handle = { exited: Promise.resolve(0) };
  const result = await waitHealthyOrExited(handle, "http://x/health", 120_000, okFetch);
  assert.equal(result.kind, "healthy");
});

test("waitHealthyOrExited times out when the process lives but never turns healthy", async () => {
  const badFetch = (() => Promise.reject(new Error("ECONNREFUSED"))) as typeof fetch;
  const handle = { exited: new Promise<never>(() => {}) }; // never resolves
  const result = await waitHealthyOrExited(handle, "http://x/health", 400, badFetch);
  assert.equal(result.kind, "timeout");
});

// --- Reap a recorded spawn the wizard gave up on ----------------------
// Wedged stacks from earlier sessions were left
// alive holding epoch ports and data-dir locks, so every retry shifted epochs
// and stacked another zombie on top.

test("killStackTree terminates a spawned process tree", async () => {
  // A real tree: cmd.exe with a ping child, like start-stack.mjs parenting
  // its services. taskkill /PID <pid> /T /F must take down the whole tree.
  const child = spawn("cmd.exe", ["/c", "ping -n 60 127.0.0.1"], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid, "spawned child must have a pid");
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  // Give the tree a moment to actually start (ping child must exist too).
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(child.exitCode, null, "tree should still be alive before the kill");

  await killStackTree(pid, () => {});
  const code = await exited;
  assert.notEqual(code, null, "killStackTree must have terminated the tree");
});
