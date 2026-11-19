import assert from "node:assert/strict";
import { createTest } from "../test/support/tagged/compat.mjs";
import { summarizePlaywrightReport } from "./desktop-result.mjs";

const { test } = createTest(import.meta.url, {
  tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"],
});

const row = (id, ...statuses) => ({
  id, file: "sample.spec.ts", title: id,
  tests: [{ projectName: "desktop-chromium", expectedStatus: "passed", results: statuses.map(status => ({ status })) }],
});
const report = (...specs) => ({ suites: [{ suites: [{ specs }] }] });

test("desktop accounting uses the final retry and separates skipped and missing identities", () => {
  const result = summarizePlaywrightReport(report(row("retry"), row("skip"), row("missing")), report(row("retry", "failed", "passed"), row("skip", "skipped")));
  assert.equal(result.planned, 3);
  assert.equal(result.collected, 2);
  assert.equal(result.executed, 1);
  assert.equal(result.passed, 1);
  assert.equal(result.skipped, 1);
  assert.equal(result.not_run, 1);
  assert.equal(result.result, "NOT_EXECUTED");
  assert.deepEqual(result.cases.map(({ outcome, attempts }) => [outcome, attempts]), [["PASS", 2], ["SKIPPED", 1], ["NOT_RUN", 0]]);
});

test("desktop accounting rejects equal counts with a different identity and duplicate identities", () => {
  const plan = report(row("required"));
  const result = summarizePlaywrightReport(plan, report(row("unplanned", "passed")));
  assert.equal(result.result, "FAIL");
  assert.equal(result.planned, result.collected);
  assert.equal(result.not_run, 1);
  assert.match(result.problems[0], /Unplanned Desktop identity/);
  assert.throws(() => summarizePlaywrightReport(plan, report(row("required", "passed"), row("required", "passed"))), /Duplicate Playwright identity/);
});

test("desktop accounting cannot pass without fresh execution evidence", () => {
  const plan = report(row("required"));
  assert.equal(summarizePlaywrightReport(report(), report()).result, "FAIL");
  assert.equal(summarizePlaywrightReport(plan).result, "NOT_EXECUTED");
  const result = summarizePlaywrightReport(plan, report(row("required", "failed", "timedOut")));
  assert.equal(result.result, "FAIL");
  assert.equal(result.failed, 1);
  assert.equal(result.executed, 1);
});

test("desktop accounting records blocked prerequisites and absent optional capabilities separately", () => {
  const blocked = row("stack", "skipped");
  blocked.tests[0].results[0].annotations = [{ type: "BLOCKED", description: "Runner unavailable" }];
  const optional = row("remote", "skipped");
  optional.tests[0].results[0].annotations = [{ type: "CAPABILITY_NOT_PRESENT", description: "No remote Runner" }];
  const result = summarizePlaywrightReport(report(row("stack"), row("remote")), report(blocked, optional));
  assert.equal(result.result, "BLOCKED");
  assert.equal(result.blocked, 1);
  assert.equal(result.capability_not_present, 1);
  assert.equal(result.skipped, 0);
  assert.equal(result.executed, 0);
  assert.equal(result.cases[0].reason, "Runner unavailable");
  assert.equal(summarizePlaywrightReport(report(row("remote")), report(optional)).result, "CAPABILITY_NOT_PRESENT");
});
