// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License").

import { useEffect, useId, useRef, useState, type ReactNode } from "react";
import {
  EVOLVE_BASELINE_LIMIT,
  EVOLVE_BUDGET_FIELD_LIMITS,
  EVOLVE_EDITABLE_LIMIT,
  EVOLVE_EXPANSIONS_PER_WORKER,
  EVOLVE_MAX_TOKENS,
  EVOLVE_QUIET_TOKENS_PER_CALL,
  EVOLVE_THINKING_CEILINGS,
  evolveBaselineFields,
  evolveBudgetField,
  evolveExpansionCeiling,
  evolveFieldIsSelectable,
  type EvolveBudgetField,
  type EvolveDirectionInput,
} from "@sciencediscovery/schema";

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

/**
 * The panel edits the *program's* starting JSON. The run's own size — how many
 * expansions, how many workers, the token and time caps — is chosen by the
 * design conversation, not typed here. The two used to be indistinguishable,
 * because the same words name both, so the panel now states the real limits
 * and the budget arithmetic as a reference (#1346). It is deliberately
 * reference only: a candidate may legitimately have a field called
 * `expansions`, and nothing here validates, rewrites or refuses it.
 *
 * Every number comes from the shared schema table the server itself uses, so
 * the reference cannot describe a limit the server does not have.
 */
