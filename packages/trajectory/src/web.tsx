// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useLayoutEffect, useMemo, useRef, useState, type CSSProperties } from "react";
import { text, type TrajectoryDetail, type TrajectoryEntry, type TrajectoryIndex, type TrajectoryKind, type TrajectoryPort } from "./index.js";
import { entryTitle, internalEntry, recordGroups, timelineEnd, timelineRows, timelineScale, visibleKinds } from "./presentation.js";
import { EventContent } from "./content-view.js";
import { InputContent } from "./input-view.js";

const colors: Record<TrajectoryKind, string> = { state: "#d97706", input: "#2563eb", output: "#059669", thinking: "#9333ea", tool: "#db2777", mcp: "#0891b2", lifecycle: "#64748b" };
function time(value: string | null) { return value ? new Date(value).toLocaleTimeString(undefined, { hour12: false, hour: "2-digit", minute: "2-digit", second: "2-digit", fractionalSecondDigits: 3 }) : "—"; }

const ZOOM_MIN = 0.5, ZOOM_MAX = 16;
const TIMELINE_MIN = 90, TIMELINE_MAX = 480;
const LIST_W_MIN = 200, LIST_W_MAX = 640, LIST_H_MIN = 96, LIST_H_MAX = 480;
const DEFAULT_LIST_WIDTH = 290, DEFAULT_LIST_HEIGHT = 130, DEFAULT_TIMELINE_HEIGHT = 160;

/** A draggable/keyboard-adjustable divider, modeled on the workspace resizer in the host app. */
function ResizeHandle({ orientation, label, value, min, max, onResize }: {
  /** `vertical` is an upright bar adjusting a width; `horizontal` a flat bar adjusting a height. */
  orientation: "vertical" | "horizontal"; label: string; value: number; min: number; max: number; onResize(value: number): void;
}) {
  const drag = useRef<{ start: number; value: number }>(undefined);
  const [resizing, setResizing] = useState(false);
  const axis = orientation === "vertical" ? "clientX" : "clientY";
  return <div
    aria-label={label}
    aria-orientation={orientation}
    aria-valuemax={max}
    aria-valuemin={min}
    aria-valuenow={Math.round(value)}
    className={`trajectory-resizer trajectory-resizer-${orientation}${resizing ? " resizing" : ""}`}
    onKeyDown={event => {
      const delta = { ArrowLeft: -24, ArrowUp: -24, ArrowRight: 24, ArrowDown: 24 }[event.key];
      if (delta === undefined && event.key !== "Home" && event.key !== "End") return;
      event.preventDefault();
      onResize(event.key === "Home" ? min : event.key === "End" ? max : Math.min(max, Math.max(min, value + delta!)));
    }}
    onPointerCancel={() => { drag.current = undefined; setResizing(false); }}
    onPointerDown={event => {
      if (event.button !== 0) return;
      event.currentTarget.setPointerCapture(event.pointerId);
      drag.current = { start: event[axis], value };
      setResizing(true);
    }}
    onPointerMove={event => {
      if (!drag.current || !event.currentTarget.hasPointerCapture(event.pointerId)) return;
      onResize(Math.min(max, Math.max(min, Math.round(drag.current.value + event[axis] - drag.current.start))));
    }}
    onPointerUp={event => {
      if (event.currentTarget.hasPointerCapture(event.pointerId)) event.currentTarget.releasePointerCapture(event.pointerId);
      drag.current = undefined; setResizing(false);
    }}
    role="separator"
    tabIndex={0}
  />;
}

