// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import { renderToStaticMarkup } from "react-dom/server";
import { ExecutionBlockCards, RunnerReadinessPanel } from "../src/ExecutionReadiness.js";
import { LocaleProvider } from "../src/i18n/index.js";
import type { ApiClient } from "../src/api/client.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

test("execution card reloads pending decisions and cancels only the clicked operation", async () => {
  const decisions: unknown[] = [];
  const client = { listExecutionBlocks: async () => [{ id: "block", runnerId: "local", reason: "missing", alternatives: [] }],
    decideExecutionBlock: async (...args: unknown[]) => { decisions.push(args); },
  } as unknown as ApiClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ExecutionBlockCards, { client, sessionId: "s" })); });
  try {
    assert.equal(renderer.root.findAllByType("section").length, 1);
    const buttons = renderer.root.findAllByType("button");
    await act(async () => { await buttons[buttons.length - 1]!.props.onClick(); });
    assert.deepEqual(decisions, [["s", "block", { action: "cancel" }]]);
    assert.equal(renderer.root.findAllByType("section").length, 0);
  } finally { await act(async () => renderer.unmount()); }
});

test("Runner settings refresh probes the selected Runner instead of the API host", async () => {
  const probes: unknown[] = [];
  const client = { getRunnerExecutionCapability: async (...args: unknown[]) => {
    probes.push(args); return { connected: true, capability: { ready: false, reason: "sandbox-unusable" } };
  } } as unknown as ApiClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(RunnerReadinessPanel, { client, runnerId: "lab" })); });
  try {
    await act(async () => renderer.root.findByType("button").props.onClick());
    assert.deepEqual(probes, [["lab", false], ["lab", true]]);
  } finally { await act(async () => renderer.unmount()); }
});

test("a reopened Runner settings card shows its last answer instead of an empty check", async () => {
  const client = { getRunnerExecutionCapability: async () => ({
    connected: true, capability: { ready: true, sandbox: "bubblewrap", checkedAt: "2026-10-30T00:00:00.000Z" },
  }) } as unknown as ApiClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(RunnerReadinessPanel, { client, runnerId: "cache-lab" })); });
  try {
    assert.match(JSON.stringify(renderer.toJSON()), /Connected; sandbox available/);
  } finally { await act(async () => renderer.unmount()); }
  // The reopening paints from the last answer; only the first visit waits.
  assert.match(
    renderToStaticMarkup(createElement(RunnerReadinessPanel, { client, runnerId: "cache-lab" })),
    /Connected; sandbox available/,
  );
});

test("MCP repair card shows source diagnostics and rechecks without a Runner switch", async () => {
  const decisions: unknown[] = [];
  const client = { listExecutionBlocks: async () => [{ id: "mcp-block", kind: "mcp", runnerId: "MCP", reason: "arxiv: unavailable; omitted tools: search", suggestions: ["Repair and reload the catalog"], alternatives: [] }],
    decideExecutionBlock: async (...args: unknown[]) => { decisions.push(args); },
  } as unknown as ApiClient;
  let renderer!: ReactTestRenderer;
  await act(async () => { renderer = create(createElement(ExecutionBlockCards, { client, sessionId: "s" })); });
  try {
    assert.match(JSON.stringify(renderer.toJSON()), /arxiv: unavailable/);
    assert.match(JSON.stringify(renderer.toJSON()), /Repair and reload the catalog/);
    const buttons = renderer.root.findAllByType("button");
    assert.equal(buttons.length, 2);
    await act(async () => { await buttons[0]!.props.onClick(); });
    assert.deepEqual(decisions, [["s", "mcp-block", { action: "retry" }]]);
  } finally { await act(async () => renderer.unmount()); }
});

