import test from "node:test";
import assert from "node:assert/strict";
import {
  interpretSeatbeltProbe,
  runSeatbeltProbe,
  SEATBELT_PROBE_PROFILE,
  SEATBELT_PROBE_TARGET,
  type ProbeSpawn,
} from "../src/sandbox-probe.ts";

// --- pure decision ------------------------------------------------------------

test("win32/linux short-circuit to not-applicable without spawning", () => {
  for (const platform of ["win32", "linux"] as const) {
    const verdict = interpretSeatbeltProbe({ code: 0, signal: null }, platform);
    assert.equal(verdict.kind, "not-applicable");
    assert.equal(verdict.platform, platform);
  }
});

test("darwin: exit 0 = ok (profile compiled, target ran)", () => {
  const verdict = interpretSeatbeltProbe({ code: 0, signal: null }, "darwin");
  assert.equal(verdict.kind, "ok");
});

test("darwin: nonzero exit = failed with MDM/virtualization copy + diagnostics", () => {
  const verdict = interpretSeatbeltProbe({ code: 71, signal: null }, "darwin");
  assert.equal(verdict.kind, "failed");
  if (verdict.kind === "failed") {
    assert.ok(verdict.reason.includes("71"), verdict.reason);
    assert.ok(verdict.reason.includes("沙箱"), verdict.reason);
    assert.ok(verdict.diagnostics.length >= 2);
    assert.ok(verdict.diagnostics.some(d => d.includes("sandbox-exec")));
    assert.ok(verdict.diagnostics.some(d => d.includes("profiles")));
    // Review follow-up: machine-readable shape the error page keys its EN
    // reason line off — not a translation of the zh string.
    assert.equal(verdict.detail.failCode, "exit-code");
    assert.equal(verdict.detail.exitCode, 71);
  }
});

test("darwin: signal kill = failed (POSIX semantics: code null, signal set)", () => {
  const verdict = interpretSeatbeltProbe({ code: null, signal: "SIGKILL" }, "darwin");
  assert.equal(verdict.kind, "failed");
  if (verdict.kind === "failed") {
    assert.ok(verdict.reason.includes("SIGKILL"), verdict.reason);
    assert.equal(verdict.detail.failCode, "signal");
    assert.equal(verdict.detail.signal, "SIGKILL");
  }
});

test("darwin: spawn error (no sandbox-exec) = failed with existence-check diagnostic", () => {
  const verdict = interpretSeatbeltProbe(
    { code: null, signal: null, spawnError: "spawn sandbox-exec ENOENT" },
    "darwin",
  );
  assert.equal(verdict.kind, "failed");
  if (verdict.kind === "failed") {
    assert.ok(verdict.reason.includes("找不到"), verdict.reason);
    assert.ok(verdict.diagnostics.some(d => d.includes("/usr/bin/sandbox-exec")));
    assert.equal(verdict.detail.failCode, "spawn-error");
    assert.equal(verdict.detail.spawnError, "spawn sandbox-exec ENOENT");
  }
});

test("probe contract: minimal profile, /usr/bin/true target", () => {
  assert.equal(SEATBELT_PROBE_PROFILE, "(version 1)(allow default)");
  assert.equal(SEATBELT_PROBE_TARGET, "/usr/bin/true");
});

// --- thin IO ------------------------------------------------------------------
// Fakes only: the agent sandbox denies sandbox-exec (exit 71 — the same
// restricted-environment class B1-3 hit with process-group signals), so a
// REAL spawn here would fake a "failed" verdict on every dev machine.

function fakeSpawn(events: {
  error?: NodeJS.ErrnoException;
  close?: [number | null, NodeJS.Signals | null];
  throwSync?: Error;
}): ProbeSpawn {
  return (_cmd: string, _args: string[]) => ({
    on(event: string, cb: (...a: unknown[]) => void) {
      // Queue microtask so the promise's finish() runs after runSeatbeltProbe
      // has wired both listeners (mirrors real async event order).
      if (event === "error" && events.error) {
        queueMicrotask(() => cb(events.error));
      } else if (event === "close" && events.close) {
        queueMicrotask(() => cb(events.close![0], events.close![1]));
      }
      return this as never;
    },
  }) as never;
}

test("runSeatbeltProbe: darwin + exit 0 → ok", async () => {
  const verdict = await runSeatbeltProbe("darwin", fakeSpawn({ close: [0, null] }));
  assert.equal(verdict.kind, "ok");
});

test("runSeatbeltProbe: darwin + exit 71 → failed with code in reason", async () => {
  const verdict = await runSeatbeltProbe("darwin", fakeSpawn({ close: [71, null] }));
  assert.equal(verdict.kind, "failed");
  if (verdict.kind === "failed") assert.ok(verdict.reason.includes("71"));
});

