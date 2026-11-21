export function desktopReportTests(report) {
  if (!Array.isArray(report?.suites)) throw new Error("Invalid Playwright report: missing suites");
  const tests = new Map();
  const visit = (suite) => {
    for (const spec of suite.specs ?? []) {
      for (const test of spec.tests ?? []) {
        if (!spec.id || !test.projectName) throw new Error("Playwright report is missing a test identity");
        const key = JSON.stringify([test.projectName, spec.id]);
        if (tests.has(key)) throw new Error(`Duplicate Playwright identity: ${key}`);
        tests.set(key, { source: spec.file, title: spec.title, test });
      }
    }
    for (const child of suite.suites ?? []) visit(child);
  };
  for (const suite of report.suites) visit(suite);
  return tests;
}

export function summarizePlaywrightReport(plan, report) {
  const selected = desktopReportTests(plan);
  const actual = report ? desktopReportTests(report) : new Map();
  const problems = [];
  if (selected.size === 0) problems.push("No Desktop tests selected");
  if ((plan.errors ?? []).length) problems.push("Playwright collection reported errors");
  if ((report?.errors ?? []).length) problems.push("Playwright execution reported errors");
  for (const key of actual.keys()) {
    if (!selected.has(key)) problems.push(`Unplanned Desktop identity: ${key}`);
  }
  const cases = [...selected].map(([key, { source, title }]) => {
    const test = actual.get(key)?.test;
    const attempt = test?.results?.at(-1);
    const statuses = { passed: "PASS", failed: "FAIL", timedOut: "FAIL", interrupted: "FAIL", skipped: "SKIPPED" };
    const status = attempt ? statuses[attempt.status] : test?.expectedStatus === "skipped" ? "SKIPPED" : undefined;
    const skipReason = status === "SKIPPED" ? (attempt?.annotations ?? test?.annotations ?? []).find(
      ({ type }) => type === "BLOCKED" || type === "CAPABILITY_NOT_PRESENT",
    ) : undefined;
    const outcome = status === "PASS" && test.expectedStatus && test.expectedStatus !== "passed" ? "FAIL" : skipReason?.type ?? status ?? "NOT_RUN";
    return { key, source, title, outcome, attempts: test?.results?.length ?? 0, ...(skipReason ? { reason: skipReason.description } : {}) };
  });
  const count = (outcome) => cases.filter((test) => test.outcome === outcome).length;
  const passed = count("PASS");
  const failed = count("FAIL");
  const skipped = count("SKIPPED");
  const notRun = count("NOT_RUN");
  const blocked = count("BLOCKED");
  const capabilityNotPresent = count("CAPABILITY_NOT_PRESENT");
  let result = "PASS";
  if (problems.length || failed) result = "FAIL";
  else if (notRun) result = "NOT_EXECUTED";
  else if (blocked) result = "BLOCKED";
  else if (skipped) result = "SKIPPED";
  else if (capabilityNotPresent) result = "CAPABILITY_NOT_PRESENT";
  return {
    planned: selected.size,
    collected: actual.size,
    executed: passed + failed,
    passed, failed, skipped, blocked, capability_not_present: capabilityNotPresent, not_run: notRun, result, cases, problems,
  };
}
