// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import { EVOLVE_BASELINE_LIMIT, EVOLVE_EDITABLE_LIMIT, evolveBaselineFields, evolveFieldIsSelectable, type EvolveDirectionInput } from "@sciencediscovery/schema";

type Kind = "string" | "number" | "boolean" | "null" | "object" | "array";
type Value = { kind: Kind; text: string; rows: Row[] };
type Row = { id: number; name: string; value: Value; editable: boolean };

let nextId = 0;
const newValue = (kind: Kind): Value => ({ kind, text: kind === "boolean" ? "false" : kind === "number" ? "0" : "", rows: [] });
function makeRow(name: string, value: unknown, editable = false): Row {
  const kind = value === null ? "null" : Array.isArray(value) ? "array" : typeof value as Kind;
  const node = newValue(kind);
  if (kind === "object" || kind === "array") {
    node.rows = Object.entries(value as object).map(([key, child]) => makeRow(key, child));
  } else if (value !== null) {
    node.text = String(value);
  }
  return { id: ++nextId, name, value: node, editable };
}

function toJson(value: Value): unknown {
  switch (value.kind) {
    case "string": return value.text;
    case "number": {
      const number = Number(value.text);
      if (!value.text.trim() || !Number.isFinite(number)) throw new Error("number");
      return number;
    }
    case "boolean": return value.text === "true";
    case "null": return null;
    case "array": return value.rows.map((row) => toJson(row.value));
    case "object": {
      const keys = value.rows.map((row) => row.name);
      if (new Set(keys).size !== keys.length || keys.some((key) => !key.trim())) throw new Error("keys");
      return Object.fromEntries(value.rows.map((row) => [row.name, toJson(row.value)]));
    }
  }
}

const copy = {
  zh: { title: "起始字段", needSession: "会话尚未就绪：先在会话输入框发送一条消息，「生成起始字段」就会启用。", draft: "生成起始字段", drafting: "正在生成…", upload: "上传 JSON", add: "添加字段", addItem: "添加元素", empty: "根据任务生成起始字段、导入文件，或直接添加字段。", name: "字段名", value: "初始值", scope: "允许修改", remove: "删除", type: "值类型", invalid: "请检查字段名是否为空或重复，以及数值是否有效。", readError: "无法导入。请选择包含 JSON 对象的文件。", draftError: "未能生成起始字段，请重试或上传文件。", locked: "未勾选的字段将保持原值", types: ["文本", "数字", "布尔值", "空值", "对象", "数组"] },
  en: { title: "Starting fields", needSession: "This session is not ready yet: send a message in the composer and Generate starting fields becomes available.", draft: "Generate starting fields", drafting: "Generating…", upload: "Upload JSON", add: "Add field", addItem: "Add item", empty: "Generate starting fields from your task, upload a file, or add fields.", name: "Field name", value: "Initial value", scope: "Allow edits", remove: "Remove", type: "Value type", invalid: "Check for empty or duplicate field names and invalid numbers.", readError: "Could not import the file. Choose a JSON object.", draftError: "Could not generate starting fields. Retry or upload a file.", locked: "Unchecked fields stay fixed", types: ["Text", "Number", "Boolean", "Null", "Object", "Array"] },
};
const kinds: Kind[] = ["string", "number", "boolean", "null", "object", "array"];
type Labels = typeof copy.en;

function ValueEditor({ labels, name, value, onChange }: { labels: Labels; name: string; value: Value; onChange: (next: Value) => void }) {
  const { kind, text, rows } = value;
  const setText = (next: string) => onChange({ ...value, text: next });
  const update = (id: number, next?: Row) => onChange({ ...value, rows: rows.flatMap((row) => row.id === id ? next ? [next] : [] : [row]) });
  let input: ReactNode;
  switch (kind) {
    case "object":
    case "array":
      input = <details className="evolve-json-nested">
        <summary>{kind === "object" ? "{…}" : "[…]"} · {rows.length}</summary>
        <div className="evolve-json-children">{rows.map((row) => <div key={row.id} className="evolve-json-child">
          {kind === "object" ? <input aria-label={labels.name} value={row.name} onChange={(event) => update(row.id, { ...row, name: event.target.value })} /> : null}
          <ValueEditor labels={labels} name={row.name || labels.value} value={row.value} onChange={(child) => update(row.id, { ...row, value: child })} />
          <button aria-label={labels.remove} type="button" onClick={() => update(row.id)}>×</button>
        </div>)}
        <button type="button" onClick={() => onChange({ ...value, rows: [...rows, makeRow("", "")] })}>＋ {kind === "object" ? labels.add : labels.addItem}</button></div>
      </details>;
      break;
    case "boolean":
      input = <select aria-label={name} value={text} onChange={(event) => setText(event.target.value)}><option value="true">true</option><option value="false">false</option></select>;
      break;
    case "null":
      input = <span>null</span>;
      break;
    default:
      input = <input aria-label={name} type={kind === "number" ? "number" : "text"} step={kind === "number" ? "any" : undefined}
        value={text} onChange={(event) => setText(event.target.value)} />;
  }
  return <div className="evolve-json-value">
    {input}
    <select aria-label={labels.type} value={kind} onChange={(event) => onChange(newValue(event.target.value as Kind))}>
      {kinds.map((type, index) => <option key={type} value={type}>{labels.types[index]}</option>)}
    </select>
  </div>;
}

