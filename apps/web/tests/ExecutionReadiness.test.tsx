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
