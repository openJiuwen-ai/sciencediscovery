// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import React from "react";
import assert from "node:assert/strict";
import { renderToStaticMarkup } from "react-dom/server";
import { createTest } from "../../../test/support/tagged/compat.mjs";
import { ApiClient } from "../src/api/client.js";
import type { ModelUsageBucket, SessionUsageSummary } from "../src/api/types.js";
import { getSessionUsage } from "../src/api/usage.js";
import { indexTurnUsage, useTurnUsage } from "../src/app/use-turn-usage.js";
import { TEXT } from "../src/text.js";
import { AnswerBlock, AssistantTurns } from "../src/views/AssistantTurn.js";
import { emptyRunStream } from "../src/run-stream/model.js";
import { TurnUsage, TurnUsageDetails } from "../src/views/TurnUsage.js";
import { act, create, type ReactTestRenderer } from "./support/dom-renderer.js";

const { test } = createTest(import.meta.url, { tags: ["category:ut", "os:linux", "arch:amd64", "arch:arm64"] });
Object.defineProperty(globalThis, "IS_REACT_ACT_ENVIRONMENT", { configurable: true, writable: true, value: true });

function bucket(key = "run-a", changes: Partial<ModelUsageBucket> = {}): ModelUsageBucket {
  return { key, label: key, invocationCount: 1, reportedInvocationCount: 1, unreportedInvocationCount: 0,
    inputTokens: 60697, outputTokens: 47, totalTokens: 60744, cacheReadTokens: 59392,
    cacheWriteTokens: null, reasoningTokens: null, costUsd: null, ...changes };
}
function summary(sessionId = "session-a"): SessionUsageSummary {
  return { sessionId, totals: bucket("total", { totalTokens: 999999 }), byModel: [], byInvocationKind: [],
    byRun: [bucket(), bucket("run-b", { totalTokens: 20, inputTokens: 0, outputTokens: 20, cacheReadTokens: 0 })],
    invocations: ["run-a", "run-b"].map((runId, index) => ({
      ...bucket(runId), id: `invocation-${index}`, attemptIndex: 0, invocationId: `task-${index}`,
      invocationKind: "task", model: "deepseek-model", modelProfileId: "profile", modelProfileName: "Gateway",
      finishedAt: "", startedAt: "", sessionId, runId, usageStatus: "reported",
    })) };
}
class Client extends ApiClient {
  calls: string[] = [];
  constructor(readonly handle: (path: string) => unknown | Promise<unknown>) { super(""); }
  override async request<T>(path: string): Promise<T> { this.calls.push(path); return await this.handle(path) as T; }
}
const runs = [{ id: "run-a", assistantMessageId: "answer-a" }, { id: "run-b", assistantMessageId: "answer-b" }];

test("turn usage uses durable run IDs, keeps the backend total and does not mix in other turns", () => {
  const source = summary();
  const original = structuredClone(source);
  const index = indexTurnUsage(source, runs);
  assert.equal(index.byMessage.get("answer-a")?.bucket.totalTokens, 60744);
  assert.equal(index.byMessage.get("answer-b")?.bucket.totalTokens, 20);
  assert.equal(index.byMessage.get("answer-a"), index.byRun.get("run-a"));
  assert.deepEqual(index.byRun.get("run-a")?.models, ["Gateway"]);
  assert.equal(index.byMessage.has("unlinked-answer"), false);
  assert.deepEqual(source, original, "indexing must not mutate backend data");
});

test("partial reports stay partial; reported zero and absent cache fields remain distinct", () => {
  const source = summary();
  const invocation = source.invocations[0]; assert.ok(invocation);
  const runBucket = source.byRun[0]; assert.ok(runBucket);
  invocation.inputTokens = null;
  runBucket.unreportedInvocationCount = 1;
  const index = indexTurnUsage(source, runs);
  const data = index.byRun.get("run-a"); assert.ok(data);
  assert.equal(data.incomplete, true);
  const html = renderToStaticMarkup(<TurnUsageDetails data={{ ...data, models: ["Custom · DeepSeek V4 Pro"], bucket: { ...data.bucket, inputTokens: 0 } }} />);
  assert.ok(html.includes(`<dt>${TEXT.conversation.usage.input}</dt><dd>0 tok</dd>`));
  assert.ok(!html.includes(TEXT.conversation.usage.cacheWrite));
  assert.ok(html.includes("DeepSeek V4 Pro"));
  assert.doesNotMatch(html, /Custom|DeepSeek-V4-Pro/);
  assert.ok(html.includes(TEXT.conversation.usage.incomplete));
  assert.ok(!html.includes(TEXT.conversation.usage.reasoning), "absent optional reasoning is not invented");
});

