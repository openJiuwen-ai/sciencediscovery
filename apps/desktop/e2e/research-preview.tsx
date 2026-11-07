// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
// Development fixture only: real production component, simulated package service.
import { useState } from "react";
import { createRoot } from "react-dom/client";
import { ApiClient } from "../src/api/client.js";
import type { SessionDetail } from "../src/api/types.js";
import { ResearchPackage, evidenceReadOnly } from "../src/views/ResearchPackage.js";
import "../src/styles/index.css";

const client = new ApiClient("preview");
const originalFetch = window.fetch.bind(window);
window.fetch = async (input, init) => {
  const path = String(input);
  if (!path.startsWith("/api/")) return originalFetch(input, init);
  const json = (value: unknown) => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });
  if (path.includes("/preview")) {
    const complete = path.includes("level=complete");
    return json({ revision: "demo-revision", estimatedBytes: complete ? 2341888 : 825000, files: [{ path: "input/counts.csv", size: 28000, selected: true }, { path: "analysis.py", size: 4200, selected: true }, { path: "results/report.md", size: 6800, selected: true }], omissions: complete ? [] : ["未包含被放弃的旧产物版本和无关执行历史。", "轨迹保留摘要；完整模型详情未包含。"] });
  }
  if (path.endsWith("/inspect")) return json({ manifest: { source: { title: "公开数据差异表达分析" }, omissions: ["必要包未包含部分试错历史。"] }, objectCount: 18, recordsBytes: 44000 });
  if (path.endsWith("/import")) return json({ importedSessionIds: ["imported"] });
  if (path.endsWith("/research-continuations") || path.endsWith("/conversation-branches")) return json({ id: "copy-demo", sourceSessionId: "imported", state: "copying" });
  if (path.includes("/research-continuations/")) return json({ id: "copy-demo", sourceSessionId: "imported", state: "ready", entrySessionId: "copy" });
  if (path.endsWith("/download")) return new Response("Preview only — not a real research archive.");
  if (path.includes("/exports")) return json({ id: "export-demo", status: init?.method === "POST" ? "running" : "completed", filename: "demo-research.sdresearch" });
  return json({});
};
function Preview() {
  const [session, setSession] = useState("source");
  const detail = { id: session, projectId: "demo", title: "公开数据差异表达分析", messages: [
    { id: "u1", role: "user", content: "请分析这份公开表达矩阵，比较两组样本并保留完整证据。" },
    { id: "a1", role: "assistant", content: "已完成输入质量检查，共 12 个样本。下一步进行差异表达分析。" },
    { id: "u2", role: "user", content: "继续分析，并生成结果表和报告。" },
    { id: "a2", role: "assistant", content: "分析已完成。结果表、图和报告已保存，可检查代码、日志与输入来源。" },
  ], ...(session === "imported" ? { researchSnapshot: { role: "imported_snapshot", state: "ready" } } : {}) } as SessionDetail;
  return <div style={{ height: "100vh", background: "#faf9f6", display: "flex", fontFamily: "sans-serif" }}>
    <aside style={{ width: 250, padding: "34px 22px", borderRight: "1px solid #e6e4df" }}><h2 style={{ fontSize: 19 }}>ScienceDiscovery</h2><p style={{ color: "#777", fontSize: 12 }}>桌面前端 · 研究交接</p><hr style={{ margin: "30px 0", border: 0, borderTop: "1px solid #ddd" }} /><p>公开基因组研究</p>{[["source", "原始研究会话"], ["imported", "导入证据快照"], ["copy", "独立研究副本"]].map(([id, title]) => <button key={id} onClick={() => setSession(id)} style={{ display: "block", width: "100%", padding: 13, margin: "8px 0", border: 0, borderRadius: 9, textAlign: "left", cursor: "pointer", background: session === id ? "#e8ece4" : "transparent" }}>{title}</button>)}</aside>
    <main style={{ flex: 1, minWidth: 0 }}><header style={{ padding: "24px 30px", display: "flex", justifyContent: "space-between", borderBottom: "1px solid #e6e4df" }}><strong>{session === "imported" ? "导入证据快照" : session === "copy" ? "独立研究副本" : detail.title}</strong><span style={{ fontSize: 12, color: "#986c25" }}>交互预览 · 模拟数据，未连接真实后端</span></header>
      <ResearchPackage client={client} projectId="demo" detail={detail} running={false} onOpen={setSession} onRefresh={async () => {}} />
      <article style={{ maxWidth: 850, margin: "36px auto", padding: "0 36px" }}>{detail.messages.map(message => <div key={message.id} style={{ margin: "26px 0", padding: 20, borderRadius: 14, background: message.role === "user" ? "#eeede8" : "white", lineHeight: 1.9 }}><small style={{ color: "#888" }}>{message.role === "user" ? "你" : "ScienceDiscovery"}</small><p style={{ margin: "8px 0" }}>{message.content}</p></div>)}{!evidenceReadOnly(detail) ? <div style={{ padding: 24, border: "1px solid #ddd", borderRadius: 16, color: "#999" }}>继续研究… <small>（预览中不调用模型）</small></div> : null}</article>
    </main></div>;
}
createRoot(document.getElementById("root")!).render(<Preview />);
