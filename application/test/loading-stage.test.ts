// Unit tests for the loading-stage line parser.
import assert from "node:assert/strict";
import { test } from "node:test";

import {
  FIRST_RUN_STAGES, provisioningLineToStage, STAGE_ESTIMATE_SEC, STAGE_SEQUENCE, STAGE_TEXTS, stackLineToStage,
  stageProgress,
} from "../src/loading-stage.ts";

test("maps start-stack say() lines (with the [stack:err] prefix) to stages", () => {
  assert.deepEqual(stackLineToStage("[stack:err] Starting the sandbox runner daemon..."), {
    stage: "runner", text: STAGE_TEXTS.runner,
  });
  assert.deepEqual(stackLineToStage("[stack:err] Starting the memory-graph service..."), {
    stage: "memory-graph", text: STAGE_TEXTS["memory-graph"],
  });
  assert.deepEqual(stackLineToStage("[stack:err] Starting the evolve service..."), {
    stage: "evolve", text: STAGE_TEXTS.evolve,
  });
  assert.deepEqual(stackLineToStage(
    "[stack:err] JiuwenSwarm is not running; starting it (node scripts/jiuwenswarm.mjs start)...",
  ), { stage: "jiuwenswarm", text: STAGE_TEXTS.jiuwenswarm });
  // Lazy background start uses the same stage but wording makes it
  // clear the main UI is no longer blocked on JiuwenSwarm.
  assert.match(STAGE_TEXTS.jiuwenswarm, /后台/);
  assert.deepEqual(stackLineToStage("[stack:err] Starting the adapter on port 4310 (legacy API on 4410)..."), {
    stage: "adapter", text: STAGE_TEXTS.adapter,
  });
  assert.deepEqual(stackLineToStage("[stack:err] Starting the control API..."), {
    stage: "api", text: STAGE_TEXTS.api,
  });
});

test("maps bootstrap first-run provisioning to the unpack stage", () => {
  assert.deepEqual(
    stackLineToStage("[sd-shell] first run: unpacking bundled Python environments into E:\\data\\envs"),
    { stage: "unpack", text: STAGE_TEXTS.unpack },
  );
  assert.deepEqual(
    stackLineToStage("[sd-shell] first run: precompiled bytecode for gateway venv (12s)"),
    { stage: "precompile", text: STAGE_TEXTS.precompile },
  );
});

test("maps the jiuwenswarm wait-loop heartbeat to live stage text", () => {
  // Contract with scripts/jiuwenswarm.mjs's probe-loop progress line:
  // emitted every 15s while waiting for the gateway, so a cold/hung start
  // shows elapsed seconds instead of a frozen step 8/10.
  assert.deepEqual(
    stackLineToStage("[stack:err] JiuwenSwarm: still starting (45s elapsed, probe #23)..."),
    { stage: "jiuwenswarm", text: "智能体集群启动中… 已等 45s（第 23 次探测），组件较大属正常" },
  );
  assert.equal(stackLineToStage("JiuwenSwarm: still starting (0s elapsed, probe #1)...").stage, "jiuwenswarm");
});

test("maps the jiuwenswarm pre-loop phase heartbeats (field gap 2026-10-17: step 8/10 frozen with no probe count)", () => {
  // Contract with scripts/jiuwenswarm.mjs's pre-check / patch-verify lines:
  // these steps run BEFORE the probe loop and can take minutes on a cold
  // machine — without mapped text the loading page looks frozen at 8/10.
  assert.equal(
    stackLineToStage("[stack:err] JiuwenSwarm: pre-checking instance status (cold machine: this can take a few minutes)...")?.stage,
    "jiuwenswarm",
  );
  assert.match(
    String(stackLineToStage("JiuwenSwarm: pre-checking instance status (cold machine: this can take a few minutes)...")?.text),
    /预检实例状态/,
  );
  assert.match(
    String(stackLineToStage("JiuwenSwarm: verifying compatibility patches (cold machine: this can take a few minutes)...")?.text),
    /校验兼容补丁/,
  );
});

test("maps the init/applyConfig heartbeats (last pre-loop silence, acid test 2026-10-17)", () => {
  // Contract with scripts/jiuwenswarm.mjs: init and applyConfig were the last
  // steps before the probe loop with zero output — a failure there froze the
  // wizard's step 8 for the whole budget with no feedback.
  const init = stackLineToStage(
    '[stack:err] JiuwenSwarm: initializing instance workspace "sciencediscovery" (cold machine: this can take a few minutes)...',
  );
  assert.equal(init?.stage, "jiuwenswarm");
  assert.match(String(init?.text), /初始化实例/);
  const cfg = stackLineToStage("[stack:err] JiuwenSwarm: applying instance config...");
  assert.equal(cfg?.stage, "jiuwenswarm");
  assert.match(String(cfg?.text), /写入实例配置/);
});

