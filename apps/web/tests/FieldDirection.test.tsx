// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createTest } from "../../../test/support/tagged/compat.mjs";
const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
import assert from "node:assert/strict";
import { createElement } from "react";
import { act, create, type ReactTestRenderer } from "react-test-renderer";
import type { ApiClient } from "../src/api.js";
import { FieldDirection } from "../src/evolve/FieldDirection.js";
import { LocaleProvider } from "../src/i18n/LocaleProvider.js";

(globalThis as typeof globalThis & { IS_REACT_ACT_ENVIRONMENT: boolean }).IS_REACT_ACT_ENVIRONMENT = true;

function pending() {
  let resolve!: (value: { hash: string; source: string }) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<{ hash: string; source: string }>((yes, no) => { resolve = yes; reject = no; });
  return { promise, resolve, reject };
}

for (const locale of ["en", "zh-CN"] as const) {
  const loading = locale === "en" ? "Loading fields…" : "正在加载字段…";
  const error = locale === "en" ? "Could not load the fields for this run." : "无法加载这次运行的字段。";
  const retry = locale === "en" ? "Retry" : "重试";
  const render = (client: ApiClient, runId = "run-a", codeHash: string | undefined = "hash-a") => (
    createElement(LocaleProvider, { initialLocale: locale, children:
      createElement(FieldDirection, { client, runId, codeHash, editable: ["新字段"] }),
    })
  );

  test(`FieldDirection ${locale}: failed load stays visible and retry recovers`, async () => {
    const first = pending(); const second = pending();
    let calls = 0;
    const client = { getEvolveCandidate: () => (++calls === 1 ? first.promise : second.promise) } as unknown as ApiClient;
    let view!: ReactTestRenderer;
    await act(async () => { view = create(render(client)); });
    try {
      assert.equal(view.root.findByProps({ role: "status" }).children.join(""), loading);
      await act(async () => first.reject(new Error("private backend details")));
      assert.equal(view.root.findByProps({ role: "alert" }).children.join(""), error);
      const button = view.root.findByType("button");
      assert.equal(button.children.join(""), retry);
      assert.doesNotMatch(JSON.stringify(view.toJSON()), /private backend/);
      await act(async () => button.props.onClick());
      assert.equal(calls, 2);
      assert.equal(view.root.findByProps({ role: "status" }).children.join(""), loading);
      assert.equal(view.root.findAllByType("button").length, 0);
      await act(async () => second.resolve({ hash: "hash-a", source: '{"新字段":"long scientific value","fixed":true}' }));
      assert.equal(view.root.findAllByType("table").length, 1);
      assert.deepEqual(view.root.findAllByType("input").map((input) => input.props.checked), [true, false]);
      assert.equal(view.root.findAllByProps({ role: "alert" }).length, 0);
    } finally { await act(async () => view.unmount()); }
  });

  for (const change of ["source", "run"] as const) {
    test(`FieldDirection ${locale}: ${change} change clears rows and ignores stale completion`, async () => {
      const requests: ReturnType<typeof pending>[] = [];
      const client = { getEvolveCandidate: () => { const request = pending(); requests.push(request); return request.promise; } } as unknown as ApiClient;
      let view!: ReactTestRenderer;
      const updated = (index: number) => render(client, change === "run" ? `run-${index}` : "run-a", change === "source" ? `hash-${index}` : "hash-a");
      await act(async () => { view = create(updated(0)); });
      try {
        await act(async () => requests[0]!.resolve({ hash: "initial", source: '{"old_field":1}' }));
        assert.match(JSON.stringify(view.toJSON()), /old_field/);
        await act(async () => view.update(updated(1)));
        assert.doesNotMatch(JSON.stringify(view.toJSON()), /old_field/);
        assert.equal(view.root.findByProps({ role: "status" }).children.join(""), loading);
        await act(async () => view.update(updated(2)));
        await act(async () => requests[2]!.resolve({ hash: "latest", source: '{"新字段":"latest"}' }));
        await act(async () => requests[1]!.resolve({ hash: "stale", source: '{"stale_field":9}' }));
        assert.match(JSON.stringify(view.toJSON()), /latest/);
        assert.doesNotMatch(JSON.stringify(view.toJSON()), /stale_field|old_field/);
        await act(async () => view.update(updated(3)));
        await act(async () => view.update(createElement(LocaleProvider, { initialLocale: locale, children: createElement(FieldDirection, { client, runId: "none", editable: [] }) })));
        await act(async () => requests[3]!.reject(new Error("stale failure")));
        assert.equal(view.toJSON(), null);
      } finally { await act(async () => view.unmount()); }
    });
  }
}
