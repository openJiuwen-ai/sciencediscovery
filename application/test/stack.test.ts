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
  stopExternalStack,
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

test("killStackTree terminates a spawned process tree", async (t) => {
  // A real tree, like start-stack.mjs parenting its services. The kill
  // mechanism differs per platform (taskkill /PID /T /F on win32, group
  // SIGKILL on darwin — the spawn below mirrors the shell's own detached
  // semantics), but both must take down the whole tree.
  //
  // Sandbox caveat (same family as the sandbox-exec exit 71 finding):
  // restricted test environments can silently swallow PROCESS-GROUP
  // signals (kill(-pid) "succeeds" but nothing dies) while direct-pid
  // kills keep working. killStackTree's darwin branch sends BOTH a group
  // kill and a direct leader kill, so the tree dies either way; the
  // grandchildren reaping under a swallowed group signal is a real-machine
  // property verified at B5-1 (M3) on actual macOS, not here.
  //
  // Review F4: each branch spawns a HOST-NATIVE binary (cmd.exe / /bin/sh)
  // and asserts the HOST's real kill semantics — a host check, not a
  // dialect decision, so a Linux CI host can run neither side (cmd.exe
  // ENOENTs there, and the POSIX group-kill contract under test is the
  // darwin shell's own).
  const IS_DARWIN = process.platform === "darwin";
  const IS_WIN32 = process.platform === "win32";
  if (!IS_DARWIN && !IS_WIN32) {
    t.skip("needs a real win32 or darwin host (Linux CI has neither cmd.exe nor the darwin group-kill contract)");
    return;
  }
  const child = IS_DARWIN
    ? spawn("/bin/sh", ["-c", "sleep 30 & sleep 30 & wait"], { detached: true, stdio: "ignore" })
    : spawn("cmd.exe", ["/c", "ping -n 60 127.0.0.1"], { windowsHide: true });
  const pid = child.pid;
  assert.ok(pid, "spawned child must have a pid");
  const exited = new Promise<number | null>((resolve) => child.once("exit", (code) => resolve(code)));
  // Give the tree a moment to actually start (child processes must exist too).
  await new Promise((done) => setTimeout(done, 400));
  assert.equal(child.exitCode, null, "tree should still be alive before the kill");

  await killStackTree(pid, () => {});
  const code = await exited;
  // POSIX signal deaths report code=null + signal=SIGKILL; win32 taskkill
  // deaths report a numeric code. Either way the process must be GONE.
  assert.ok(
    code !== null || child.signalCode !== null,
    `killStackTree must have terminated the tree (code=${code} signal=${child.signalCode})`,
  );
});

// --- F17: netstat port matching is EXACT (no substring false hits) ---------

test("parseNetstatPid matches the exact port, never a suffix-collision (F17)", async () => {
  const { parseNetstatPid } = await import("../src/stack.ts");
  // Real netstat -ano shape. The dangerous rows: 44100 and 14410 both
  // contain "4410" as a substring — the old line.includes() matched them
  // and would have taskkilled the unrelated pid.
  const sample = [
    "  Proto  Local Address          Foreign Address        State           PID",
    "  TCP    127.0.0.1:44100        0.0.0.0:0              LISTENING       111",
    "  TCP    127.0.0.1:14410        0.0.0.0:0              LISTENING       222",
    "  TCP    127.0.0.1:4409         0.0.0.0:0              LISTENING       333",
    "  TCP    127.0.0.1:4410         0.0.0.0:0              LISTENING       4444",
    "  TCP    127.0.0.1:4410         127.0.0.1:9999         ESTABLISHED     555",
  ].join("\r\n");
  assert.equal(parseNetstatPid(sample, 4410), 4444, "exact 4410 row only");
  assert.equal(parseNetstatPid(sample, 44100), 111);
  assert.equal(parseNetstatPid(sample, 14410), 222);
  assert.equal(parseNetstatPid(sample, 9999), null, "no listener → null (nothing killed)");
  // ESTABLISHED rows must not count as listeners even on the right port.
  assert.equal(parseNetstatPid("  TCP    10.0.0.1:4410   1.2.3.4:80   ESTABLISHED   777", 4410), null);
});

// --- F9: stop a stack this shell never spawned ------------------------
// A reused (survived-from-previous-session) backend answers health but the
// shell holds no handle; the drain gate must still be able to stop it via
// the health-port → pid lookup before an update swaps the .app under it.

test("stopExternalStack finds and kills a listener by its health port (F9)", async (t) => {
  if (process.platform !== "darwin" && process.platform !== "win32") {
    t.skip("needs a real win32 or darwin host (port→pid lookup uses lsof/netstat)");
    return;
  }
  // A real detached listener on an ephemeral port, like the survived stack.
  const child = spawn(
    process.execPath,
    ["-e", 'const s = require("net").createServer(); s.listen(0, "127.0.0.1", () => { process.stdout.write("PORT=" + s.address().port + "\\n"); setInterval(() => {}, 60000); });'],
    { detached: true, stdio: ["ignore", "pipe", "ignore"] },
  );
  const port = await new Promise<number>((resolve, reject) => {
    let buf = "";
    child.stdout!.on("data", (d: Buffer) => {
      buf += d.toString();
      const m = buf.match(/PORT=(\d+)/);
      if (m) resolve(parseInt(m[1], 10));
    });
    child.once("exit", (code) => reject(new Error(`listener exited early code=${code}`)));
    setTimeout(() => reject(new Error(`listener did not report its port (got: ${buf.trim()})`)), 5000);
  });
  assert.ok(port > 0, "listener must report a port");

  // Attach the exit listener BEFORE the kill: SIGKILL lands within
  // milliseconds, and a listener attached after the fact never fires.
  // POSIX signal deaths report exit code null — the exit EVENT firing is
  // the proof, not the code value.
  let exitSeen = false;
  const exited = new Promise<void>((resolve) => child.once("exit", () => { exitSeen = true; resolve(); }));
  const logs: string[] = [];
  await stopExternalStack(port, line => logs.push(line));
  await Promise.race([exited, new Promise<null>(r => setTimeout(() => r(null), 3000))]);
  assert.ok(exitSeen, "the external listener must be gone after stopExternalStack");
  assert.ok(logs.some(l => l.includes("killing stack tree")), "the kill went through killStackTree");
});