/** The viewer owns presentation only. Its host supplies the authenticated read-only port. */
export function TrajectoryViewer({ sessionId, title, port, locale, onClose }: {
  sessionId: string; title: string; port: TrajectoryPort; locale: string; onClose(): void;
}) {
  const zh = locale.startsWith("zh"), tr = (cn: string, en: string) => zh ? cn : en;
  const labels: Record<TrajectoryKind, string> = { state: tr("状态", "State"), input: tr("模型输入", "Input"), output: tr("模型输出", "Output"), thinking: tr("思考", "Thinking"), tool: tr("工具", "Tool"), mcp: "MCP", lifecycle: tr("生命周期", "Lifecycle") };
  const [index, setIndex] = useState<TrajectoryIndex>(), [selected, setSelected] = useState<string>(), [detail, setDetail] = useState<TrajectoryDetail>();
  const [error, setError] = useState(""), [loading, setLoading] = useState(true), [revision, setRevision] = useState(0), [exporting, setExporting] = useState(false);
  const [kinds, setKinds] = useState<Set<TrajectoryKind>>(() => new Set(visibleKinds)), [agent, setAgent] = useState(""), [tab, setTab] = useState("event"), [zoom, setZoom] = useState(1);
  const [trackWidth, setTrackWidth] = useState(450);
  // Section sizes the user drags to change. Undefined until first drag so the
  // CSS defaults stay authoritative; the measured fallback keeps the timeline
  // handle's drag base aligned with the real rendered height.
  const [timelineHeight, setTimelineHeight] = useState<number>(), [listSize, setListSize] = useState<number>();
  const [measuredTimeline, setMeasuredTimeline] = useState(DEFAULT_TIMELINE_HEIGHT);
  // The timeline handle may never grow the area past what shows all lanes;
  // `contentMax` only feeds the handle's ARIA range, the drag clamps live.
  const [contentMax, setContentMax] = useState(TIMELINE_MAX);
  const [narrow, setNarrow] = useState(() => window.matchMedia("(max-width: 720px)").matches);
  const timeline = useRef<HTMLDivElement>(null), scrollPane = useRef<HTMLDivElement>(null), labelsCol = useRef<HTMLDivElement>(null);
  const view = useRef<HTMLDivElement>(null), list = useRef<HTMLDivElement>(null), kindsMenu = useRef<HTMLDetailsElement>(null), exportController = useRef<AbortController>(undefined);
  const zoomRef = useRef(zoom); zoomRef.current = zoom;
  const scaleRef = useRef<ReturnType<typeof timelineScale>>(undefined);
  const zoomAnchor = useRef<{ time: number; clientX: number }>(undefined);
  const closeRef = useRef(onClose); closeRef.current = onClose;
  useEffect(() => {
    const previous = document.activeElement as HTMLElement | null;
    view.current?.focus();
    const keys = (event: KeyboardEvent) => {
      if (event.key === "Escape") { event.preventDefault(); event.stopPropagation(); closeRef.current(); }
    };
    document.addEventListener("keydown", keys, true);
    // Defer the focus restore past the host's re-layout: closing the inline view
    // remounts the conversation, and a synchronous focus scroll would be undone.
    return () => { document.removeEventListener("keydown", keys, true); exportController.current?.abort(); requestAnimationFrame(() => previous?.focus()); };
  }, []);
  useEffect(() => {
    const media = window.matchMedia("(max-width: 720px)");
    const update = () => setNarrow(media.matches);
    update(); media.addEventListener("change", update);
    return () => media.removeEventListener("change", update);
  }, []);
  useEffect(() => {
    if (timelineHeight !== undefined || !timeline.current) return;
    const measure = () => setMeasuredTimeline(Math.round(timeline.current!.getBoundingClientRect().height));
    measure(); const observer = new ResizeObserver(measure);
    observer.observe(timeline.current);
    return () => observer.disconnect();
  }, [timelineHeight, index]);
  useEffect(() => {
    // React delegates wheel listeners as passive, so the Ctrl+wheel zoom needs
    // its own non-passive listener to keep the page itself from scrolling.
    const node = timeline.current;
    if (!node) return;
    const wheel = (event: WheelEvent) => {
      if (!event.ctrlKey) return;
      event.preventDefault();
      const pane = scrollPane.current, current = zoomRef.current;
      const next = Math.round(Math.min(ZOOM_MAX, Math.max(ZOOM_MIN, current * Math.exp(-event.deltaY * 0.002))) * 1000) / 1000;
      if (!pane || next === current) return;
      const x = pane.scrollLeft + (event.clientX - pane.getBoundingClientRect().left);
      zoomAnchor.current = { time: scaleRef.current?.time(Math.max(0, x)) ?? 0, clientX: event.clientX };
      setZoom(next);
    };
    node.addEventListener("wheel", wheel, { passive: false });
    return () => node.removeEventListener("wheel", wheel);
  }, [index]);
  useLayoutEffect(() => {
    // Zoom is anchored at the pointer: the timestamp under it is resolved
    // against the new scale and put back exactly where the cursor is.
    const anchor = zoomAnchor.current, node = scrollPane.current;
    if (!anchor || !node) return;
    zoomAnchor.current = undefined;
    const cursor = anchor.clientX - node.getBoundingClientRect().left;
    node.scrollLeft = Math.max(0, scale.x(anchor.time) - cursor);
  }, [zoom]);
  useEffect(() => {
    const controller = new AbortController(); setLoading(true); setError("");
    port.index(sessionId, controller.signal).then(value => {
      if (controller.signal.aborted) return;
      setIndex(value);
      const all = [...value.entries, ...(value.untimedEntries ?? value.historicalEntries ?? [])];
      setSelected(current => all.some(e => e.id === current) ? current : value.entries.find(e => e.kind === "input")?.id ?? all[0]?.id);
    }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); }).finally(() => { if (!controller.signal.aborted) setLoading(false); });
    return () => controller.abort();
  }, [sessionId, port, revision]);
  useEffect(() => {
    setDetail(undefined);
    if (!selected) return;
    const controller = new AbortController();
    port.detail(sessionId, selected, controller.signal).then(value => { if (!controller.signal.aborted) setDetail(value); }).catch(reason => { if (!controller.signal.aborted) setError(String(reason)); });
    return () => controller.abort();
  }, [sessionId, selected, port, revision]);
  useEffect(() => {
    const reveal = () => list.current?.querySelector<HTMLElement>('[aria-current="true"]')?.scrollIntoView({ block: "nearest" });
    reveal(); const observer = new ResizeObserver(reveal);
    if (list.current) observer.observe(list.current);
    return () => observer.disconnect();
  }, [selected]);
  const selectedAgent = index?.agents.find(a => a.id === agent)?.id ?? index?.agents.find(a => !a.parentId)?.id ?? index?.agents[0]?.id ?? "";
  const groups = useMemo(() => index ? recordGroups(index).map(group => ({ ...group, entries: group.entries.filter(e => !internalEntry(e) && kinds.has(e.kind) && e.agentId === selectedAgent) })).filter(group => group.entries.length) : [], [index, kinds, selectedAgent]);
  const entries = useMemo(() => groups.flatMap(group => group.entries), [groups]);
  // The overview is global; the lower list is scoped to exactly one Agent.
  const timelineEntries = index?.entries.filter(e => e.timestamp && !internalEntry(e)) ?? [];
  useEffect(() => { if (!entries.some(e => e.id === selected)) setSelected(entries[0]?.id); }, [entries, selected]);
  const scale = useMemo(() => timelineScale(index?.entries.filter(e => !internalEntry(e)) ?? [], trackWidth * zoom), [index, trackWidth, zoom]);
  scaleRef.current = scale;
  const choose = (entry: TrajectoryEntry) => { setAgent(entry.agentId); setKinds(current => current.has(entry.kind) ? current : new Set(visibleKinds)); setSelected(entry.id); setTab("event"); setError(""); };
  const associatedInput = index && [...index.entries, ...(index.untimedEntries ?? index.historicalEntries ?? [])].find(e => e.kind === "input" && e.agentId === detail?.entry.agentId && e.runId === detail?.entry.runId && !!e.contextId && e.contextId === detail?.entry.contextId);
  useEffect(() => {
    // Measure the scrollable track pane, not the expanded content: otherwise
    // minimum marker spacing feeds back into the next measurement and keeps
    // growing the axis.
    const measure = () => setTrackWidth(Math.max(450, (scrollPane.current?.clientWidth ?? 630) - 20));
    measure(); const observer = new ResizeObserver(measure);
    if (scrollPane.current) observer.observe(scrollPane.current);
    return () => observer.disconnect();
  }, [index]);
  useLayoutEffect(() => {
    // The label column lives outside the horizontal scroll pane; lane heights
    // depend on each agent's track rows, so mirror them onto the label cells.
    const pane = scrollPane.current, labels = labelsCol.current;
    if (!pane || !labels) return;
    const sync = () => {
      const axis = pane.querySelector(".trajectory-axis");
      const corner = labels.querySelector<HTMLElement>(".trajectory-axis-corner");
      if (axis && corner) corner.style.height = `${axis.getBoundingClientRect().height}px`;
      pane.querySelectorAll(".trajectory-lane").forEach((lane, i) => {
        const label = labels.querySelectorAll<HTMLElement>(".trajectory-lane-label")[i];
        if (label) label.style.height = `${lane.getBoundingClientRect().height}px`;
      });
    };
    sync();
    const observer = new ResizeObserver(sync);
    pane.querySelectorAll(".trajectory-lane, .trajectory-axis").forEach(lane => observer.observe(lane));
    return () => observer.disconnect();
  }, [index]);
  useEffect(() => {
    // Cap the timeline handle at exactly the height that shows every lane:
    // content height plus the always-visible horizontal scrollbar.
    const pane = scrollPane.current;
    if (!pane) return;
    const measure = () => {
      const inner = pane.firstElementChild as HTMLElement | null;
      if (!inner) return;
      const scrollbar = pane.offsetHeight - pane.clientHeight;
      setContentMax(Math.max(TIMELINE_MIN, Math.min(TIMELINE_MAX, Math.ceil(inner.getBoundingClientRect().height + scrollbar))));
    };
    measure(); const observer = new ResizeObserver(measure);
    if (pane.firstElementChild) observer.observe(pane.firstElementChild);
    return () => observer.disconnect();
  }, [index]);
  useEffect(() => {
    if (timelineHeight !== undefined && timelineHeight > contentMax) setTimelineHeight(contentMax);
  }, [contentMax, timelineHeight]);
  const capTimeline = (value: number) => {
    const pane = scrollPane.current, inner = pane?.firstElementChild as HTMLElement | null | undefined;
    if (!pane || !inner) return Math.min(value, TIMELINE_MAX);
    const cap = Math.ceil(inner.getBoundingClientRect().height + (pane.offsetHeight - pane.clientHeight));
    return Math.max(TIMELINE_MIN, Math.min(TIMELINE_MAX, value, cap));
  };
  const kindSummary = kinds.size === visibleKinds.length ? tr("所有类型", "All types")
    : kinds.size === 0 ? tr("未选类型", "No types")
    : kinds.size === 1 ? labels[[...kinds][0]!]
    : tr(`${kinds.size} 类`, `${kinds.size} types`);
  useEffect(() => {
    const close = (event: PointerEvent) => {
      const menu = kindsMenu.current;
      if (menu?.open && !menu.contains(event.target as Node)) menu.open = false;
    };
    document.addEventListener("pointerdown", close);
    return () => document.removeEventListener("pointerdown", close);
  }, []);
  const download = async () => {
    const controller = new AbortController(); exportController.current = controller; setExporting(true); setError("");
    try {
      const blob = await port.export(sessionId, controller.signal);
      if (controller.signal.aborted) return;
      const url = URL.createObjectURL(blob), anchor = document.createElement("a");
      anchor.href = url; anchor.download = `trajectory-${sessionId}.ndjson`; anchor.click(); setTimeout(() => URL.revokeObjectURL(url), 1000);
    } catch (reason) { if (!controller.signal.aborted) setError(String(reason)); }
    finally { if (!controller.signal.aborted) setExporting(false); }
  };
  const bodyStyle: CSSProperties = narrow
    ? { gridTemplateRows: `${listSize ?? DEFAULT_LIST_HEIGHT}px 5px minmax(0, 1fr)` }
    : { gridTemplateColumns: `${listSize ?? DEFAULT_LIST_WIDTH}px 5px minmax(0, 1fr)` };
  return <div className="trajectory-view" role="region" aria-label={tr("Session 轨迹", "Session trajectory")} ref={view} tabIndex={-1} onKeyDown={event => {
    if (event.key === "Escape") { event.stopPropagation(); closeRef.current(); }
  }}>
    <header className="trajectory-header"><div className="trajectory-title"><small>SESSION OBSERVATORY</small><h2>{tr("执行轨迹与模型上下文", "Trajectory & model context")}</h2><p title={title}>{title}</p></div><div className="trajectory-actions">
      <button onClick={() => setRevision(r => r + 1)} disabled={loading}>{tr("刷新", "Refresh")}</button>
      <button onClick={() => void download()} disabled={loading || exporting || !index}>{exporting ? tr("导出中…", "Exporting…") : tr("导出 NDJSON", "Export NDJSON")}</button>
      <button onClick={onClose} aria-label={tr("返回对话", "Back to conversation")}>×</button>
    </div></header>
    <p className="trajectory-notice">{tr("只显示已记录的数据。导出可能包含对话、工具结果和敏感业务内容，请妥善保管。", "Recorded data only. Exports may contain conversations, tool results and sensitive business content.")}</p>
    {error && <p role="alert" className="trajectory-error">{error}</p>}
    {loading && <p role="status">{tr("正在读取轨迹…", "Loading trajectory…")}</p>}
    {index && <>
      <div className="trajectory-toolbar"><div className="trajectory-legend">{visibleKinds.map(kind => <span key={kind}><i style={{ background: colors[kind] }} />{labels[kind]}</span>)}</div><span className="trajectory-zoom-hint">{Math.round(zoom * 100) / 100}× · {tr("按住 Ctrl 滚动可缩放", "Ctrl + scroll to zoom")}</span></div>
      <div className="trajectory-timeline" ref={timeline} style={timelineHeight ? { height: timelineHeight, maxHeight: "none" } : undefined} aria-label={tr("真实时间多 Agent 时间轴", "Multi-agent wall-clock timeline")}>
        <div className="trajectory-labels" ref={labelsCol}>
          <div className="trajectory-axis-corner"><span>{timelineEntries.length ? new Date(scale.start).toLocaleDateString() : "—"}</span></div>
          {index.agents.map(a => <div className="trajectory-lane-label" data-agent-id={a.id} key={a.id}><strong title={a.id}>{a.parentId ? "↳ " : ""}{a.label}</strong></div>)}
        </div>
        <div className="trajectory-scroll" ref={scrollPane}><div style={{ width: `${scale.width + 20}px` }}>
        <div className="trajectory-axis"><div>{[0, .25, .5, .75, 1].map(f => <time key={f}>{time(timelineEntries.length ? new Date(scale.time((scale.width - 8) * f)).toISOString() : null)}</time>)}</div></div>
        {index.agents.map(a => <div className="trajectory-lane" data-agent-id={a.id} key={a.id}><div className="trajectory-tracks">{timelineRows(timelineEntries.filter(e => e.agentId === a.id)).map((row, i) => <div className="trajectory-track" data-category={row.category} key={i} aria-label={`${a.label} · ${row.category}`}>
          {row.entries.map(e => <button key={e.id} data-entry-id={e.id} data-kind={e.kind} className={selected === e.id ? "trajectory-mark selected" : "trajectory-mark"} style={{ left: scale.x(Date.parse(e.timestamp!)), background: colors[e.kind], width: Math.max(8, scale.x(timelineEnd(e)) - scale.x(Date.parse(e.timestamp!)) - 2) }} title={`${time(e.timestamp)} · ${labels[e.kind]} · ${entryTitle(e, zh)} · Run ${e.runId ?? "—"}`} aria-label={`${a.label} ${time(e.timestamp)} ${labels[e.kind]} ${entryTitle(e, zh)}`} onClick={() => choose(e)} />)}
        </div>)}</div></div>)}
      </div></div></div>
      <ResizeHandle orientation="horizontal" label={tr("调整时间轴高度", "Resize timeline")} value={timelineHeight ?? measuredTimeline} min={TIMELINE_MIN} max={contentMax} onResize={v => setTimelineHeight(capTimeline(v))} />
      {index.warnings.length > 0 && <details className="trajectory-warnings"><summary>{tr("记录完整性说明", "Recording completeness")} ({index.warnings.length})</summary>{index.warnings.map(w => <p key={w}>{w}</p>)}</details>}
      <div className="trajectory-body" style={bodyStyle}><aside className="trajectory-events"><div className="trajectory-filters"><select aria-label="Agent" value={selectedAgent} onChange={e => setAgent(e.target.value)}>{index.agents.map(a => <option key={a.id} value={a.id}>{a.label}</option>)}</select><details className="trajectory-kinds" ref={kindsMenu}><summary aria-label={tr("事件类型", "Event type")}>{kindSummary}</summary><div className="trajectory-kinds-panel"><div className="trajectory-kinds-actions"><button type="button" onClick={() => setKinds(new Set(visibleKinds))}>{tr("全选", "All")}</button><button type="button" onClick={() => setKinds(new Set())}>{tr("清空", "None")}</button></div>{visibleKinds.map(k => <label key={k}><input type="checkbox" checked={kinds.has(k)} onChange={e => setKinds(current => { const next = new Set(current); if (e.target.checked) next.add(k); else next.delete(k); return next; })} /><i style={{ background: colors[k] }} />{labels[k]}</label>)}</div></details></div>
      <div className="trajectory-event-list" ref={list}>{groups.length ? groups.map(group => <section className="trajectory-event-group" key={group.id}><header><strong>{index.agents.find(a => a.id === group.agentId)?.label}</strong><small title={group.runId}>Run {group.runId?.slice(0, 8) ?? "—"}</small></header>{group.entries.map(e => <button key={e.id} data-entry-id={e.id} data-event-type={e.eventType ?? e.label} aria-current={selected === e.id ? "true" : undefined} onClick={() => choose(e)} style={{ "--event-color": colors[e.kind] } as CSSProperties}><span><i />{labels[e.kind]}<time>{e.timestamp ? time(e.timestamp) : tr("时间未记录", "Time not recorded")}</time></span><strong>{entryTitle(e, zh)}</strong><small className="trajectory-run" title={e.runId}>{e.turn !== undefined ? `turn ${e.turn}` : ""}{e.sequence !== undefined ? ` · #${e.sequence}` : ""}{!e.timestamp ? tr(" · 调用记录", " · Invocation record") : ""}</small></button>)}</section>) : <p>{tr("暂无匹配的记录", "No matching records")}</p>}</div></aside>
      <ResizeHandle orientation={narrow ? "horizontal" : "vertical"} label={narrow ? tr("调整列表高度", "Resize event list") : tr("调整列表宽度", "Resize event list")} value={listSize ?? (narrow ? DEFAULT_LIST_HEIGHT : DEFAULT_LIST_WIDTH)} min={narrow ? LIST_H_MIN : LIST_W_MIN} max={narrow ? LIST_H_MAX : LIST_W_MAX} onResize={setListSize} />
      <section className="trajectory-detail"><nav aria-label={tr("详情类型", "Detail type")}>{[["event", tr("事件内容", "Event content")], ["state", tr("Agent 状态", "Agent state")]].map(([id, label]) => <button key={id} aria-pressed={tab === id} onClick={() => setTab(id!)}>{label}</button>)}{detail && detail.entry.id === selected && detail.entry.kind !== "input" && associatedInput && <button className="trajectory-input-link" onClick={() => choose(associatedInput)}>{tr("查看本次输入", "View request input")}</button>}</nav>
      {detail && detail.entry.id === selected ? <><div className="trajectory-detail-heading"><strong>{labels[detail.entry.kind]} · {entryTitle(detail.entry, zh)}</strong><time>{detail.entry.timestamp ?? tr("时间未记录", "Time not recorded")}</time><small className="trajectory-run" title={`Run ${detail.entry.runId ?? "—"} · turn ${detail.entry.turn ?? "—"} · #${detail.entry.sequence ?? "—"}`}>Run {detail.entry.runId ?? "—"}{detail.entry.turn !== undefined ? ` · turn ${detail.entry.turn}` : ""}{detail.entry.sequence !== undefined ? ` · #${detail.entry.sequence}` : ""}</small></div>
        {tab === "event" && detail.entry.kind === "input" && detail.context ? <InputContent key={detail.entry.id} context={detail.context} zh={zh} />
        : tab === "event" ? <EventContent detail={detail} zh={zh} />
        : tab === "state" && detail.entry.kind === "state" ? <pre className="trajectory-raw">{text(detail.value)}</pre>
        : detail.context ? <pre className="trajectory-raw">{text(detail.context.state)}</pre>
        : <div className="trajectory-empty">{tr("此节点没有已记录的模型上下文关联。可选择蓝色「模型输入」节点查看固定快照。", "This node has no recorded model-context association. Select a blue model-input node to inspect its frozen snapshot.")}</div>}
      </> : <div className="trajectory-empty">{selected ? tr("读取节点…", "Loading entry…") : tr("Session 尚无轨迹。运行一次任务后在此查看。", "No trajectory yet. Run a task to inspect it here.")}</div>}
      </section></div>
    </>}
  </div>;
}
