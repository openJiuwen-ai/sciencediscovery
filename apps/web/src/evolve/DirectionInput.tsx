// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useId, useRef, useState, type CSSProperties } from "react";
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
const treeCopy = {
  zh: {
    expand: "展开",
    collapse: "折叠",
    count: (size: number, array: boolean) => `${size} 个${array ? "元素" : "字段"}`,
  },
  en: {
    expand: "Expand",
    collapse: "Collapse",
    count: (size: number, array: boolean) => `${size} ${array ? "item" : "field"}${size === 1 ? "" : "s"}`,
  },
};
type Labels = typeof copy.en & typeof treeCopy.en;

function ScalarValueEditor({ name, value, onChange }: { name: string; value: Value; onChange: (next: Value) => void }) {
  const { kind, text } = value;
  const setText = (next: string) => onChange({ ...value, text: next });
  switch (kind) {
    case "boolean":
      return <select aria-label={name} value={text} onChange={(event) => setText(event.target.value)}><option value="true">true</option><option value="false">false</option></select>;
    case "null":
      return <span className="evolve-json-null">null</span>;
    default:
      return <input aria-label={name} type={kind === "number" ? "number" : "text"} step={kind === "number" ? "any" : undefined}
        value={text} onChange={(event) => setText(event.target.value)} />;
  }
}

function DirectionRow({ row, labels, depth = 0, index, selectionLimitReached = false, onChange, onRemove }: {
  row: Row;
  labels: Labels;
  depth?: number;
  index?: number;
  selectionLimitReached?: boolean;
  onChange: (next: Row) => void;
  onRemove: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const childrenId = useId();
  const { kind, rows } = row.value;
  const isRoot = depth === 0;
  const isArray = kind === "array";
  const isContainer = kind === "object" || isArray;
  const name = index === undefined ? row.name : `[${index}]`;
  const label = name || labels.value;
  const setValue = (value: Value) => onChange({ ...row, value });
  const setChildren = (children: Row[]) => setValue({ ...row.value, rows: children });

  return <div className="evolve-json-entry" data-editable={isRoot && row.editable} style={{ "--evolve-json-depth": depth } as CSSProperties}>
    <div className="evolve-json-row" data-root={isRoot}>
      {isRoot ? <input className="evolve-json-scope" aria-label={name ? `${labels.scope} ${name}` : labels.scope}
        type="checkbox" checked={row.editable} disabled={!row.editable && selectionLimitReached}
        onChange={(event) => onChange({ ...row, editable: event.target.checked })} /> : null}
      {index === undefined
        ? <input className="evolve-json-name" aria-label={labels.name} placeholder={labels.name} value={row.name}
          onChange={(event) => onChange({ ...row, name: event.target.value })} />
        : <span className="evolve-json-name evolve-json-index">{name}</span>}
      <div className="evolve-json-value">
        {isContainer
          ? <button className="evolve-json-disclosure" type="button" aria-expanded={expanded} aria-controls={childrenId}
            aria-label={`${expanded ? labels.collapse : labels.expand} ${label}, ${labels.count(rows.length, isArray)}`}
            onClick={() => setExpanded(!expanded)}>
            <span className="evolve-json-chevron" aria-hidden="true" />{labels.count(rows.length, isArray)}
          </button>
          : <ScalarValueEditor name={label} value={row.value} onChange={setValue} />}
      </div>
      <select className="evolve-json-type" aria-label={labels.type} value={kind} onChange={(event) => {
        const nextKind = event.target.value as Kind;
        setExpanded(nextKind === "object" || nextKind === "array");
        setValue(newValue(nextKind));
      }}>
        {kinds.map((type, kindIndex) => <option key={type} value={type}>{labels.types[kindIndex]}</option>)}
      </select>
      <button className="evolve-json-remove" aria-label={name ? `${labels.remove} ${name}` : labels.remove}
        type="button" onClick={onRemove}>×</button>
    </div>
    {isContainer ? <div className="evolve-json-children" id={childrenId} hidden={!expanded}>
      {rows.map((child, childIndex) => <DirectionRow key={child.id} row={child} labels={labels}
        depth={depth + 1} index={isArray ? childIndex : undefined}
        onChange={(next) => setChildren(rows.map((item) => item.id === child.id ? next : item))}
        onRemove={() => setChildren(rows.filter((item) => item.id !== child.id))} />)}
      <div className="evolve-json-add-row">
        <button type="button" onClick={() => setChildren([...rows, makeRow("", "")])}>
          ＋ {isArray ? labels.addItem : labels.add}
        </button>
      </div>
    </div> : null}
  </div>;
}

export function DirectionInput({ chinese, onChange, onGenerate, value }: {
  chinese: boolean;
  onChange: (value: EvolveDirectionInput | undefined) => void;
  onGenerate?: (signal: AbortSignal) => Promise<EvolveDirectionInput>;
  value?: EvolveDirectionInput;
}) {
  const labels = chinese ? { ...copy.zh, ...treeCopy.zh } : { ...copy.en, ...treeCopy.en };
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
        {rows.map((row) => <DirectionRow key={row.id} row={row} labels={labels}
          selectionLimitReached={selected >= EVOLVE_EDITABLE_LIMIT}
          onChange={(next) => changeRow(row.id, next)}
          onRemove={() => apply(rows.filter((item) => item.id !== row.id))} />)}
      </div> : <p className="evolve-json-empty">{labels.empty}</p>}
      <footer className="evolve-json-footer"><button type="button" onClick={() => apply([...rows, makeRow("", "")])}>＋ {labels.add}</button>
        <span role="status">{chinese ? `已允许修改 ${selected} 项` : `${selected} editable`}</span>
      </footer>
    </fieldset>
  </section>;
}