const copy = {
  zh: {
    title: "参数",
    needTask: "无法自动生成，请上传 JSON 或手动添加参数。",
    draft: "生成起始参数",
    drafting: "正在生成…",
    upload: "上传 JSON",
    add: "添加参数",
    addItem: "添加元素",
    empty: "根据任务生成起始参数、导入文件，或直接添加参数。",
    name: "参数名",
    value: "起始值",
    scope: "参与搜索",
    remove: "删除",
    type: "值类型",
    invalid: "请检查参数名是否为空或重复，以及数值是否有效。",
    readError: "无法导入。请选择包含 JSON 对象的文件。",
    draftError: "未能生成起始参数，请重试或上传文件。",
    types: ["文本", "数字", "布尔值", "空值", "对象", "数组"],
    budgetTitle: "运行限制参考（不是本面板的设置）",
    budgetPeek: (expMin: number, expMax: number, workerMin: number, workerMax: number, total: number, seconds: number) =>
      `expansions ${expMin}–${expMax} 次 · workers ${workerMin}–${workerMax} 个 · maxTokens 上限 ${total} tokens · maxSeconds 固定 ${seconds} 秒`,
    budgetIntro: "运行预算由助手在检查点 3 确定并展示；下面填写的起始参数属于被演进程序的 JSON，不会改变运行预算。以下限制仅作参考。",
    budgetExpansions: (min: number, max: number, step: number) =>
      `expansions：整数 ${min}–${max} 次，步长 ${step}；超出会被拒绝。`,
    budgetWorkers: (min: number, max: number, step: number, factor: number) =>
      `workers：整数 ${min}–${max} 个，步长 ${step}；还需 expansions ≥ ${factor} × workers，且 expansions 能被 workers 整除。`,
    budgetMaxTokens: (value: number) => `maxTokens：上限 ${value} tokens（服务端固定上限）。`,
    budgetMaxSeconds: (value: number) => `maxSeconds：服务端固定 ${value} 秒，不可设置。`,
    budgetPerCall: (quiet: number, puct: number, openEvolve: number) =>
      `maxTokensPerCall：不可设置，由算法与思考设置决定（关闭思考 ${quiet}、PUCT ${puct}、OpenEvolve ${openEvolve} tokens）。`,
    budgetDerivation: (quiet: number, quietCap: number, puct: number, puctCap: number, openEvolve: number, openEvolveCap: number, total: number) =>
      `每次调用上限 × 展开次数 ≤ 总量：关闭思考 ${quiet} × n ≤ ${total}，最多 ${quietCap} 次；PUCT 思考 ${puct}，最多 ${puctCap} 次；OpenEvolve 思考 ${openEvolve}，最多 ${openEvolveCap} 次。具体上限由检查点 3 的模型与思考设置决定。`,
    budgetDefaults: "expansions 与 workers 由助手按任务给出，没有固定默认值；惯例是 workers 取 1。",
    programFieldHint: (field: string) =>
      `程序字段「${field}」：属于被演进程序的起始 JSON，不会改变本次运行的预算；运行限制参考见上方。`,
    unitCount: "次",
    unitSeconds: "秒",
    unitTokens: "tokens",
  },
  en: {
    title: "Parameters",
    needTask: "Automatic generation is unavailable — upload a JSON file or add parameters manually.",
    draft: "Generate starting values",
    drafting: "Generating…",
    upload: "Upload JSON",
    add: "Add parameter",
    addItem: "Add item",
    empty: "Generate starting parameters from the task, upload a file, or add them directly.",
    name: "Parameter",
    value: "Starting value",
    scope: "Vary",
    remove: "Remove",
    type: "Value type",
    invalid: "Check for empty or duplicate parameter names and invalid numbers.",
    readError: "Could not import the file. Choose a JSON object.",
    draftError: "Could not generate starting parameters. Retry or upload a file.",
    types: ["Text", "Number", "Boolean", "Null", "Object", "Array"],
    budgetTitle: "Run limits for reference (not settings in this panel)",
    budgetPeek: (expMin: number, expMax: number, workerMin: number, workerMax: number, total: number, seconds: number) =>
      `expansions ${expMin}–${expMax} · workers ${workerMin}–${workerMax} · maxTokens cap ${total} tokens · maxSeconds fixed ${seconds} s`,
    budgetIntro: "The assistant sets and shows the run budget at checkpoint 3; the starting parameters below belong to the JSON of the program under evolution and do not change it. The limits below are reference only.",
    budgetExpansions: (min: number, max: number, step: number) =>
      `expansions: whole number ${min}–${max}, step ${step}; a larger value is refused.`,
    budgetWorkers: (min: number, max: number, step: number, factor: number) =>
      `workers: whole number ${min}–${max}, step ${step}; also needs expansions ≥ ${factor} × workers, and expansions divisible by workers.`,
    budgetMaxTokens: (value: number) => `maxTokens: capped at ${value} tokens (server-fixed limit).`,
    budgetMaxSeconds: (value: number) => `maxSeconds: fixed by the server at ${value} seconds; it is not settable.`,
    budgetPerCall: (quiet: number, puct: number, openEvolve: number) =>
      `maxTokensPerCall: not settable, decided by the algorithm and thinking setting (${quiet} with thinking off, ${puct} for PUCT, ${openEvolve} for OpenEvolve tokens).`,
    budgetDerivation: (quiet: number, quietCap: number, puct: number, puctCap: number, openEvolve: number, openEvolveCap: number, total: number) =>
      `Per-call ceiling × expansions ≤ the total: ${quiet} × n ≤ ${total} with thinking off, at most ${quietCap}; PUCT thinking ${puct}, at most ${puctCap}; OpenEvolve thinking ${openEvolve}, at most ${openEvolveCap}. The run's model and thinking setting decide which applies, at checkpoint 3.`,
    budgetDefaults: "The assistant picks expansions and workers from the task; there is no fixed default, and workers usually starts at 1.",
    programFieldHint: (field: string) =>
      `${field} is a program field: it is part of the starting JSON of the evolved program and does not change this run's budget. See the run limits above.`,
    unitCount: "calls",
    unitSeconds: "seconds",
    unitTokens: "tokens",
  },
};
const kinds: Kind[] = ["string", "number", "boolean", "null", "object", "array"];
type Labels = typeof copy.en;

/** The budget fields are shown in the order a design conversation meets them. */
const BUDGET_FIELDS: EvolveBudgetField[] = ["expansions", "workers", "maxTokens", "maxTokensPerCall", "maxSeconds"];

