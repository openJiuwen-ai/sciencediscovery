// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
// http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import { useEffect, useState } from "react";

import type { ApiClient } from "../../../api/client.js";
import {
  deleteMcpServer,
  listMcpServers,
  listMcpSources,
  saveMcpServer,
  testMcpServer,
} from "../../../api/settings.js";
import type {
  CustomMcpServerDetails,
  CustomMcpServerInput,
  McpSource,
} from "../../../api/types.js";
import type { ConfirmRequest } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { Group, LoadGate, Row, Select, Tag } from "../rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  onToast: (message: string) => void;
}

/** One secret slot. A saved key keeps `originalKey` and an empty value, which
 *  the server reads as "keep the stored secret"; typing a value replaces it. */
interface SecretRow {
  key: string;
  originalKey?: string;
  value: string;
}

interface OauthDraft {
  clientId: string;
  clientMetadataUrl: string;
  clientSecret: string;
  scope: string;
}

interface Draft {
  args: string;
  authMode: NonNullable<CustomMcpServerInput["authMode"]>;
  command: string;
  cwd: string;
  description: string;
  enabled: boolean;
  envRows: SecretRow[];
  headerRows: SecretRow[];
  id?: string;
  name: string;
  oauth: OauthDraft;
  savedOauthSecret: boolean;
  timeoutSeconds: string;
  transport: CustomMcpServerInput["transport"];
  url: string;
}

function emptyDraft(): Draft {
  return {
    args: "",
    authMode: "headers",
    command: "",
    cwd: "",
    description: "",
    enabled: true,
    envRows: [],
    headerRows: [],
    name: "",
    oauth: { clientId: "", clientMetadataUrl: "", clientSecret: "", scope: "" },
    savedOauthSecret: false,
    timeoutSeconds: "30",
    transport: "http",
    url: "",
  };
}

function rowsFrom(map: Record<string, null>): SecretRow[] {
  return Object.keys(map).map((key) => ({ key, originalKey: key, value: "" }));
}

function draftOf(server: CustomMcpServerDetails): Draft {
  return {
    args: server.args.join(" "),
    authMode: server.authMode ?? "headers",
    command: server.command,
    cwd: server.cwd,
    description: server.description,
    enabled: server.enabled,
    envRows: rowsFrom(server.env),
    headerRows: rowsFrom(server.headers),
    id: server.id,
    name: server.name,
    oauth: {
      clientId: server.oauth?.clientId ?? "",
      clientMetadataUrl: server.oauth?.clientMetadataUrl ?? "",
      clientSecret: "",
      scope: server.oauth?.scope ?? "",
    },
    savedOauthSecret: server.oauth?.clientSecret === null,
    timeoutSeconds: String(server.timeoutSeconds),
    transport: server.transport,
    url: server.url,
  };
}

/** `null` keeps a saved secret; a typed value replaces it. An unchanged key
 *  therefore never has to resend the secret it never saw. */
function secretMap(rows: SecretRow[]): Record<string, string | null> {
  return Object.fromEntries(rows.map((row) => {
    const key = row.key.trim();
    const keep = row.value === "" && row.originalKey === key;
    return [key, keep ? null : row.value];
  }));
}

/** The server rejects a renamed key without a value, and a duplicate or blank
 *  key; catching it here names the row instead of failing the whole write. */
function secretProblem(rows: SecretRow[]): string | undefined {
  const keys = rows.map((row) => row.key.trim());
  if (keys.some((key) => key === "")) return TEXT.settings.system.mcp.secretKeyEmpty;
  if (new Set(keys).size !== keys.length) return TEXT.settings.system.mcp.secretKeyDuplicate;
  if (rows.some((row) => row.originalKey !== undefined && row.originalKey !== row.key.trim() && row.value === "")) {
    return TEXT.settings.system.mcp.secretRenameRequired;
  }
  return undefined;
}