export function DirectionInput({ chinese, onChange, onGenerate, value }: {
  chinese: boolean;
  onChange: (value: EvolveDirectionInput | undefined) => void;
  onGenerate?: (signal: AbortSignal) => Promise<EvolveDirectionInput>;
  value?: EvolveDirectionInput;
}) {
  const labels = chinese ? copy.zh : copy.en;
  const id = useId();
  const [rows, setRows] = useState(() => (evolveBaselineFields(value?.baseline ?? "") ?? [])
    .map(([field, initial]) => makeRow(field, initial, value?.editable.includes(field))));
  const [error, setError] = useState<"read" | "draft" | "values">();
  const [busy, setBusy] = useState(false);
  const [fileName, setFileName] = useState("");
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  const selected = rows.filter((row) => row.editable).length;

  const apply = (next: Row[]) => {
    setRows(next);
    try {
      const baseline = JSON.stringify(toJson({ kind: "object", rows: next, text: "" }));
      const editable = next.filter((row) => row.editable).map((row) => row.name);
      if (baseline.length > EVOLVE_BASELINE_LIMIT || !editable.every(evolveFieldIsSelectable)) throw new Error("limit");
      setError(undefined);
      onChange({ baseline, editable });
    } catch {
      setError("values");
      onChange(undefined);
    }
  };
  const load = (source: EvolveDirectionInput) => {
    const fields = evolveBaselineFields(source.baseline);
    if (!fields) throw new Error("invalid JSON object");
    apply(fields.map(([field, initial]) => makeRow(field, initial, source.editable.includes(field))));
  };
  const generate = async () => {
    if (!onGenerate || busy) return;
    const request = new AbortController();
    controller.current = request;
    setBusy(true);
    setError(undefined);
    try {
      const draft = await onGenerate(request.signal);
      if (request.signal.aborted) return;
      load(draft);
      setFileName("");
    } catch {
      if (!request.signal.aborted) setError("draft");
    } finally {
      setBusy(false);
    }
  };
  const changeRow = (id: number, next: Row) => apply(rows.map((row) => row.id === id ? next : row));

  return <section aria-labelledby={id} className="evolve-direction-input">
    <header className="evolve-json-header"><div><h3 id={id}>{labels.title}</h3><p>{labels.locked}</p></div>
      <div className="evolve-json-tools">
        <button type="button" disabled={busy || !onGenerate} onClick={() => void generate()}>{busy ? labels.drafting : labels.draft}</button>
        <label className="evolve-json-upload">{labels.upload}<input aria-label={labels.upload} accept=".json,application/json" type="file" disabled={busy}
          onChange={async (event) => {
            const file = event.currentTarget.files?.[0];
            event.currentTarget.value = "";
            if (!file) return;
            try {
              if (file.size > EVOLVE_BASELINE_LIMIT * 4) throw new Error();
              load({ baseline: await file.text(), editable: [] });
              setFileName(file.name);
            } catch { setError("read"); }
          }} /></label>
      </div>
    </header>
    {/* `onGenerate` is absent because the session has no loaded detail yet —
        App.tsx hands it over only while `state.detail` exists — so the hint
        names that reason rather than the task the user already typed (#1091). */}
    {!onGenerate ? <p className="evolve-json-file">{labels.needSession}</p> : null}
    {fileName ? <p className="evolve-json-file">{fileName}</p> : null}
    {error ? <p role="alert" className="evolve-json-error">{error === "read" ? labels.readError : error === "draft" ? labels.draftError : labels.invalid}</p> : null}
    <fieldset disabled={busy} className="evolve-json-fieldset">
      {rows.length ? <div className="evolve-json-list">
        <div aria-hidden="true" className="evolve-json-column-labels"><span>{labels.scope}</span><span>{labels.name}</span><span>{labels.value}</span></div>
        {rows.map((row) => <div className="evolve-json-row" data-editable={row.editable} key={row.id}>
          <input aria-label={row.name ? `${labels.scope} ${row.name}` : labels.scope} type="checkbox" checked={row.editable}
            disabled={!row.editable && selected >= EVOLVE_EDITABLE_LIMIT} onChange={(event) => changeRow(row.id, { ...row, editable: event.target.checked })} />
          <input aria-label={labels.name} placeholder={labels.name} value={row.name} onChange={(event) =>
            changeRow(row.id, { ...row, name: event.target.value })} />
          <ValueEditor labels={labels} name={row.name || labels.value} value={row.value} onChange={(node) => changeRow(row.id, { ...row, value: node })} />
          <button className="evolve-json-remove" aria-label={row.name ? `${labels.remove} ${row.name}` : labels.remove}
            type="button" onClick={() => apply(rows.filter((item) => item.id !== row.id))}>×</button>
        </div>)}
      </div> : <p className="evolve-json-empty">{labels.empty}</p>}
      <footer className="evolve-json-footer"><button type="button" onClick={() => apply([...rows, makeRow("", "")])}>＋ {labels.add}</button>
        <span role="status">{chinese ? `已允许修改 ${selected} 项` : `${selected} editable`}</span>
      </footer>
    </fieldset>
  </section>;
}