/** One run limit, from the shared table. */
function budgetLimitText(labels: Labels, field: EvolveBudgetField): string {
  const limit = EVOLVE_BUDGET_FIELD_LIMITS[field];
  switch (field) {
    case "expansions":
      return labels.budgetExpansions(limit.min!, limit.max!, limit.step);
    case "workers":
      return labels.budgetWorkers(limit.min!, limit.max!, limit.step, EVOLVE_EXPANSIONS_PER_WORKER);
    case "maxTokens":
      return labels.budgetMaxTokens(limit.fixed!);
    case "maxTokensPerCall":
      return labels.budgetPerCall(EVOLVE_QUIET_TOKENS_PER_CALL, EVOLVE_THINKING_CEILINGS.puct,
        EVOLVE_THINKING_CEILINGS.openevolve);
    case "maxSeconds":
      return labels.budgetMaxSeconds(limit.fixed!);
  }
}

/** The one-line summary a collapsed reference block still shows. */
function peekText(labels: Labels): string {
  const expansions = EVOLVE_BUDGET_FIELD_LIMITS.expansions;
  const workers = EVOLVE_BUDGET_FIELD_LIMITS.workers;
  return labels.budgetPeek(expansions.min!, expansions.max!, workers.min!, workers.max!,
    EVOLVE_MAX_TOKENS, EVOLVE_BUDGET_FIELD_LIMITS.maxSeconds.fixed!);
}

/** The three expansion caps the per-call ceilings leave inside the total. */
function derivationText(labels: Labels): string {
  const quiet = EVOLVE_QUIET_TOKENS_PER_CALL;
  const puct = EVOLVE_THINKING_CEILINGS.puct;
  const openEvolve = EVOLVE_THINKING_CEILINGS.openevolve;
  return labels.budgetDerivation(quiet, evolveExpansionCeiling(quiet),
    puct, evolveExpansionCeiling(puct),
    openEvolve, evolveExpansionCeiling(openEvolve),
    EVOLVE_MAX_TOKENS);
}

