// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { useEffect, useState } from "react";
import { object, text, type TrajectoryDetail } from "./index.js";
import { contentSections } from "./presentation.js";

function Fields({ value }: { value: unknown }) {
  if (Array.isArray(value)) return value.length ? <div className="trajectory-field-items">{value.map((item, i) => <div key={i}><Fields value={item} /></div>)}</div> : <p className="trajectory-muted">—</p>;
  if (value === null || typeof value !== "object") return <pre className="trajectory-value">{text(value)}</pre>;
  return <dl className="trajectory-fields">{Object.entries(object(value)).map(([key, item]) => <div key={key}><dt>{key}</dt><dd><pre>{text(item)}</pre></dd></div>)}</dl>;
}

export function EventContent({ detail, zh }: { detail: TrajectoryDetail; zh: boolean }) {
  const [raw, setRaw] = useState(false);
  useEffect(() => setRaw(false), [detail.entry.id]);
  const sections = contentSections(detail, zh);
  return <><div className="trajectory-content-controls" role="group" aria-label={zh ? "事件展示方式" : "Event display mode"}>
    <button aria-pressed={!raw} onClick={() => setRaw(false)}>{zh ? "解析内容" : "Readable"}</button>
    <button aria-pressed={raw} onClick={() => setRaw(true)}>{zh ? "原始 JSON" : "Raw JSON"}</button>
  </div>{raw ? <pre className="trajectory-raw">{text(detail.value)}</pre> : <div className="trajectory-readable">
    {sections.length ? sections.map((section, i) => <section key={i}><h3>{section.title}</h3>{section.format === "fields" ? <Fields value={section.value} /> : <pre className="trajectory-value">{text(section.value)}</pre>}</section>) : <p className="trajectory-muted">{zh ? "此记录未保存可解析的正文，可查看原始 JSON。" : "No readable body was recorded. Inspect raw JSON for available fields."}</p>}
  </div>}</>;
}
