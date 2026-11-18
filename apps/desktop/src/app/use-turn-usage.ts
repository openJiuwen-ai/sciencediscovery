// Copyright (C) 2026 Huawei Technologies Co., Ltd
// SPDX-License-Identifier: Apache-2.0
import { useCallback, useEffect, useMemo, useState } from "react";
import type { ApiClient } from "../api/client.js";
import { listRuns } from "../api/sessions.js";
import { getSessionUsage } from "../api/usage.js";
import type { ModelUsageBucket, SessionRun, SessionUsageSummary } from "../api/types.js";

export interface TurnUsageData {
  bucket: ModelUsageBucket;
  models: string[];
  incomplete: boolean;
}

/** Associate usage with durable run/message IDs, including runs whose event log was pruned. */
export function indexTurnUsage(summary: SessionUsageSummary, runs: readonly Pick<SessionRun, "id" | "assistantMessageId">[]) {
  const byRun = new Map<string, TurnUsageData>();
  const byMessage = new Map<string, TurnUsageData>();
  const invocationsByRun = new Map<string, SessionUsageSummary["invocations"]>();
  for (const invocation of summary.invocations) {
    if (!invocation.runId) continue;
    const group = invocationsByRun.get(invocation.runId) ?? [];
    group.push(invocation);
    invocationsByRun.set(invocation.runId, group);
  }
  for (const bucket of summary.byRun) {
    const invocations = invocationsByRun.get(bucket.key) ?? [];
    byRun.set(bucket.key, {
      bucket,
      models: [...new Set(invocations.map(item => item.modelProfileName || item.model))],
      incomplete: bucket.unreportedInvocationCount > 0 || invocations.some(item =>
        item.inputTokens === null || item.outputTokens === null || item.totalTokens === null),
    });
  }
  for (const run of runs) {
    const usage = byRun.get(run.id);
    if (run.assistantMessageId && usage) byMessage.set(run.assistantMessageId, usage);
  }
  return { byRun, byMessage };
}

/** One shared read per conversation update, never one request per answer or stream delta. */
export function useTurnUsage(client: ApiClient, sessionId: string | undefined, revision: string) {
  const [nonce, setNonce] = useState(0);
  const [state, setState] = useState<{
    client?: ApiClient;
    sessionId?: string;
    index?: ReturnType<typeof indexTurnUsage>;
    loading: boolean;
    failed: boolean;
  }>({ loading: false, failed: false });
  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    setState(previous => ({ client, sessionId, index: previous.client === client && previous.sessionId === sessionId ? previous.index : undefined, loading: true, failed: false }));
    void (async () => {
      try {
        const [summary, runs] = await Promise.all([getSessionUsage(client, sessionId), listRuns(client, sessionId)]);
        if (!cancelled) setState({ client, sessionId, index: indexTurnUsage(summary, runs), loading: false, failed: false });
      } catch {
        if (!cancelled) setState(previous => ({ ...previous, loading: false, failed: true }));
      }
    })();
    return () => { cancelled = true; };
  }, [client, sessionId, revision, nonce]);
  const refresh = useCallback(() => setNonce(value => value + 1), []);
  const empty = useMemo(() => ({ byRun: new Map<string, TurnUsageData>(), byMessage: new Map<string, TurnUsageData>() }), []);
  const current = state.sessionId === sessionId && state.client === client;
  return { index: current ? state.index ?? empty : empty, loading: current && state.loading, failed: current && state.failed, refresh };
}