function ValueEditor({ describedBy, labels, name, value, onChange }: {
  describedBy?: string;
  labels: Labels;
  name: string;
  value: Value;
  onChange: (next: Value) => void;
}) {
  const { kind, text, rows } = value;
  const setText = (next: string) => onChange({ ...value, text: next });
  const update = (id: number, next?: Row) => onChange({ ...value, rows: rows.flatMap((row) => row.id === id ? next ? [next] : [] : [row]) });
  let input: ReactNode;
  switch (kind) {
    case "object":
    case "array":
      input = <details className="evolve-json-nested">
        <summary aria-describedby={describedBy}>{kind === "object" ? "{…}" : "[…]"} · {rows.length}</summary>
        <div className="evolve-json-children">{rows.map((row) => <div key={row.id} className="evolve-json-child">
          {kind === "object" ? <input aria-label={labels.name} value={row.name} onChange={(event) => update(row.id, { ...row, name: event.target.value })} /> : null}
          <ValueEditor labels={labels} name={row.name || labels.value} value={row.value} onChange={(child) => update(row.id, { ...row, value: child })} />
          <button aria-label={labels.remove} type="button" onClick={() => update(row.id)}>×</button>
        </div>)}
        <button type="button" onClick={() => onChange({ ...value, rows: [...rows, makeRow("", "")] })}>＋ {kind === "object" ? labels.add : labels.addItem}</button></div>
      </details>;
      break;
    case "boolean":
      input = <select aria-describedby={describedBy} aria-label={name} value={text} onChange={(event) => setText(event.target.value)}><option value="true">true</option><option value="false">false</option></select>;
      break;
    case "null":
      input = <span>null</span>;
      break;
    default:
      input = <input aria-describedby={describedBy} aria-label={name} type={kind === "number" ? "number" : "text"}
        step={kind === "number" ? "any" : undefined} value={text} onChange={(event) => setText(event.target.value)} />;
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
  /** Collapsed by default: the fields are what the panel is for, and a full
   *  rule list above them pushed the editor off the first screen (#1346). */
  const [budgetOpen, setBudgetOpen] = useState(false);
  const budgetBlock = useRef<HTMLDetailsElement>(null);
  const controller = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => controller.current?.abort(), []);
  // Opening the reference is a request to read it: bring the rules that were
  // below the fold into view, without moving the panel more than necessary.
  useEffect(() => {
    if (!budgetOpen) return;
    budgetBlock.current?.querySelector(".evolve-json-budget-body")?.scrollIntoView({ block: "nearest" });
  }, [budgetOpen]);
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
    <header className="evolve-json-header"><div><h3 id={id}>{labels.title}</h3></div>
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
    {/* The run's budget is a different thing from the starting values, and the
        dialog states its real limits rather than leaving the user to read a
        finished run's record to discover them. Folded by default so the editor
        stays on the first screen; the summary already carries the bounds. */}
    <details
      className="evolve-json-budget"
      onToggle={(event) => setBudgetOpen(event.currentTarget.open)}
      open={budgetOpen}
      ref={budgetBlock}
    >
      <summary>
        <h4 id={`${id}-budget-title`}>{labels.budgetTitle}</h4>
        <span className="evolve-json-budget-peek">{peekText(labels)}</span>
      </summary>
      <div
        aria-labelledby={`${id}-budget-title`}
        className="evolve-json-budget-body"
        role="note"
      >
        <p>{labels.budgetIntro}</p>
        <ul>
          {BUDGET_FIELDS.map((field) => <li data-budget-field={field} key={field}>{budgetLimitText(labels, field)}</li>)}
        </ul>
        <p className="evolve-json-budget-derivation" data-budget-derivation="expansions">{derivationText(labels)}</p>
        <p className="evolve-json-budget-defaults">{labels.budgetDefaults}</p>
      </div>
    </details>
    {/* `onGenerate` is absent while the setup dialog has no session detail to
        draft from or no task text yet — App.tsx hands it over only when both
        exist — so the hint names what the user can do instead. */}
    {!onGenerate ? <p className="evolve-json-file">{labels.needTask}</p> : null}
    {fileName ? <p className="evolve-json-file">{fileName}</p> : null}
    {error ? <p role="alert" className="evolve-json-error">{error === "read" ? labels.readError : error === "draft" ? labels.draftError : labels.invalid}</p> : null}
    <fieldset disabled={busy} className="evolve-json-fieldset">
      {rows.length ? <div className="evolve-json-list">
        <div aria-hidden="true" className="evolve-json-column-labels"><span>{labels.scope}</span><span>{labels.name}</span><span>{labels.value}</span></div>
        {rows.map((row) => {
          const budget = evolveBudgetField(row.name);
          const hintId = `${id}-${row.id}-budget`;
          return <div className="evolve-json-row" data-budget-field={budget} data-editable={row.editable} key={row.id}>
            <input aria-label={row.name ? `${labels.scope} ${row.name}` : labels.scope} type="checkbox" checked={row.editable}
              disabled={!row.editable && selected >= EVOLVE_EDITABLE_LIMIT} onChange={(event) => changeRow(row.id, { ...row, editable: event.target.checked })} />
            <input aria-label={labels.name} placeholder={labels.name} value={row.name} onChange={(event) =>
              changeRow(row.id, { ...row, name: event.target.value })} />
            <ValueEditor
              describedBy={budget === undefined ? undefined : hintId}
              labels={labels}
              name={row.name || labels.value}
              value={row.value}
              onChange={(node) => changeRow(row.id, { ...row, value: node })}
            />
            <button className="evolve-json-remove" aria-label={row.name ? `${labels.remove} ${row.name}` : labels.remove}
              type="button" onClick={() => apply(rows.filter((item) => item.id !== row.id))}>×</button>
            {/* A program field that shares a run-budget name says so, and
                repeats where the real limit is. It never validates or blocks:
                a candidate may legitimately have a field called `expansions`. */}
            {budget === undefined ? null : <p className="evolve-json-param-hint" data-param-field={budget} id={hintId}>
              {labels.programFieldHint(budget)}
            </p>}
          </div>;
        })}
      </div> : <p className="evolve-json-empty">{labels.empty}</p>}
      <footer className="evolve-json-footer"><button type="button" onClick={() => apply([...rows, makeRow("", "")])}>＋ {labels.add}</button>
        <span role="status">{chinese ? `已参与搜索 ${selected} 项` : `${selected} in search`}</span>
      </footer>
    </fieldset>
  </section>;
}
