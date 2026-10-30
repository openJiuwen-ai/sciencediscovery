import test from "node:test";
import assert from "node:assert/strict";
import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  effectiveDataDir, loadWizardState, needsWizard, pidAlive, saveWizardState, wizardStateFile,
} from "../src/wizard-state.ts";

function tmpUserData(): string {
  return mkdtempSync(join(tmpdir(), "sd-wizard-state-"));
}

test("state file lives under userData", () => {
  assert.ok(wizardStateFile("C:\\ud").replace(/\\/g, "/").endsWith("ud/wizard-state.json"));
});

test("missing / corrupt / invalid state files load as null", () => {
  const ud = tmpUserData();
  assert.equal(loadWizardState(ud), null);
  writeFileSync(wizardStateFile(ud), "{not json", "utf8");
  assert.equal(loadWizardState(ud), null);
  writeFileSync(wizardStateFile(ud), JSON.stringify({ step: "nonsense" }), "utf8");
  assert.equal(loadWizardState(ud), null);
  rmSync(ud, { recursive: true, force: true });
});

test("data-dir step loads without a dataDir; later steps require one", () => {
  const ud = tmpUserData();
  writeFileSync(wizardStateFile(ud), JSON.stringify({ step: "data-dir" }), "utf8");
  assert.deepEqual(loadWizardState(ud), { step: "data-dir" });

  writeFileSync(wizardStateFile(ud), JSON.stringify({ step: "starting" }), "utf8");
  assert.equal(loadWizardState(ud), null, "starting step without dataDir restarts the wizard");

  writeFileSync(wizardStateFile(ud), JSON.stringify({ step: "done" }), "utf8");
  assert.equal(loadWizardState(ud), null, "done step without dataDir restarts the wizard");
  rmSync(ud, { recursive: true, force: true });
});

test("'model' step is valid and resumable", () => {
  const ud = tmpUserData();
  writeFileSync(wizardStateFile(ud), JSON.stringify({
    step: "model", dataDir: "E:\\sd", stackPid: 4242, epoch: 3,
  }), "utf8");
  assert.deepEqual(loadWizardState(ud), { step: "model", dataDir: "E:\\sd", stackPid: 4242, epoch: 3 });

  writeFileSync(wizardStateFile(ud), JSON.stringify({ step: "model" }), "utf8");
  assert.equal(loadWizardState(ud), null, "model step without dataDir still restarts");
  rmSync(ud, { recursive: true, force: true });
});

test("valid starting/done states load with optional pid/epoch fields", () => {
  const ud = tmpUserData();
  writeFileSync(wizardStateFile(ud), JSON.stringify({
    step: "starting", dataDir: "E:\\sd", stackPid: 4242, epoch: 3,
  }), "utf8");
  assert.deepEqual(loadWizardState(ud), { step: "starting", dataDir: "E:\\sd", stackPid: 4242, epoch: 3 });

  writeFileSync(wizardStateFile(ud), JSON.stringify({
    step: "done", dataDir: "E:\\sd", completedAt: "2026-10-15T00:00:00Z", stackPid: -1, epoch: "x",
  }), "utf8");
  assert.deepEqual(loadWizardState(ud), {
    step: "done", dataDir: "E:\\sd", completedAt: "2026-10-15T00:00:00Z",
  }, "junk pid/epoch values are dropped");
  rmSync(ud, { recursive: true, force: true });
});

test("save + load roundtrip", () => {
  const ud = tmpUserData();
  saveWizardState(ud, { step: "starting", dataDir: "D:\\data", stackPid: 100, epoch: 2 });
  assert.deepEqual(loadWizardState(ud), { step: "starting", dataDir: "D:\\data", stackPid: 100, epoch: 2 });
  rmSync(ud, { recursive: true, force: true });
});

test("saving a state with a dataDir mirrors it into data-dir.txt (NSIS uninstaller reads it)", () => {
  const ud = tmpUserData();
  saveWizardState(ud, { step: "done", dataDir: "E:\\用户数据" });
  assert.equal(readFileSync(join(ud, "data-dir.txt"), "utf8"), "E:\\用户数据\n");

  // No dataDir → no mirror (and a stale one from an earlier choice stays put).
  saveWizardState(ud, { step: "data-dir" });
  assert.equal(existsSync(join(ud, "data-dir.txt")), true);
  rmSync(ud, { recursive: true, force: true });
});

test("needsWizard: only a done state skips the wizard", () => {
  assert.equal(needsWizard(null), true);
  assert.equal(needsWizard({ step: "data-dir" }), true);
  assert.equal(needsWizard({ step: "starting", dataDir: "D:\\d" }), true);
  assert.equal(needsWizard({ step: "done", dataDir: "D:\\d" }), false);
});

test("effectiveDataDir: wizard choice wins over env, else env, else null", () => {
  assert.equal(effectiveDataDir({ SCIENCE_DISCOVERY_DATA_DIR: "E:\\env" }, { dataDir: "E:\\wizard" }), "E:\\wizard");
  assert.equal(effectiveDataDir({ SCIENCE_DISCOVERY_DATA_DIR: "E:\\env" }, null), "E:\\env");
  assert.equal(effectiveDataDir({}, null), null);
  assert.equal(effectiveDataDir({}, { step: "data-dir" }), null);
});

test("pidAlive: undefined / dead pids are false, our own pid is true", () => {
  assert.equal(pidAlive(undefined), false);
  assert.equal(pidAlive(-1), false);
  assert.equal(pidAlive(999_999_999), false);
  assert.equal(pidAlive(process.pid), true);
});
