import test from "node:test";
import assert from "node:assert/strict";
import {
  ERR_CONNECTION_REFUSED,
  shouldRetryUiLoad,
  UI_LOAD_RETRY_LIMIT,
  uiLoadRetryDelayMs,
  waitForUiOrigin,
} from "../src/ui-retry.ts";

const UI = "http://127.0.0.1:4310";

// First-run race: control API healthy at 4410 while the
// 4310 adapter had not bound yet; loadURL died with ERR_CONNECTION_REFUSED and
// the window sat dead until a manual reload.

test("retries main-frame connection refusals of the current ui origin (token fragment included)", () => {
  assert.equal(shouldRetryUiLoad(ERR_CONNECTION_REFUSED, `${UI}/#token=abc`, true, UI), true);
});

test("ignores sub-frame failures, other error codes, and non-ui URLs (wizard/loading/fallback are file://)", () => {
  assert.equal(shouldRetryUiLoad(ERR_CONNECTION_REFUSED, `${UI}/#token=abc`, false, UI), false); // sub-frame
  assert.equal(shouldRetryUiLoad(-118, `${UI}/#token=abc`, true, UI), false); // ERR_CONNECTION_TIMED_OUT: out of scope
  assert.equal(shouldRetryUiLoad(-3, `${UI}/#token=abc`, true, UI), false); // ERR_ABORTED: navigations, not refusals
  assert.equal(shouldRetryUiLoad(ERR_CONNECTION_REFUSED, "file:///C:/app/dist/wizard.html", true, UI), false);
  assert.equal(shouldRetryUiLoad(ERR_CONNECTION_REFUSED, "http://127.0.0.1:14310/#x", true, UI), false); // sibling port must not prefix-match
  assert.equal(shouldRetryUiLoad(ERR_CONNECTION_REFUSED, `${UI}/`, true, "http://127.0.0.1:9999"), false); // different current origin
});

test("backoff: 1s for the first two retries then 2s; 20 retries ≈ 38s budget vs the adapter's ~10s bind", () => {
  assert.equal(uiLoadRetryDelayMs(1), 1000);
  assert.equal(uiLoadRetryDelayMs(2), 1000);
  assert.equal(uiLoadRetryDelayMs(3), 2000);
  assert.equal(uiLoadRetryDelayMs(UI_LOAD_RETRY_LIMIT), 2000);
  assert.equal(UI_LOAD_RETRY_LIMIT, 20);
});

// Follow-up: probe the ui origin itself before loadURL so the
// loading page holds the frame until the SPA is actually loadable — no blank
// gap between wizard step 2 and the model step. Injectable clock/fetch keep
// the poll/retry/timeout semantics testable with zero wall-clock waits.

function fakeClock() {
  let t = 1_000_000;
  return {
    now: () => t,
    advance: (ms: number) => { t += ms; },
  };
}

test("waitForUiOrigin: an answering listener resolves true immediately (any status counts)", async () => {
  const clock = fakeClock();
  const calls: string[] = [];
  const ok = await waitForUiOrigin(
    UI,
    30_000,
    async (input: RequestInfo | URL) => {
      calls.push(String(input));
      return new Response("spa index", { status: 200 });
    },
    async () => {},
    clock.now,
  );
  assert.equal(ok, true);
  assert.deepEqual(calls, [`${UI}/`]);
});

test("waitForUiOrigin: keeps polling refusals until the adapter binds (sleep advances the clock)", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const sleeps: number[] = [];
  const ok = await waitForUiOrigin(
    UI,
    30_000,
    async () => {
      attempts += 1;
      if (attempts < 3) throw new TypeError("fetch failed"); // ECONNREFUSED
      return new Response("spa index", { status: 404 }); // any answer = bound
    },
    async (ms: number) => { sleeps.push(ms); clock.advance(ms); },
    clock.now,
  );
  assert.equal(ok, true);
  assert.equal(attempts, 3);
  assert.deepEqual(sleeps, [350, 350]);
});

test("waitForUiOrigin: gives up after the budget and reports false (caller loads anyway; retry loop backstops)", async () => {
  const clock = fakeClock();
  let attempts = 0;
  const ok = await waitForUiOrigin(
    UI,
    30_000,
    async () => {
      attempts += 1;
      throw new TypeError("fetch failed");
    },
    async (ms: number) => { clock.advance(ms); },
    clock.now,
  );
  assert.equal(ok, false);
  // deadline is checked BEFORE sleeping, so the last sleep may push past it
  assert.ok(attempts >= Math.floor(30_000 / 350), `attempts=${attempts}`);
});
