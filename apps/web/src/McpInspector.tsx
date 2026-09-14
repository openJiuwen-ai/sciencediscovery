// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
// http://www.apache.org/licenses/LICENSE-2.0
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useEffect, useRef, useState, type FormEvent } from "react";
import { ArrowLeft, Play } from "lucide-react";
import type { CustomMcpServerDetails, JsonValue, McpInspectorResult } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/index.js";
import { AlertCircleIcon, CheckIcon, SpinnerIcon, StopIcon } from "./icons.js";
import { CopyButton } from "./CopyButton.js";
import { MarkdownRenderer } from "./Markdown.js";

function initialInput(schema: Record<string, unknown>): string {
  const properties = schema.properties && typeof schema.properties === "object" ? schema.properties as Record<string, Record<string, unknown>> : {};
  const required = Array.isArray(schema.required) ? schema.required : [];
  return JSON.stringify(Object.fromEntries(required.map((key) => {
    const property = properties[String(key)] ?? {};
    return [key, property.default ?? (property.type === "number" || property.type === "integer" ? 0 : property.type === "boolean" ? false : property.type === "array" ? [] : property.type === "object" ? {} : "")];
  })), null, 2);
}

export function McpInspector({ server, sessionId, sessionTitle, client, onBack }: {
  server: CustomMcpServerDetails;
  sessionId?: string;
  sessionTitle?: string;
  client: Pick<ApiClient, "inspectMcpTool">;
  onBack: () => void;
}) {
  const { t } = useLocale();
  const [toolName, setToolName] = useState(server.tools[0]?.name ?? "");
  const tool = server.tools.find((item) => item.name === toolName);
  const [input, setInput] = useState(() => initialInput(tool?.inputSchema ?? {}));
  const [result, setResult] = useState<McpInspectorResult>();
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [view, setView] = useState<"raw" | "normalized">("raw");
  const abort = useRef<AbortController | undefined>(undefined);
  useEffect(() => () => abort.current?.abort(), []);

  async function execute(event: FormEvent): Promise<void> {
    event.preventDefault();
    if (!sessionId || !tool || busy || !server.enabled) return;
    setError(undefined); setResult(undefined);
    let parameters: JsonValue;
    try { parameters = JSON.parse(input) as JsonValue; } catch { setError(t("mcp.invalidJson")); return; }
    if (!parameters || typeof parameters !== "object" || Array.isArray(parameters)) { setError(t("mcp.inputObject")); return; }
    const controller = new AbortController();
    abort.current = controller;
    setBusy(true);
    try { setResult(await client.inspectMcpTool(server.id, { sessionId, toolName, input: parameters }, controller.signal)); }
    catch (reason) { setError(controller.signal.aborted ? t("mcp.cancelled") : reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); abort.current = undefined; }
  }

  const output = result ? JSON.stringify(view === "raw" ? result.raw ?? { error: result.error } : result.result ?? { error: result.error }, null, 2) : "";
  return <div className="mcp-inspector">
    <div className="mcp-section-heading"><button className="text-button mcp-inline-command" type="button" disabled={busy} onClick={onBack}><ArrowLeft size={15} />{t("mcp.back")}</button><strong>MCP Inspector</strong></div>
    <h4 title={server.name}>{server.name}</h4>
    <div className="mcp-inspector-session" title={sessionTitle ?? sessionId}>{t("mcp.auditSession")}: {sessionTitle ?? sessionId ?? t("mcp.noSession")}</div>
    <form className="model-editor" onSubmit={(event) => void execute(event)}>
      <label><span>{t("mcp.selectTool")}</span><select aria-label={t("mcp.selectTool")} value={toolName} disabled={busy} onChange={(event) => {
        const name = event.target.value;
        setToolName(name);
        setInput(initialInput(server.tools.find((item) => item.name === name)?.inputSchema ?? {}));
        setResult(undefined);
        setError(undefined);
      }}>{server.tools.map((item) => <option key={item.name} value={item.name}>{item.name}</option>)}</select></label>
      {tool ? <><MarkdownRenderer className="mcp-tool-description" content={tool.description} /><details className="mcp-tool"><summary>{t("mcp.parameters")}</summary><pre>{JSON.stringify(tool.inputSchema, null, 2)}</pre></details></> : null}
      <label><span>{t("mcp.argumentsJson")}</span><textarea aria-label={t("mcp.argumentsJson")} rows={7} spellCheck={false} disabled={busy} value={input} onChange={(event) => setInput(event.target.value)} /></label>
      {!sessionId ? <div className="mcp-feedback error">{t("mcp.noSession")}</div> : !server.enabled ? <div className="mcp-feedback error">{t("mcp.enableBeforeCall")}</div> : null}
      <div className="mcp-form-actions">{busy ? <button type="button" className="secondary-button" onClick={() => abort.current?.abort()}><StopIcon size={14} />{t("common.cancel")}</button> : null}<button className="primary-button" type="submit" disabled={busy || !sessionId || !tool || !server.enabled}>{busy ? <SpinnerIcon className="spin" size={15} /> : <Play size={15} />}{busy ? t("mcp.executing") : t("mcp.execute")}</button></div>
    </form>
    {error ? <div className="mcp-feedback error" role="alert"><AlertCircleIcon size={15} /><span>{error}</span></div> : null}
    {result ? <section className="mcp-inspector-result">
      <div className={`mcp-feedback ${result.ok ? "success" : "error"}`} role="status">{result.ok ? <CheckIcon size={15} /> : <AlertCircleIcon size={15} />}<span>{result.ok ? t("mcp.callPassed") : t("mcp.callFailed")} · {result.durationMs} ms{result.error ? ` · ${result.error}` : ""}</span></div>
      <div className="mcp-result-toolbar"><div className="mcp-tabs" role="tablist" aria-label={t("mcp.result")}><button role="tab" aria-selected={view === "raw"} type="button" onClick={() => setView("raw")}>{t("mcp.rawResult")}</button><button role="tab" aria-selected={view === "normalized"} type="button" onClick={() => setView("normalized")}>{t("mcp.normalizedResult")}</button></div><CopyButton label={t("mcp.copyResult")} getText={() => output} /></div>
      <pre className="mcp-inspector-output" tabIndex={0}>{output}</pre>
      <details className="mcp-invocation-id"><summary>{t("mcp.auditRecord")}</summary><code>{result.invocationId}</code><CopyButton label={t("mcp.copyId")} getText={() => result.invocationId} /></details>
    </section> : null}
  </div>;
}