test("a completed answer has a compact per-turn usage entry beside copy; streaming prose has none", () => {
  const data = indexTurnUsage(summary(), runs).byRun.get("run-a"); assert.ok(data);
  const usage = <TurnUsage data={data} loading={false} failed={false} onRefresh={() => {}} />;
  const html = renderToStaticMarkup(<AnswerBlock actions content="An answer" usage={usage} />);
  assert.match(html, /60\.7K tok/);
  assert.ok(html.indexOf(TEXT.conversation.copyAnswer) < html.indexOf("60.7K tok"));
  assert.doesNotMatch(html, /999,999|120,136/, "do not substitute the session total or add cache tokens again");
  const live = renderToStaticMarkup(<AnswerBlock actions live content="Streaming" usage={usage} />);
  assert.doesNotMatch(live, /turn-usage-trigger/);
  const unknown = renderToStaticMarkup(<TurnUsage data={{ ...data, bucket: bucket("run", { totalTokens: null }) }}
    loading={false} failed={false} onRefresh={() => {}} />);
  assert.ok(!unknown.includes(TEXT.conversation.usage.unreported));
  const stopped = renderToStaticMarkup(<AssistantTurns client={new Client(() => ({}))} onDecide={async () => {}}
    run={{ ...emptyRunStream(), runId: "run-a", terminal: true, status: "failed", error: { message: "Stopped before an answer" } }} usage={usage} />);
  assert.match(stopped, /60\.7K tok/, "a failed turn can still have provider-reported usage");
});

test("the session usage endpoint encodes session IDs", async () => {
  const client = new Client(() => summary());
  await getSessionUsage(client, "session/a");
  assert.deepEqual(client.calls, ["/api/sessions/session%2Fa/usage"]);
});

test("session switches ignore delayed usage and ordinary rerenders do not request again", async () => {
  let resolveOld: ((value: SessionUsageSummary) => void) | undefined;
  const client = new Client(path => {
    if (path.endsWith("/runs")) return runs;
    if (path.includes("session-a")) return new Promise<SessionUsageSummary>(resolve => { resolveOld = resolve; });
    return summary("session-b");
  });
  let latest: ReturnType<typeof useTurnUsage> | undefined;
  function Probe({ sessionId, revision = "completed" }: { sessionId: string; revision?: string }) {
    latest = useTurnUsage(client, sessionId, revision);
    return null;
  }
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(<Probe sessionId="session-a" />); }); assert.ok(view);
  const renderer = view;
  try {
    await act(async () => { renderer.update(<Probe sessionId="session-b" />); });
    assert.equal(latest?.index.byRun.get("run-a")?.bucket.totalTokens, 60744);
    const count = client.calls.length;
    await act(async () => { renderer.update(<Probe sessionId="session-b" />); });
    assert.equal(client.calls.length, count);
    const old = summary(); const oldBucket = old.byRun[0]; assert.ok(oldBucket); oldBucket.totalTokens = 123;
    await act(async () => { resolveOld?.(old); });
    assert.equal(latest?.index.byRun.get("run-a")?.bucket.totalTokens, 60744);
    await act(async () => { renderer.update(<Probe sessionId="session-b" revision="another-completed-run" />); });
    assert.equal(client.calls.length, count + 2, "one shared usage/runs read after a completed turn");
  } finally { await act(async () => renderer.unmount()); }
});

test("failed usage can be retried and a failed refresh retains the last confirmed data", async () => {
  let refuse = true;
  const client = new Client(path => {
    if (path.endsWith("/runs")) return runs;
    if (refuse) throw new Error("private backend diagnostic");
    return summary();
  });
  let latest: ReturnType<typeof useTurnUsage> | undefined;
  function Probe() { latest = useTurnUsage(client, "session-a", "completed"); return null; }
  let view: ReactTestRenderer | undefined;
  await act(async () => { view = create(<Probe />); }); assert.ok(view);
  const renderer = view;
  try {
    assert.equal(latest?.failed, true);
    refuse = false;
    await act(async () => { latest?.refresh(); });
    assert.equal(latest?.failed, false);
    assert.equal(latest?.index.byRun.get("run-a")?.bucket.totalTokens, 60744);
    refuse = true;
    await act(async () => { latest?.refresh(); });
    assert.equal(latest?.failed, true);
    assert.equal(latest?.index.byRun.get("run-a")?.bucket.totalTokens, 60744);
  } finally { await act(async () => renderer.unmount()); }
});
