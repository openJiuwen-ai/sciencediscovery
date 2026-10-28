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
import { BulkToggles, Group, LoadGate, Row, Select, Switch, Tag } from "../rows.js";

interface Props {
  client: ApiClient;
  onConfirm: (request: ConfirmRequest) => void;
  onToast: (message: string) => void;
}

interface Page {
  /** The product's own servers; read-only here, tools come from the catalog. */
  builtins: McpSource[];
  /** Effective plugin switches, which decide whether a built-in server is on. */
  plugins: Record<string, { enabled?: boolean }>;
  overrides: RuntimeSettingsOverrides;
  servers: CustomMcpServerDetails[];
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

function initialOf(name: string): string {
  return name.slice(0, 1).toUpperCase();
}

/**
 * MCP 服务器: the custom servers registered on this machine and the built-in
 * catalog the product ships with, in the same card list 专家 and 技能 use.
 *
 * A server is written whole, so enabling one resends the record with `enabled`
 * flipped. Secrets are write-only: saved slots come back as keys with null
 * values, and this form sends them back untouched unless a value is typed.
 *
 * A server's 编辑 opens the record in a modal, as 添加模型 does: the list stays
 * in place behind the scrim, and a built-in entry expands in place because it
 * has nothing to edit.
 */
export function McpServers({ client, onConfirm, onToast }: Props) {
  const loaded = useLoaded<Page>(async () => {
    const [servers, sources, settings] = await Promise.all([
      listMcpServers(client),
      listMcpSources(client),
      getGlobalSettings(client),
    ]);
    const effective = settings.effective as
      | { plugins?: Record<string, { enabled?: boolean }> }
      | undefined;
    return {
      builtins: sources.filter((source) => !source.manifest.id.startsWith("custom-")),
      overrides: settings.overrides,
      plugins: effective?.plugins ?? {},
      servers,
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

  /** Built-in servers have no record of their own: their switch is the plugin
   *  override, which starts on because the runtime only hides an explicit
   *  `enabled: false`. The global layer is where the catalog lives. */
  const toggleSource = async (source: McpSource, next: boolean) => {
    const key = `connector.${source.manifest.id}`;
    const overrides = loaded.value?.overrides ?? {};
    setBusy(true);
    setFailure(undefined);
    try {
      await putGlobalSettings(client, {
        ...overrides,
        plugins: {
          ...overrides.plugins,
          [key]: { ...(overrides.plugins?.[key] ?? {}), enabled: next },
        },
      });
      loaded.reload();
    } catch (reason) {
      setFailure(reason instanceof Error ? reason.message : TEXT.settings.saveFailed);
    } finally {
      setBusy(false);
    }
  };

  /** 一键启用 / 一键关闭 over both kinds of server: a custom server's own
   *  `enabled` flag, and a built-in's plugin override. A server is written
   *  whole, so each custom one is resaved from its own record — sequentially,
   *  because some of them reconnect on the way in. */
  const setAll = async (next: boolean) => {
    const page = loaded.value;
    if (!page) return;
    setBusy(true);
    setFailure(undefined);
    try {
      for (const server of page.servers) {
        if (server.enabled === next) continue;
        await saveMcpServer(client, { ...inputOf(draftOf(server)), enabled: next }, server.id);
      }
      if (page.builtins.length > 0) {
        const overrides = page.overrides ?? {};
        const plugins = { ...overrides.plugins };
        for (const source of page.builtins) {
          const key = `connector.${source.manifest.id}`;
          plugins[key] = { ...(plugins[key] ?? {}), enabled: next };
        }
        await putGlobalSettings(client, { ...overrides, plugins });
      }
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

  return (
    <>
      <p className="settings-note">{TEXT.settings.system.mcp.help}</p>

      <LoadGate loaded={loaded}>
        {(page) => (
          <Group>
            {page.servers.length === 0 && page.builtins.length === 0 ? (
              <p className="settings-empty">{TEXT.settings.system.mcp.empty}</p>
            ) : (
              <div className="settings-list">
                <BulkToggles busy={busy} onAll={(next) => void setAll(next)} />
                {page.servers.map((server) => (
                  <div className="settings-card" key={server.id}>
                    <span className="settings-card-mark">{initialOf(server.name)}</span>
                    <div className="settings-card-main">
                      <strong>
                        {server.name}
                        <Tag tone={STATUS_TONE[server.status]}>{statusLabel(server.status)}</Tag>
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
                      <Switch
                        disabled={busy}
                        label={`${server.name} · ${TEXT.settings.system.mcp.enable}`}
                        onChange={(next) => void write(server, {
                          ...inputOf(draftOf(server)),
                          enabled: next,
                        })}
                        value={server.enabled}
                      />
                    </div>
                  </div>
                ))}

                {page.builtins.map((source) => {
                  const open = openId === source.manifest.id;
                  const on = page.plugins[`connector.${source.manifest.id}`]?.enabled !== false;
                  const tools = Object.values(source.manifest.tools ?? {});
                  const meta = [
                    source.manifest.publisher,
                    source.manifest.version ? `v${source.manifest.version}` : undefined,
                  ].filter((part) => part !== undefined && part !== "").join(" · ");
                  return (
                    <div
                      className={`settings-card is-expandable${open ? " is-open" : ""}${on ? "" : " is-off"}`}
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
                          {on ? (
                            <Tag tone={catalogTone(source.status.status)}>
                              {statusLabel(source.status.status)}
                            </Tag>
                          ) : (
                            <Tag tone="off">{TEXT.settings.system.mcp.statusDisabled}</Tag>
                          )}
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
                        <Switch
                          disabled={busy}
                          label={`${source.manifest.displayName || source.manifest.id} · ${TEXT.settings.system.mcp.enable}`}
                          onChange={(next) => void toggleSource(source, next)}
                          value={on}
                        />
                      </div>
                    </div>
                  );
                })}
              </div>
            )}
          </Group>
        )}
      </LoadGate>

      {current ? (
        <SettingsModal
          label={TEXT.settings.system.mcp.editTitle}
          onClose={closeForm}
          wide
        >
          <section className="settings-card is-form">
            <div className="settings-card-form">
              <Row title={TEXT.settings.system.mcp.enable}>
                <label className="settings-check">
                  <input
                    checked={current.enabled}
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