test("non-stage lines return null (service logs, warnings, later first-run lines)", () => {
  assert.equal(stackLineToStage("[stack] INFO [api] event=service_started"), null);
  assert.equal(stackLineToStage("[stack:err] WARNING: local compute is unavailable"), null);
  assert.equal(stackLineToStage("[sd-shell] first run: bundled environments ready"), null);
  assert.equal(stackLineToStage("[sd-shell] first run: pointed _editable_impl at the bundled backend"), null);
  assert.equal(stackLineToStage(""), null);
});

test("every mapped stage has user-facing text", () => {
  for (const stage of ["connect", "unpack", "precompile", "stack", "runner", "memory-graph", "evolve", "jiuwenswarm", "adapter", "api"]) {
    assert.ok(STAGE_TEXTS[stage], `missing text for stage ${stage}`);
    assert.ok(STAGE_TEXTS[stage].length > 0);
  }
});

test("the daily and first-run sequences list every stage exactly once", () => {
  assert.equal(new Set(STAGE_SEQUENCE).size, STAGE_SEQUENCE.length);
  assert.equal(new Set([...FIRST_RUN_STAGES, ...STAGE_SEQUENCE]).size, FIRST_RUN_STAGES.length + STAGE_SEQUENCE.length);
  for (const stage of STAGE_SEQUENCE) assert.ok(STAGE_TEXTS[stage]);
  for (const stage of FIRST_RUN_STAGES) assert.ok(STAGE_TEXTS[stage]);
});

test("stageProgress: daily run — 9 steps, 1-based, shrinking estimate", () => {
  // Re-calibrated against field timing: warm boot ≈ 55s end-to-end.
  assert.deepEqual(stageProgress("connect", false), { current: 1, total: 9, estimateSec: 51 });
  const api = stageProgress("api", false);
  assert.equal(api.current, 8);
  assert.equal(api.total, 9);
  // "api" is no longer the final stage; "agent" follows it.
  assert.ok(api.estimateSec > 0 && api.estimateSec <= STAGE_ESTIMATE_SEC.api + STAGE_ESTIMATE_SEC.agent);
});

test("stageProgress: first run — provisioning prepended, 10 steps (precompile moved to build time)", () => {
  const totalFirstRun = 80 + 51; // unpack + the daily sequence
  assert.deepEqual(stageProgress("unpack", true), { current: 1, total: 10, estimateSec: totalFirstRun });
  assert.deepEqual(stageProgress("connect", true), { current: 2, total: 10, estimateSec: totalFirstRun - 80 });
  assert.equal(stageProgress("api", true).total, 10);
});

test("stageProgress: unknown stage reports current 0 and no estimate", () => {
  assert.deepEqual(stageProgress("nope", false), { current: 0, total: 9, estimateSec: 0 });
  assert.deepEqual(stageProgress("nope", true), { current: 0, total: 10, estimateSec: 0 });
});

// --- Provisioning sub-progress lines → live stage text -----------------

test("provisioningLineToStage surfaces unpack percentage as live text", () => {
  assert.deepEqual(
    provisioningLineToStage("[sd-shell] first run: unpack 40% (15230/38075 files)"),
    { stage: "unpack", text: "正在解包运行环境… 40%（15230/38075 个文件）" },
  );
  assert.deepEqual(
    provisioningLineToStage("[sd-shell] first run: unpack complete"),
    { stage: "unpack", text: "运行环境解包完成" },
  );
});

test("provisioningLineToStage surfaces per-target precompile results", () => {
  assert.deepEqual(
    provisioningLineToStage("[sd-shell] first run: precompiled bytecode for gateway venv (12s)"),
    { stage: "precompile", text: "字节码预热完成：gateway venv（12s）" },
  );
});

test("provisioningLineToStage ignores everything else", () => {
  assert.equal(provisioningLineToStage("[sd-shell] first run: unpacking bundled Python environments into E:\\data\\envs"), null);
  assert.equal(provisioningLineToStage("[sd-shell] first run: bundled environments ready"), null);
  assert.equal(provisioningLineToStage("[sd-shell] first run: warning — bytecode precompile failed for gateway venv: boom"), null);
  assert.equal(provisioningLineToStage("[stack:err] Starting the control API..."), null);
  assert.equal(provisioningLineToStage(""), null);
});

test("provisioningLineToStage surfaces partial precompile results as progress, not failure", () => {
  // compileall exit 1 on the 260-char path limit is a partial success.
  assert.deepEqual(
    provisioningLineToStage(
      "[sd-shell] first run: precompile partially done for jw venv (45s; skipped files compile lazily on first launch — normal on Windows)",
    ),
    { stage: "precompile", text: "字节码预热部分完成：jw venv（45s，其余首启时自动编译）" },
  );
});
