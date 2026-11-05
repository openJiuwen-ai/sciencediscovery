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

import type { ConnectorId } from "@sciencediscovery/schema";

import type { ApiClient } from "../../../api/client.js";
import {
  deleteMcpServer,
  getGlobalSettings,
  listMcpServers,
  listMcpSources,
  putGlobalSettings,
  saveMcpServer,
  testMcpServer,
} from "../../../api/settings.js";
import type {
  CustomMcpServerDetails,
  CustomMcpServerInput,
  McpSource,
  RuntimeSettingsOverrides,
} from "../../../api/types.js";
import type { ConfirmRequest } from "../../../app/use-workspace.js";
import { useLoaded } from "../../../app/use-loaded.js";
import { TEXT } from "../../../text.js";
import { SettingsModal } from "../SettingsModal.js";
import { Group, LoadGate, Row, Select, Tag } from "../rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  onToast: (message: string) => void;
}

interface Page {
  /** Built-in data sources from the server catalog. */
  builtins: McpSource[];
  /** Custom MCP servers registered on this machine. */
  custom: CustomMcpServerDetails[];
  /** Current global overrides so we can write a field-sparing update. */
  overrides: RuntimeSettingsOverrides;
  /** The effective default selection at this layer. */
  enabledConnectorIds: ConnectorId[];
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

function sourceStatusTone(status: string): string {
  if (status === "ready") return "ok";
  if (status === "disabled" || status === "untested") return "off";
  return "warn";
}

function initialOf(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/**
 * 数据源设置：选择会话默认使用的数据源。
 *
 * 内置来源和自定义 MCP 都通过全局 `enabledConnectorIds` 管理是否默认选用；
 * 自定义服务的连接状态仍由各自的 `enabled` 字段控制，二者相互独立。
 */
export function McpServers({ client, onConfirm, onToast }: Props) {
  const loaded = useLoaded<Page>(async () => {
    const [servers, sources, settings] = await Promise.all([
      listMcpServers(client),
      listMcpSources(client),
      getGlobalSettings(client),
    ]);
    const effective = settings.effective as { enabledConnectorIds?: ConnectorId[] } | undefined;
    return {
      builtins: sources.filter((source) => !source.manifest.id.startsWith("custom-")),
      custom: servers,
      overrides: settings.overrides,
      enabledConnectorIds: effective?.enabledConnectorIds ?? ["web"],
    };
  });
  const [draft, setDraft] = useState<Draft>();
  const [openId, setOpenId] = useState<string>();
  const [busy, setBusy] = useState(false);
  const [failure, setFailure] = useState<string>();

  useEffect(() => setFailure(undefined), [draft]);

  // Only a saved server opens the form, so there is never an empty draft: the
  // record being edited is the source of every field.
  const current = draft;
  const editing = current?.id !== undefined;
  const change = (patch: Partial<Draft>) =>
    setDraft((previous) => ({ ...(previous ?? emptyDraft()), ...patch }));

  const closeForm = () => setDraft(undefined);

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

  /** Toggle whether a data source is selected by default for new sessions. */
  const toggleDefaultUse = async (id: string) => {
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const selected = new Set(page.enabledConnectorIds);
      const next = selected.has(id)
        ? page.enabledConnectorIds.filter((value) => value !== id)
        : [...page.enabledConnectorIds, id];
      await putGlobalSettings(client, {
        ...page.overrides,
        enabledConnectorIds: next as ConnectorId[],
      });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /** Select or clear every visible data source. Only the default selection
   *  list changes; custom server connection settings are untouched. */
  const setAllSelected = async (next: boolean) => {
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      const ids = new Set([...page.enabledConnectorIds]);
      for (const source of page.builtins) {
        if (next) ids.add(source.manifest.id);
        else ids.delete(source.manifest.id);
      }
      for (const server of page.custom) {
        if (next) ids.add(server.id);
        else ids.delete(server.id);
      }
      await putGlobalSettings(client, {
        ...page.overrides,
        enabledConnectorIds: [...ids] as ConnectorId[],
      });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const submit = async () => {
    if (!current || current.name.trim() === "") return;
    const problem = current.transport === "stdio"
      ? secretProblem(current.envRows)
      : secretProblem(current.headerRows);
    if (problem !== undefined) {
      setFailure(problem);
      return;
    }
    setBusy(true);
    setFailure(undefined);
    try {
      await saveMcpServer(client, inputOf(current), current.id);
      closeForm();
      loaded.reload();
      onToast(TEXT.settings.system.mcp.saved);
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  const isSelected = (id: string) => {
    const page = loaded.value;
    return page ? page.enabledConnectorIds.includes(id as ConnectorId) : false;
  };

  return (
    <>
      <p className="settings-note">{TEXT.settings.system.mcp.help}</p>

      <LoadGate loaded={loaded}>
        {(page) => {
          const hasItems = page.builtins.length > 0 || page.custom.length > 0;
          return (
            <Group>
              {!hasItems ? (
                <p className="settings-empty">{TEXT.settings.system.mcp.empty}</p>
              ) : (
                <div className="settings-list">
                  <div className="settings-bulk">
                    <button
                      className="bulk-button"
                      disabled={busy}
                      onClick={() => void setAllSelected(true)}
                      type="button"
                    >
                      {TEXT.settings.system.mcp.selectAll}
                    </button>
                    <button
                      className="bulk-button"
                      disabled={busy}
                      onClick={() => void setAllSelected(false)}
                      type="button"
                    >
                      {TEXT.settings.system.mcp.clearSelection}
                    </button>
                  </div>

                  {page.custom.length > 0 ? (
                    <>
                      <h4 className="settings-subheading">{TEXT.settings.system.mcp.customHeading}</h4>
                      {page.custom.map((server) => {
                        const status = server.status;
                        return (
                          <div className="settings-card" key={server.id}>
                            <span className="settings-card-mark">{initialOf(server.name)}</span>
                            <div className="settings-card-main">
                              <strong>
                                {server.name}
                                <Tag tone={STATUS_TONE[status]}>{statusLabel(status)}</Tag>
                                <Tag tone="off">{TEXT.settings.system.mcp.toolCount(server.tools.length)}</Tag>
                              </strong>
                              {server.description ? <small>{server.description}</small> : null}
                              <small className={server.description ? "settings-detail-meta" : undefined}>
                                {server.transport} · {server.transport === "stdio" ? server.command : server.url}
                                {server.error ? ` · ${server.error}` : ""}
                              </small>
                            </div>
                            <div className="settings-card-actions">
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
                              <label className="settings-check">
                                <input
                                  checked={isSelected(server.id)}
                                  disabled={busy}
                                  onChange={() => void toggleDefaultUse(server.id)}
                                  type="checkbox"
                                />
                                <span>{TEXT.settings.system.mcp.useByDefault}</span>
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  ) : null}

                  {page.builtins.length > 0 ? (
                    <>
                      <h4 className="settings-subheading">{TEXT.settings.system.mcp.builtinHeading}</h4>
                      {page.builtins.map((source) => {
                        const open = openId === source.manifest.id;
                        const selected = page.enabledConnectorIds.includes(source.manifest.id as ConnectorId);
                        const tools = Object.values(source.manifest.tools ?? {});
                        const meta = [
                          source.manifest.publisher,
                          source.manifest.version ? `v${source.manifest.version}` : undefined,
                        ].filter((part) => part !== undefined && part !== "").join(" · ");
                        return (
                          <div
                            className={`settings-card is-expandable${open ? " is-open" : ""}${selected ? "" : " is-off"}`}
                            key={source.manifest.id}
                          >
                            <span className="settings-card-mark">
                              {initialOf(source.manifest.displayName || source.manifest.id)}
                            </span>
                            <button
                              className="settings-card-main"
                              onClick={() => setOpenId(open ? undefined : source.manifest.id)}
                              type="button"
                            >
                              <strong>
                                {source.manifest.displayName || source.manifest.id}
                                <Tag tone="off">{TEXT.settings.system.mcp.builtin}</Tag>
                                <Tag tone={catalogTone(source.status.status)}>
                                  {statusLabel(source.status.status)}
                                </Tag>
                                <Tag tone="off">{TEXT.settings.system.mcp.toolCount(tools.length)}</Tag>
                              </strong>
                              <small>{source.manifest.description || source.manifest.id}</small>
                              {open ? (
                                <span className="settings-detail">
                                  {tools.length === 0 ? null : (
                                    <span className="settings-builtin-tools">
                                      {tools.map((tool) => (
                                        <span key={tool.id}>
                                          <code>{tool.id}</code>
                                          {tool.description ? <small>{tool.description}</small> : null}
                                        </span>
                                      ))}
                                    </span>
                                  )}
                                  {meta === "" ? null : (
                                    <small className="settings-detail-meta">{meta}</small>
                                  )}
                                </span>
                              ) : null}
                            </button>
                            <div className="settings-card-actions">
                              <label className="settings-check">
                                <input
                                  checked={isSelected(source.manifest.id)}
                                  disabled={busy}
                                  onChange={() => void toggleDefaultUse(source.manifest.id)}
                                  type="checkbox"
                                />
                                <span>{TEXT.settings.system.mcp.useByDefault}</span>
                              </label>
                            </div>
                          </div>
                        );
                      })}
                    </>
                  ) : null}
                </div>
              )}
            </Group>
          );
        }}
      </LoadGate>

      {current ? (
        <SettingsModal
          label={TEXT.settings.system.mcp.editTitle}
          onClose={closeForm}
          wide
        >
          <section className="settings-card is-form">
            <div className="settings-card-form">
              <Row title={TEXT.settings.system.mcp.enableService}>
                <label className="settings-check">
                  <input
                    checked={current.enabled}
                    onChange={(event) => change({ enabled: event.target.checked })}
                    type="checkbox"
                  />
                  <span>{TEXT.settings.system.mcp.enableService}</span>
                </label>
              </Row>
              <Row title={TEXT.settings.system.mcp.name}>
                <input
                  className="field-input"
                  onChange={(event) => change({ name: event.target.value })}
                  value={current.name}
                />
              </Row>
              <Row title={TEXT.settings.system.mcp.description}>
                <input
                  className="field-input"
                  onChange={(event) => change({ description: event.target.value })}
                  value={current.description}
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
                  value={current.transport}
                />
              </Row>
              {current.transport === "stdio" ? (
                <>
                  <Row title={TEXT.settings.system.mcp.command}>
                    <input
                      className="field-input"
                      onChange={(event) => change({ command: event.target.value })}
                      value={current.command}
                    />
                  </Row>
                  <Row hint={TEXT.settings.system.mcp.argsHint} title={TEXT.settings.system.mcp.args}>
                    <input
                      className="field-input"
                      onChange={(event) => change({ args: event.target.value })}
                      value={current.args}
                    />
                  </Row>
                  <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.cwd}>
                    <input
                      className="field-input"
                      onChange={(event) => change({ cwd: event.target.value })}
                      value={current.cwd}
                    />
                  </Row>
                  <SecretFields
                    label={TEXT.settings.system.mcp.env}
                    onChange={(envRows) => change({ envRows })}
                    rows={current.envRows}
                  />
                </>
              ) : (
                <>
                  <Row title={TEXT.settings.system.mcp.url}>
                    <input
                      className="field-input"
                      onChange={(event) => change({ url: event.target.value })}
                      value={current.url}
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
                      value={current.authMode}
                    />
                  </Row>
                  {current.authMode === "oauth" ? (
                    <>
                      <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.clientId}>
                        <input
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, clientId: event.target.value },
                          })}
                          value={current.oauth.clientId}
                        />
                      </Row>
                      <Row
                        hint={current.savedOauthSecret
                          ? TEXT.settings.system.mcp.secretSaved
                          : TEXT.settings.system.mcp.optional}
                        title={TEXT.settings.system.mcp.clientSecret}
                      >
                        <input
                          autoComplete="off"
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, clientSecret: event.target.value },
                          })}
                          type="password"
                          value={current.oauth.clientSecret}
                        />
                      </Row>
                      <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.scope}>
                        <input
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, scope: event.target.value },
                          })}
                          value={current.oauth.scope}
                        />
                      </Row>
                      <Row hint={TEXT.settings.system.mcp.optional} title={TEXT.settings.system.mcp.metadataUrl}>
                        <input
                          className="field-input"
                          onChange={(event) => change({
                            oauth: { ...current.oauth, clientMetadataUrl: event.target.value },
                          })}
                          value={current.oauth.clientMetadataUrl}
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
                    rows={current.headerRows}
                  />
                </>
              )}
              <Row title={TEXT.settings.system.mcp.timeout}>
                <input
                  className="field-input is-number"
                  min="1"
                  onChange={(event) => change({ timeoutSeconds: event.target.value })}
                  type="number"
                  value={current.timeoutSeconds}
                />
              </Row>
              {failure ? <small className="row-note is-error">{failure}</small> : null}
              <div className="settings-card-actions">
                <button className="secondary-button" onClick={closeForm} type="button">
                  {TEXT.settings.cancel}
                </button>
                <button className="primary-button" disabled={busy} onClick={() => void submit()} type="button">
                  {TEXT.settings.system.save}
                </button>
              </div>
            </div>
          </section>
        </SettingsModal>
      ) : null}

      {failure && current === undefined ? <small className="row-note is-error">{failure}</small> : null}
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
