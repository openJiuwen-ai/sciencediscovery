// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
import { useEffect, useState } from "react";
import type { ExecutionBlock, ExecutionBlockDecision } from "@sciencediscovery/schema";
import type { ApiClient } from "./api/client.js";
import { useLocale } from "./i18n/index.js";

export function RunnerReadinessPanel({ client, runnerId }: { client: ApiClient; runnerId: string }) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [value, setValue] = useState<Awaited<ReturnType<ApiClient["getRunnerExecutionCapability"]>>>();
  const [error, setError] = useState("");
  const [busy, setBusy] = useState(false);
  const [revision, setRevision] = useState(0);
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setBusy(true); setError(""); setValue(undefined);
    const read = async (refresh: boolean) => {
      try {
        const result = await client.getRunnerExecutionCapability(runnerId, refresh);
        if (active) { setValue(result); setError(""); }
      } catch (reason) { if (active) setError(String(reason)); }
      finally { if (active) { setBusy(false); timer = setTimeout(() => void read(false), 5000); } }
    };
    void read(revision > 0);
    return () => { active = false; clearTimeout(timer); };
  }, [client, runnerId, revision]);
  return <section className="runner-readiness-card" aria-label={zh ? "计算能力" : "Execution readiness"}>
    <strong>{zh ? "计算能力" : "Execution readiness"}</strong>
    <p role="status">{busy ? (zh ? "正在目标 Runner 检查…" : "Checking on the target Runner…") : value?.capability?.ready
      ? (zh ? "已连接，沙箱可用" : "Connected; sandbox available")
      : (zh ? "计算受限；工作台仍可使用" : "Compute unavailable; the workbench remains usable")}</p>
    <p>{error || value?.reason || (!value?.capability?.ready ? value?.capability?.detail ?? value?.capability?.reason : "")}</p>
    {value?.capability && <small>{value.capability.sandbox} · {value.capability.checkedAt}</small>}
    <button type="button" disabled={busy} onClick={() => setRevision(x => x + 1)}>{zh ? "重新检查" : "Recheck"}</button>
  </section>;
}

export function ExecutionBlockCards({ client, sessionId }: { client: ApiClient; sessionId: string }) {
  const { locale } = useLocale();
  const zh = locale === "zh-CN";
  const [blocks, setBlocks] = useState<ExecutionBlock[]>([]);
  const [error, setError] = useState("");
  const [busy, setBusy] = useState<string>();
  useEffect(() => {
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    setBlocks([]); setError("");
    const poll = async () => {
      try { const result = await client.listExecutionBlocks(sessionId); if (active) { setBlocks(result); setError(""); } }
      catch (reason) { if (active) setError(String(reason)); }
      finally { if (active) timer = setTimeout(poll, 2000); }
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [client, sessionId]);
  const decide = async (id: string, decision: ExecutionBlockDecision) => {
    setBusy(id); setError("");
    try { await client.decideExecutionBlock(sessionId, id, decision); setBlocks(items => items.filter(x => x.id !== id)); }
    catch (reason) { setError(String(reason)); }
    finally { setBusy(undefined); }
  };
  return <>{blocks.map(block => <section className="runner-readiness-card" key={block.id} aria-label={zh ? "执行受阻" : "Execution blocked"}>
    <strong>{zh ? "等待用户处理：代码尚未执行" : "Waiting for user: code has not executed"}</strong>
    {block.agentId && <p>{block.agentId}</p>}
    {block.summary && <p>{block.summary}</p>}
    <p>{block.runnerId}: {block.reason}</p>
    {block.suggestions?.map((suggestion, index) => <p key={index}>{suggestion}</p>)}
    <p>{zh ? "您的选择会返回 Agent。重新检查或切换 Runner 都不会自动执行代码，由 Agent 确认目标工作区与环境后决定下一步。" : "Your choice returns to the Agent. Rechecking or switching Runners never executes code automatically; the Agent decides the next step after verifying the target workspace and environment."}</p>
    <button type="button" disabled={busy === block.id} onClick={() => void decide(block.id, { action: "retry" })}>{zh ? "已修复，重新检查" : "Recheck after repair"}</button>
    {block.alternatives.map(target => <button type="button" key={target.runnerId} disabled={busy === block.id} onClick={() => void decide(block.id, { action: "switch", runnerId: target.runnerId })}>{zh ? "改用 " : "Use "}{target.label}</button>)}
    <button type="button" disabled={busy === block.id} onClick={() => void decide(block.id, { action: "cancel" })}>{zh ? "取消本次操作（非整个任务）" : "Cancel operation (not the whole task)"}</button>
  </section>)}{error && blocks.length > 0 ? <p role="alert">{error}</p> : null}</>;
}