for (const locale of ["en", "zh-CN"] as const) {
  for (const kind of [undefined, "mcp"] as const) {
    test(`repair card distinguishes ${kind ?? "runner"} consent from MCP recheck in ${locale}`, async () => {
      const client = {listExecutionBlocks: async () => [{id: "b", kind, runnerId: "target", reason: "offline", alternatives: []}]} as unknown as ApiClient;
      let view!: ReactTestRenderer;
      await act(async () => {view = create(createElement(LocaleProvider, {initialLocale: locale}, createElement(ExecutionBlockCards, {client, sessionId: "s"})));});
      try {
        const text = JSON.stringify(view.toJSON());
        assert.match(text, kind === "mcp" ? (locale === "en" ? /Waiting for MCP repair/ : /等待 MCP 修复/) : (locale === "en" ? /code has not executed/ : /代码尚未执行/));
        assert.match(text, kind === "mcp" ? (locale === "en" ? /does not grant permission/ : /此操作不授予权限/) : (locale === "en" ? /never executes code automatically/ : /不会自动执行代码/));
      } finally {await act(async () => view.unmount());}
    });
  }
}

test("a stalled repair-card read is aborted and polling recovers without restarting the run", async context => {
  context.mock.timers.enable({ apis: ["setTimeout"] });
  let calls = 0;
  let firstSignal: AbortSignal | undefined;
  const client = { listExecutionBlocks: async (_sessionId: string, signal?: AbortSignal) => {
    calls++;
    if (calls === 1) {
      firstSignal = signal;
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener("abort", () => reject(new Error("read timed out")), { once: true });
      });
    }
    return [{ id: "recovered-poll", kind: "mcp", runnerId: "MCP", reason: "selected source unavailable", alternatives: [] }];
  } } as unknown as ApiClient;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(ExecutionBlockCards, { client, sessionId: "s" })); });
  try {
    await act(async () => { context.mock.timers.tick(5_000); });
    assert.equal(firstSignal?.aborted, true);
    await act(async () => { context.mock.timers.tick(2_000); });
    assert.equal(calls, 2);
    assert.match(JSON.stringify(view.toJSON()), /Waiting for MCP repair/);
    assert.match(JSON.stringify(view.toJSON()), /selected source unavailable/);
  } finally { await act(async () => view.unmount()); }
  await act(async () => { context.mock.timers.tick(10_000); });
  assert.equal(calls, 2, "an unmounted card must not keep polling");
});

test("changing sessions aborts the old repair-card read", async () => {
  const signals: AbortSignal[] = [];
  const client = { listExecutionBlocks: async (_sessionId: string, signal?: AbortSignal) => {
    if (signal) signals.push(signal);
    return [];
  } } as unknown as ApiClient;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(ExecutionBlockCards, { client, sessionId: "old" })); });
  try {
    await act(async () => { view.update(createElement(ExecutionBlockCards, { client, sessionId: "new" })); });
    assert.equal(signals.length, 2);
    assert.equal(signals[0]?.aborted, true);
    assert.equal(signals[1]?.aborted, false);
  } finally { await act(async () => view.unmount()); }
  assert.equal(signals[1]?.aborted, true);
});

test("switching sessions cancels the old read and ignores its late result", async () => {
  let resolveOld!: (value: unknown[]) => void;
  const signals: AbortSignal[] = [];
  const client = { listExecutionBlocks: async (session: string, signal: AbortSignal) => {
    signals.push(signal);
    if (session === "old") return new Promise(resolve => { resolveOld = resolve; });
    return [{ id: "new", kind: "mcp", runnerId: "MCP", reason: "current session", alternatives: [] }];
  } } as unknown as ApiClient;
  let view!: ReactTestRenderer;
  await act(async () => { view = create(createElement(ExecutionBlockCards, { client, sessionId: "old" })); });
  try {
    await act(async () => view.update(createElement(ExecutionBlockCards, { client, sessionId: "new" })));
    assert.equal(signals[0]!.aborted, true);
    await act(async () => resolveOld([{ id: "old", runnerId: "local", reason: "obsolete", alternatives: [] }]));
    assert.match(JSON.stringify(view.toJSON()), /current session/);
    assert.doesNotMatch(JSON.stringify(view.toJSON()), /obsolete/);
  } finally { await act(async () => view.unmount()); }
});
