import { useCallback, useEffect, useRef, useState } from "react";
import type { IdeaResearchView, IdeaTreeSettings } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { IdeaTreeExplorer } from "./IdeaTreeExplorer.js";

const phases: Record<string, string> = {ideate: "构思方向与改进", design: "设计候选", activity: "活性评估", stability: "稳定性评估", sustainability: "可持续性评估", aggregate: "聚合评估", propagate: "汇总研究发现", complete: "已完成"};
const statuses: Record<string, string> = {running: "运行中", pausing: "正在暂停", paused: "已暂停", interrupted: "已中断", completed: "已完成", ended: "已结束"};

export function IdeaResearchPanel({client, sessionId, onError}: {client: ApiClient; sessionId: string; onError: (message: string) => void}) {
  const element = useRef<HTMLElement>(null);
  const [items, setItems] = useState<IdeaResearchView[]>([]);
  const [objective, setObjective] = useState("");
  const [materials, setMaterials] = useState("");
  const [form, setForm] = useState(false);
  const [busy, setBusy] = useState(false);
  const [selected, setSelected] = useState<string>();
  const [confirmEnd, setConfirmEnd] = useState<string>();
  const [settings, setSettings] = useState({maxRounds: 3, candidatesPerRound: 3, maxSearchRounds: 10, maxNodes: 100, maxDepth: 5, maxTokens: 0, maxTokensPerCall: 4000});
  const [roleSettings, setRoleSettings] = useState<Partial<IdeaTreeSettings>>({});
  const [defaults, setDefaults] = useState<Record<string, string>>({});
  const [showPrompts, setShowPrompts] = useState(false);
  const [error, setError] = useState<string>();
  const load = useCallback(async () => {
    try { const result = await client.listIdeaResearch(sessionId); setItems(result.items); setError(undefined); }
    catch (e) { setError(e instanceof Error ? e.message : String(e)); }
  }, [client, sessionId]);
  useEffect(() => {
    let active = true;
    void Promise.all([client.getIdeaTreeSettings(), client.ideaResearchDefaults(sessionId)]).then(([current, def]) => {
      if (!active) return;
      setRoleSettings(current);
      setDefaults(def.prompts);
      setSettings(old => ({...old, maxDepth: current.maxDepth, maxNodes: current.maxNodes, maxSearchRounds: current.maxSearchRounds}));
    }).catch(e => { if (active) setError(String(e)); });
    return () => {active = false;};
  }, [client, sessionId]);
  useEffect(() => { void load(); const timer = setInterval(() => void load(), 5000); return () => clearInterval(timer); }, [load]);
  useEffect(() => {
    const open = (event: Event) => {
      const detail = (event as CustomEvent<{sessionId: string; objective: string}>).detail;
      if (detail.sessionId === sessionId) {setObjective(detail.objective); setForm(true); element.current?.scrollIntoView({block: "center"});}
    };
    window.addEventListener("idea-research-create", open);
    return () => window.removeEventListener("idea-research-create", open);
  }, [sessionId]);
  async function command(operation: string, researchId?: string) {
    setBusy(true);
    try {
      await client.ideaResearchCommand(sessionId, {operation, researchId, ...(operation === "create" ? {objective, materials, settings: {...roleSettings, ...settings, maxTokens: settings.maxTokens || null}} : {})});
      setForm(false); setConfirmEnd(undefined); await load();
    } catch (e) { onError(e instanceof Error ? e.message : String(e)); }
    finally {setBusy(false);}
  }
  const view = items.find(i => i.research.id === selected);
  return <section ref={element} className="idea-tree-detail" aria-label="Idea Tree 研究控制">
    <header><strong>Idea Tree</strong> <button type="button" onClick={() => setForm(!form)}>新建研究</button></header>
    {error && <p role="alert">{error} <button type="button" onClick={() => void load()}>重试</button></p>}
    {form && <div className="idea-tree-fields">
      <label className="idea-tree-field">研究目标与约束<textarea aria-label="研究目标与约束" value={objective} onChange={e => setObjective(e.target.value)} maxLength={16000} /></label>
      <label className="idea-tree-field">给定材料（可留空；引擎不会检索外部资料）<textarea aria-label="给定材料" value={materials} onChange={e => setMaterials(e.target.value)} maxLength={32000} /></label>
      <label>读取已准备的文本材料<input type="file" accept=".txt,.md,.json" onChange={async e => {
        const f = e.target.files?.[0]; if (!f) return;
        if (f.size > 128000) {onError("材料过大，请先整理为不超过 32000 字符的文本"); return;}
        const content = await f.text(); if (content.length > 32000) {onError("材料不得超过 32000 字符"); return;} setMaterials(content);
      }} /></label>
      {(Object.entries({maxRounds: "最多探索轮数", candidatesPerRound: "每轮最多候选", maxSearchRounds: "最多评估候选总数", maxNodes: "最多节点", maxDepth: "最大深度", maxTokens: "token 总预算（0 为不设）", maxTokensPerCall: "单次输出上限"}) as [keyof typeof settings, string][]).map(([key, label]) => <label className="idea-tree-field" key={key}>{label}<input aria-label={label} type="number" min={key === "maxTokens" ? 0 : 1} value={settings[key]} onChange={e => setSettings({...settings, [key]: Number(e.target.value)})} /></label>)}
      <p>使用当前会话模型及系统设置中的角色提示词。轮数和预算启动后不可修改。</p>
      <button type="button" onClick={() => setShowPrompts(!showPrompts)}>查看或替换本次角色提示词</button>
      {showPrompts && <div>
        <p>这里的替换仅用于本次研究；留空使用 Python 默认角色提示词。执行顺序和 JSON 输出格式由引擎另行提供。</p>
        {([['design', '设计', 'designSystemPrompt'], ['aggregate', '聚合', 'aggregatorSystemPrompt'], ['propagate', '传播', 'propagateInsightSystemPrompt']] as const).map(([role, label, field]) => <label className="idea-tree-field" key={role}>{label}
          <textarea aria-label={`${label}提示词`} value={roleSettings[field] ?? ''} placeholder={defaults[role]} onChange={e => setRoleSettings({...roleSettings, [field]: e.target.value})} />
          <button type="button" onClick={() => setRoleSettings({...roleSettings, [field]: ''})}>恢复{label}默认</button>
          <details><summary>有效角色提示词</summary><pre>{roleSettings[field] || defaults[role]}</pre></details>
        </label>)}
        {([['activity', '活性', 'assessorActivity'], ['stability', '稳定性', 'assessorStability'], ['sustainability', '可持续性', 'assessorSustainability']] as const).map(([role, label, field]) => <label className="idea-tree-field" key={role}>{label}评估
          <textarea aria-label={`${label}提示词`} value={roleSettings[field]?.systemPrompt ?? ''} placeholder={defaults[role]} onChange={e => setRoleSettings({...roleSettings, [field]: {...roleSettings[field], systemPrompt: e.target.value}})} />
          <button type="button" onClick={() => setRoleSettings({...roleSettings, [field]: {...roleSettings[field], systemPrompt: ''}})}>恢复{label}默认</button>
          <details><summary>有效角色提示词</summary><pre>{roleSettings[field]?.systemPrompt || defaults[role]}</pre></details>
        </label>)}
      </div>}

      <button type="button" disabled={busy || !objective.trim() || items.some(i => ["running", "pausing"].includes(i.research.status))} onClick={() => void command("create")}>启动研究</button>
    </div>}
    {items.map(({research: r, graph}) => <article key={r.id} className="idea-tree-view">
      <strong>{r.objective}</strong><p>{statuses[r.status]} · 第 {r.round} / {r.settings.maxRounds} 轮 · 本轮完成 {r.batchCompleted} / {r.batch.length || r.batchCompleted}</p>
      <p>已评估 {graph.nodes.filter(n => n.status === "done").length} 个候选</p>
      <p>{phases[r.phase] ?? r.phase} {r.currentNodeId ? `· 节点 ${r.currentNodeId}` : ""} · tokens {r.usageKnown ? r.tokens : `${r.tokens}（部分用量未知）`}</p>
      {r.reason && <p>{r.reason}</p>}
      <button type="button" onClick={() => setSelected(r.id)}>查看树与结果</button>
      {r.status === "running" && <button type="button" disabled={busy} onClick={() => void command("pause", r.id)}>暂停</button>}
      {["paused", "interrupted"].includes(r.status) && <button type="button" disabled={busy} onClick={() => void command("continue", r.id)}>继续</button>}
      {!["completed", "ended"].includes(r.status) && <button type="button" disabled={busy} onClick={() => setConfirmEnd(r.id)}>结束研究</button>}
      {confirmEnd === r.id && <div role="alert">结束后不能继续，已有结果会保留。<button type="button" disabled={busy} onClick={() => void command("end", r.id)}>确认结束</button><button type="button" onClick={() => setConfirmEnd(undefined)}>取消</button></div>}
    </article>)}
    {view && <IdeaTreeExplorer graph={view.graph} treeIds={items.map(i => i.research.id)} loading={false} onClose={() => setSelected(undefined)} onSelectTree={setSelected} />}
  </section>;
}