test("runSeatbeltProbe: darwin + spawn ENOENT → failed (never ok on missing binary)", async () => {
  const verdict = await runSeatbeltProbe(
    "darwin",
    fakeSpawn({ error: Object.assign(new Error("spawn sandbox-exec ENOENT"), { code: "ENOENT" }) }),
  );
  assert.equal(verdict.kind, "failed");
});

test("runSeatbeltProbe: darwin + sync throw → failed, not a crash", async () => {
  const thrower: ProbeSpawn = () => {
    throw new Error("no child_process");
  };
  const verdict = await runSeatbeltProbe("darwin", thrower);
  assert.equal(verdict.kind, "failed");
});

test("runSeatbeltProbe: win32 never spawns (contract: no sandbox-exec call off darwin)", async () => {
  let spawned = false;
  const guard: ProbeSpawn = (_cmd: string, _args: string[]) => {
    spawned = true;
    return fakeSpawn({ close: [0, null] })("", []);
  };
  const verdict = await runSeatbeltProbe("win32", guard);
  assert.equal(verdict.kind, "not-applicable");
  assert.equal(spawned, false, "win32 must short-circuit before spawning");
});

test("runSeatbeltProbe: only one event settles the promise (no double resolve)", async () => {
  // error AND close both fire (can happen with some spawn failures); the
  // settled flag must keep the verdict stable — first event wins.
  const both: ProbeSpawn = (_cmd: string, _args: string[]) => ({
    on(event: string, cb: (...a: unknown[]) => void) {
      if (event === "error") queueMicrotask(() => cb(new Error("ENOENT")));
      if (event === "close") queueMicrotask(() => queueMicrotask(() => cb(0, null)));
      return this as never;
    },
  }) as never;
  const verdict = await runSeatbeltProbe("darwin", both);
  assert.equal(verdict.kind, "failed", "error arrived first and must win");
});

// --- F12: the probe must never hang the startup gate -------------------------

test("runSeatbeltProbe (F12): a wedged probe times out to a fail-closed SIGKILL verdict", async () => {
  // Neither close nor error ever fires — the wedged-sandbox-exec shape.
  const wedged: ProbeSpawn = (_cmd: string, _args: string[]) => ({
    on() { return this as never; },
    kill(sig?: NodeJS.Signals) { killedSig = sig ?? null; return true; },
  }) as never;
  let killedSig: NodeJS.Signals | null = null;
  // Injected timer: fire immediately, assert the timeout path.
  const verdict = await runSeatbeltProbe(
    "darwin",
    wedged,
    10_000,
    (fn: () => void) => { queueMicrotask(fn); return 1 as unknown as ReturnType<typeof setTimeout>; },
    () => {},
  );
  assert.equal(verdict.kind, "failed", "a wedged probe must never pass or hang");
  if (verdict.kind === "failed") {
    assert.equal(verdict.detail.failCode, "signal");
    assert.equal(verdict.detail.signal, "SIGKILL");
  }
  assert.equal(killedSig, "SIGKILL", "the wedged child must also be killed");
});

test("runSeatbeltProbe (F12): the timeout never races a healthy probe", async () => {
  // close fires before the timeout — the verdict is the child's own.
  const verdict = await runSeatbeltProbe(
    "darwin",
    fakeSpawn({ close: [0, null] }),
    10_000,
    (fn: () => void) => { setTimeout(fn, 60_000); return 1 as unknown as ReturnType<typeof setTimeout>; },
    () => {},
  );
  assert.equal(verdict.kind, "ok", "exit 0 wins even with a timeout armed");
});

test("runSeatbeltProbe (F12): timeout=0 disables the ceiling (backward compat)", async () => {
  const wedged: ProbeSpawn = (_cmd: string, _args: string[]) => ({
    on() { return this as never; },
  }) as never;
  // Must NOT resolve from the timer; the win32 short-circuit and the
  // event paths are the only exits. We cannot await a never-resolving
  // promise — pin the contract by racing a short delay against it.
  const verdict = await Promise.race([
    runSeatbeltProbe("darwin", wedged, 0),
    new Promise<"still-pending">(r => setTimeout(() => r("still-pending"), 150)),
  ]);
  assert.equal(verdict, "still-pending", "timeout=0 must leave the promise pending");
});

// --- [U5c] The startup-gate section is retired ---------------------------------
//
// seatbeltGateDecision / seatbeltErrorPageQuery (and the fail-closed error
// page they served) were removed with the gate: a failed probe blocks
// nothing — the session records the failure, the stack spawns direct, and
// 设置 › 连接 › 沙箱网络's status row is where it is shown (owner decision 2026-11-23).
// The probe itself (runSeatbeltProbe + interpretSeatbeltProbe) keeps its
// coverage above.
