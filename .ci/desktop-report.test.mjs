import assert from "node:assert/strict";
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { reconcileDesktopResults } from "./desktop-report.mjs";
import { summarizePlaywrightReport } from "./desktop-result.mjs";
import { createTest } from "../test/support/tagged/compat.mjs";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "os:windows", "os:macos", "arch:amd64", "arch:arm64"] });

function report(id, results = []) {
  return { suites: [{ specs: [{ id, file: "fixture.spec.ts", title: id, tests: [{ projectName: "desktop-chromium", results }] }] }] };
}

async function fixture(t, modes) {
  const root = await mkdtemp(join(tmpdir(), "desktop-report-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const plan = report("required");
  const actual = report("required", [{ status: "passed" }]);
  const write = (file, value) => writeFile(file, JSON.stringify(value));
  for (const mode of modes) {
    const dir = join(root, "desktop-runs", mode);
    await mkdir(dir, { recursive: true });
    await write(join(dir, "plan.json"), plan);
    await write(join(dir, "playwright-results.json"), actual);
    await write(join(root, `desktop-${mode}.json`), { mode, status: "passed", exitCode: 0, playwrightExitCode: 0, ...summarizePlaywrightReport(plan, actual) });
  }
  return root;
}

test("desktop evidence requires every selected mode to report a complete pass", async t => {
  const root = await fixture(t, ["ui-st"]);
  assert.deepEqual((await reconcileDesktopResults(root)).problems, ["mocked: desktop result summary is missing"]);
});

test("desktop reconciliation recomputes identity coverage from the collected plan and report", async t => {
  const root = await fixture(t, ["ui-st", "mocked"]);
  assert.deepEqual((await reconcileDesktopResults(root)).problems, []);
  const path = join(root, "desktop-runs", "ui-st", "playwright-results.json");
  await writeFile(path, JSON.stringify(report("foreign", [{ status: "passed" }])));
  const result = await reconcileDesktopResults(root);
  assert.ok(result.problems.includes("ui-st: reconciled result is FAIL"));
  assert.ok(result.problems.includes("ui-st: summary cases does not match raw evidence"));
  await rm(path);
  assert.ok((await reconcileDesktopResults(root)).problems.some(problem => problem.includes("missing or invalid Desktop execution evidence")));
});