function inputOf(draft: Draft): CustomMcpServerInput {
  const stdio = draft.transport === "stdio";
  return {
    args: draft.args.split(/\s+/).filter(Boolean),
    authMode: stdio ? "headers" : draft.authMode,
    command: draft.command.trim(),
    cwd: draft.cwd.trim(),
    description: draft.description.trim(),
    enabled: draft.enabled,
    env: stdio ? secretMap(draft.envRows) : {},
    headers: stdio ? {} : secretMap(draft.headerRows),
    name: draft.name.trim(),
    ...(stdio ? {} : {
      oauth: {
        ...draft.oauth,
        clientSecret: draft.oauth.clientSecret === "" && draft.savedOauthSecret
          ? null
          : draft.oauth.clientSecret,
      },
    }),
    timeoutSeconds: Math.max(1, Number(draft.timeoutSeconds) || 30),
    transport: draft.transport,
    url: draft.url.trim(),
  };
}

const STATUS_TONE: Record<CustomMcpServerDetails["status"], string> = {
  disabled: "off",
  error: "warn",
  ready: "ok",
  untested: "off",
};

/** Both the custom-server statuses and the catalog statuses are fixed
 *  vocabularies; only the ones this screen can show are translated, and an
 *  unknown value is printed rather than silently hidden. */
function statusLabel(status: string): string {
  const text = TEXT.settings.system.mcp;
  switch (status) {
    case "ready": return text.statusReady;
    case "error": return text.statusError;
    case "disabled": return text.statusDisabled;
    case "untested": return text.statusUntested;
    case "degraded": return text.statusDegraded;
    case "misconfigured": return text.statusMisconfigured;
    case "unavailable": return text.statusUnavailable;
    default: return status;
  }
}

function catalogTone(status: string): string {
  if (status === "ready") return "ok";
  if (status === "disabled") return "off";
  return "warn";
}

/**
 * MCP 服务器: the custom servers registered on this machine and the built-in
 * catalog the product ships with.
 *
 * A server is written whole, so enabling one resends the record with `enabled`
 * flipped. Secrets are write-only: saved slots come back as keys with null
 * values, and this form sends them back untouched unless a value is typed.
 */
export function McpServers({ client, onConfirm, onToast }: Props) {
  const loaded = useLoaded<CustomMcpServerDetails[]>(async () => listMcpServers(client));
  const sources = useLoaded<McpSource[]>(async () => listMcpSources(client));
  const [tab, setTab] = useState<"custom" | "builtin">("custom");
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => setFailure(undefined), [draft]);

  const write = async (server: CustomMcpServerDetails, body: CustomMcpServerInput) => {
    setBusy(true);
    setFailure(undefined);
    try {
      await saveMcpServer(client, body, server.id);
      loaded.reload();
      onToast(TEXT.settings.system.mcp.saved);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!draft || draft.name.trim() === "") return;
    const problem = draft.transport === "stdio" ? secretProblem(draft.envRows) : secretProblem(draft.headerRows);
    if (problem !== undefined) {
      setFailure(problem);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await saveMcpServer(client, inputOf(draft), draft.id);
      setDraft(undefined);
      loaded.reload();
      onToast(TEXT.settings.system.mcp.saved);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const builtins = (sources.value ?? []).filter((source) => !source.manifest.id.startsWith("custom-"));
  const change = (patch: Partial<Draft>) => setDraft((current) => current ? { ...current, ...patch } : current);

  return (
    <>
      <div aria-label={TEXT.settings.system.mcp.heading} className="settings-tabs" role="tablist">
        <button
          aria-selected={tab === "custom"}
          onClick={() => setTab("custom")}
          role="tab"
          type="button"
        >
          {TEXT.settings.system.mcp.custom} <span>{loaded.value?.length ?? 0}</span>
        </button>
        <button
          aria-selected={tab === "builtin"}
          onClick={() => setTab("builtin")}
          role="tab"
          type="button"
        >
          {TEXT.settings.system.mcp.builtin} <span>{builtins.length}</span>
        </button>
      </div>

      {tab === "custom" ? (
        <>
          <Group>
            <LoadGate loaded={loaded}>
              {(servers) => (
                <>
                  {servers.length === 0 ? (
                    <p className="settings-empty">{TEXT.settings.system.mcp.empty}</p>
                  ) : (
                    <div className="settings-list">
                      {servers.map((server) => (
                        <div className="settings-card" key={server.id}>
                          <span className="settings-card-mark">{server.name.slice(0, 1).toUpperCase()}</span>
                          <div className="settings-card-main">
                            <strong>
                              {server.name}
                              <Tag tone={STATUS_TONE[server.status]}>{statusLabel(server.status)}</Tag>
                              <Tag tone="off">{TEXT.settings.system.mcp.toolCount(server.tools.length)}</Tag>
                            </strong>
                            <small>
                              {server.transport} · {server.transport === "stdio" ? server.command : server.url}
                              {server.error ? ` · ${server.error}` : ""}
                            </small>
                          </div>
                          <div className="settings-card-actions">
                            <button
                              className="link-button"
                              disabled={busy}
                              onClick={() => void write(server, { ...inputOf(draftOf(server)), enabled: !server.enabled })}
                              type="button"
                            >
                              {server.enabled ? TEXT.settings.system.mcp.disable : TEXT.settings.system.mcp.enable}
                            </button>
                            <button
                              className="link-button"
                              disabled={busy}
                              onClick={() => {
                                setBusy(true);
                                void testMcpServer(client, server.id)
                                  .then((next) => {
                                    loaded.reload();
                                    onToast(next.error ?? TEXT.settings.system.mcp.tested(next.status));
                                  })
                                  .catch((reason: unknown) => {
                                    setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
                                  })
                                  .finally(() => setBusy(false));
                              }}
                              type="button"
                            >
                              {TEXT.settings.system.mcp.test}
                            </button>
                            <button
                              className="link-button"
                              disabled={busy}
                              onClick={() => setDraft(draftOf(server))}
                              type="button"
                            >
                              {TEXT.settings.edit}
                            </button>
                            <button
                              className="link-button is-danger"
                              disabled={busy}
                              onClick={() => onConfirm({
                                accept: TEXT.menu.delete,
                                body: TEXT.settings.system.mcp.deleteBody(server.name),
                                eyebrow: TEXT.settings.system.mcp.heading,
                                onAccept: () => {
                                  void deleteMcpServer(client, server.id)
                                    .then(() => loaded.reload())
                                    .catch((reason: unknown) => {
                                      setFailure(reason instanceof Error ? reason.message : TEXT.errors.generic);
                                    });
                                },
                                title: TEXT.settings.system.mcp.deleteTitle(server.name),
                              })}
                              type="button"
                            >
                              {TEXT.menu.delete}
                            </button>
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </>
              )}
            </LoadGate>
            <div className="settings-actions">
              <button className="secondary-button" onClick={() => setDraft(emptyDraft())} type="button">
                {TEXT.settings.system.mcp.add}
              </button>
            </div>
          </Group>

          {draft ? (
            <section className="settings-card is-form">
              <div className="settings-card-form">
                <Row title={TEXT.settings.system.mcp.enable}>
                  <label className="settings-check">
                    <input
                      checked={draft.enabled}
                      onChange={(event) => change({ enabled: event.target.checked })}
                      type="checkbox"
                    />
                    <span>{TEXT.settings.system.mcp.enabled}</span>
                  </label>
                </Row>
                <Row title={TEXT.settings.system.mcp.name}>
                  <input
                    className="field-input"
                    onChange={(event) => change({ name: event.target.value })}
                    value={draft.name}
                  />
                </Row>
                <Row title={TEXT.settings.system.mcp.description}>
                  <input
                    className="field-input"
                    onChange={(event) => change({ description: event.target.value })}
                    value={draft.description}
                  />
                </Row>
                <Row title={TEXT.settings.system.mcp.transport}>
                  <Select
                    label={TEXT.settings.system.mcp.transport}
                    onChange={(value) => change({ transport: value as Draft["transport"] })}
                    options={[
                      { label: "Streamable HTTP", value: "http" },
                      { label: "SSE", value: "sse" },
                      { label: "STDIO", value: "stdio" },
                    ]}
                    value={draft.transport}
                  />
                </Row>
                {draft.transport === "stdio" ? (
                  <>
                    <Row title={TEXT.settings.system.mcp.command}>
                      <input
                        className="field-input"
                        onChange={(event) => change({ command: event.target.value })}
                        value={draft.command}
                      />
                    </Row>
                    <Row hint={TEXT.settings.system.mcp.argsHint} title={TEXT.settings.system.mcp.args}>
                      <input
                        className="field-input"
                        onChange={(event) => change({ args: event.target.value })}
                        value={draft.args}
                      />
                    </Row>
                    <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.cwd}>
                      <input
                        className="field-input"
                        onChange={(event) => change({ cwd: event.target.value })}
                        value={draft.cwd}
                      />
                    </Row>
                    <SecretFields
                      label={TEXT.settings.system.mcp.env}
                      onChange={(envRows) => change({ envRows })}
                      rows={draft.envRows}
                    />
                  </>
                ) : (
                  <>
                    <Row title={TEXT.settings.system.mcp.url}>
                      <input
                        className="field-input"
                        onChange={(event) => change({ url: event.target.value })}
                        value={draft.url}
                      />
                    </Row>
                    <Row title={TEXT.settings.system.mcp.authMode}>
                      <Select
                        label={TEXT.settings.system.mcp.authMode}
                        onChange={(value) => change({ authMode: value as Draft["authMode"] })}
                        options={[
                          { label: TEXT.settings.system.mcp.authHeaders, value: "headers" },
                          { label: TEXT.settings.system.mcp.authOauth, value: "oauth" },
                        ]}
                        value={draft.authMode}
                      />
                    </Row>
                    {draft.authMode === "oauth" ? (
                      <>
                        <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.clientId}>
                          <input
                            className="field-input"
                            onChange={(event) => change({
                              oauth: { ...draft.oauth, clientId: event.target.value },
                            })}
                            value={draft.oauth.clientId}
                          />
                        </Row>
                        <Row
                          hint={draft.savedOauthSecret
                            ? TEXT.settings.system.mcp.secretSaved
                            : TEXT.settings.system.mcp.optional}
                          title={TEXT.settings.system.mcp.clientSecret}
                        >
                          <input
                            autoComplete="off"
                            className="field-input"
                            onChange={(event) => change({
                              oauth: { ...draft.oauth, clientSecret: event.target.value },
                            })}
                            type="password"
                            value={draft.oauth.clientSecret}
                          />
                        </Row>
                        <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.scope}>
                          <input
                            className="field-input"
                            onChange={(event) => change({
                              oauth: { ...draft.oauth, scope: event.target.value },
                            })}
                            value={draft.oauth.scope}
                          />
                        </Row>
                        <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.metadataUrl}>
                          <input
                            className="field-input"
                            onChange={(event) => change({
                              oauth: { ...draft.oauth, clientMetadataUrl: event.target.value },
                            })}
                            value={draft.oauth.clientMetadataUrl}
                          />
                        </Row>
                        <Row title={TEXT.settings.system.mcp.callback}>
                          <input
                            className="field-input"
                            readOnly
                            value={`${window.location.origin}/api/mcp/oauth/callback`}
                          />
                        </Row>
                      </>
                    ) : null}
                    <SecretFields
                      label={TEXT.settings.system.mcp.headers}
                      onChange={(headerRows) => change({ headerRows })}
                      rows={draft.headerRows}
                    />
                  </>
                )}
                <Row title={TEXT.settings.system.mcp.timeout}>
                  <input
                    className="field-input is-number"
                    min="1"
                    onChange={(event) => change({ timeoutSeconds: event.target.value })}
                    type="number"
                    value={draft.timeoutSeconds}
                  />
                </Row>
                <div className="settings-card-actions">
                  <button className="secondary-button" onClick={() => setDraft(undefined)} type="button">
                    {TEXT.settings.cancel}
                  </button>
                  <button className="primary-button" disabled={busy} onClick={() => void submit()} type="button">
                    {TEXT.settings.system.save}
                  </button>
                </div>
              </div>
            </section>
          ) : null}
        </>
      ) : (
        <Group heading={TEXT.settings.system.mcp.builtinHeading}>
          <p className="settings-note">{TEXT.settings.system.mcp.builtinHint}</p>
          <LoadGate loaded={sources}>
            {(list) => {
              const sourcesOnly = list.filter((source) => !source.manifest.id.startsWith("custom-"));
              return sourcesOnly.length === 0 ? (
                <p className="settings-empty">{TEXT.settings.system.mcp.builtinEmpty}</p>
              ) : (
                <div className="settings-list">
                  {sourcesOnly.map((source) => {
                    const tools = Object.values(source.manifest.tools ?? {});
                    return (
                      <details className="settings-builtin" key={source.manifest.id}>
                        <summary>
                          <strong>{source.manifest.displayName ?? source.manifest.id}</strong>
                          <Tag tone="off">{TEXT.settings.system.mcp.toolCount(tools.length)}</Tag>
                          <Tag tone={catalogTone(source.status.status)}>
                            {statusLabel(source.status.status)}
                          </Tag>
                        </summary>
                        {source.manifest.description ? (
                          <p className="settings-note">{source.manifest.description}</p>
                        ) : null}
                        <ul className="settings-builtin-tools">
                          {tools.map((tool) => (
                            <li key={tool.id}>
                              <code>{tool.id}</code>
                              {tool.description ? <small>{tool.description}</small> : null}
                            </li>
                          ))}
                        </ul>
                      </details>
                    );
                  })}
                </div>
              );
            }}
          </LoadGate>
        </Group>
      )}

      {failure ? <small className="row-note is-error">{failure}</small> : null}
    </>
  );
}

/** Key/value slots for `env` and `headers`. Saved keys show as empty password
 *  fields whose placeholder says the value is stored. */
function SecretFields({
  label,
  onChange,
  rows,
}: {
  label: string;
  onChange: (rows: SecretRow[]) => void;
  rows: SecretRow[];
}) {
  return (
    <div className="mcp-secret-fields">
      <strong>{label}</strong>
      {rows.map((row, index) => (
        <div className="mcp-secret-row" key={index}>
          <input
            aria-label={`${label} ${TEXT.settings.system.mcp.key} ${index + 1}`}
            className="field-input"
            onChange={(event) => onChange(rows.map((item, itemIndex) =>
              itemIndex === index ? { ...item, key: event.target.value } : item))}
            placeholder={TEXT.settings.system.mcp.key}
            value={row.key}
          />
          <input
            aria-label={`${label} ${TEXT.settings.system.mcp.value} ${index + 1}`}
            autoComplete="off"
            className="field-input"
            onChange={(event) => onChange(rows.map((item, itemIndex) =>
              itemIndex === index ? { ...item, value: event.target.value } : item))}
            placeholder={row.originalKey === row.key.trim() && row.value === ""
              ? TEXT.settings.system.mcp.secretSaved
              : TEXT.settings.system.mcp.value}
            type="password"
            value={row.value}
          />
          <button
            aria-label={TEXT.settings.system.mcp.removeEntry}
            className="link-button is-danger"
            onClick={() => onChange(rows.filter((_, itemIndex) => itemIndex !== index))}
            type="button"
          >
            {TEXT.menu.delete}
          </button>
        </div>
      ))}
      <button
        className="secondary-button"
        onClick={() => onChange([...rows, { key: "", value: "" }])}
        type="button"
      >
        {TEXT.settings.system.mcp.addEntry}
      </button>
    </div>
  );
}
