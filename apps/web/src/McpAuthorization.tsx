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

import { useEffect, useRef, useState } from "react";
import { ExternalLink, LogIn, LogOut, X } from "lucide-react";
import type { CustomMcpServerDetails } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/index.js";
import { SpinnerIcon } from "./icons.js";

export type McpAuthorizationClient = Pick<ApiClient, "listMcpServers" | "testMcpServer" | "startMcpAuthorization" | "cancelMcpAuthorization" | "clearMcpAuthorization">;

export function McpAuthorization({ server, client, onChanged }: { server: CustomMcpServerDetails; client: McpAuthorizationClient; onChanged: () => Promise<void> }) {
  const { t } = useLocale();
  const [watching, setWatching] = useState(server.authorization?.state === "authorizing");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [loginUrl, setLoginUrl] = useState<string>();
  const popup = useRef<Window | null>(null);
  const changed = useRef(onChanged);
  changed.current = onChanged;

  useEffect(() => {
    if (!watching) return;
    let active = true;
    let timer: ReturnType<typeof setTimeout>;
    const poll = async () => {
      try {
        const item = (await client.listMcpServers()).find((item) => item.id === server.id);
        if (!active) return;
        if (!item || item.authorization?.state !== "authorizing") {
          setWatching(false); setLoginUrl(undefined);
          popup.current?.close(); popup.current = null;
          setError(item?.authorization?.error);
          if (item?.authorization?.state === "authorized") await client.testMcpServer(server.id);
          await changed.current();
          return;
        }
        if (popup.current?.closed) {
          await client.cancelMcpAuthorization(server.id);
          if (!active) return;
          popup.current = null; setWatching(false); setLoginUrl(undefined);
          await changed.current();
          return;
        }
      } catch (reason) { if (active) setError(reason instanceof Error ? reason.message : String(reason)); }
      if (active) timer = setTimeout(() => void poll(), 1500);
    };
    void poll();
    return () => { active = false; clearTimeout(timer); };
  }, [watching, client, server.id]);

  async function login(): Promise<void> {
    if (busy) return;
    setBusy(true); setError(undefined);
    popup.current = window.open("about:blank", "_blank", "popup,width=620,height=760");
    if (popup.current) popup.current.opener = null;
    try {
      const result = await client.startMcpAuthorization(server.id, `${window.location.origin}/api/mcp/oauth/callback`);
      if (popup.current && !popup.current.closed) popup.current.location.replace(result.authorizationUrl);
      setLoginUrl(result.authorizationUrl); setWatching(true);
      await changed.current();
    } catch (reason) { popup.current?.close(); popup.current = null; setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  async function clear(cancel: boolean): Promise<void> {
    setBusy(true); setError(undefined);
    try {
      if (cancel) await client.cancelMcpAuthorization(server.id);
      else await client.clearMcpAuthorization(server.id);
      popup.current?.close(); popup.current = null;
      setWatching(false); setLoginUrl(undefined);
      await changed.current();
    } catch (reason) { setError(reason instanceof Error ? reason.message : String(reason)); }
    finally { setBusy(false); }
  }

  const state = watching ? "authorizing" : server.authorization?.state ?? "required";
  return <div className="mcp-authorization">
    <div className="mcp-authorization-actions">
      <span className={`mcp-oauth-state ${state}`} role="status">OAuth · {t(`mcp.oauth.${state}`)}</span>
      {watching ? <><SpinnerIcon className="spin" size={14} /><button type="button" disabled={busy} className="text-button mcp-inline-command" onClick={() => void clear(true)}><X size={14} />{t("common.cancel")}</button>
        {loginUrl ? <a className="text-button mcp-inline-command" href={loginUrl} target="_blank" rel="noopener noreferrer"><ExternalLink size={14} />{t("mcp.oauth.openLogin")}</a> : null}</> : <>
        <button type="button" disabled={busy} className="text-button mcp-inline-command" onClick={() => void login()}>{busy ? <SpinnerIcon className="spin" size={14} /> : <LogIn size={14} />}{t(state === "authorized" || state === "expired" ? "mcp.oauth.reauthorize" : "mcp.oauth.login")}</button>
        <button type="button" disabled={busy} className="text-button mcp-inline-command" title={t("mcp.oauth.clearHint")} onClick={() => void clear(false)}><LogOut size={14} />{t("mcp.oauth.clear")}</button>
      </>}
    </div>
    {server.authorization?.scope ? <div className="mcp-oauth-scope">Scope: {server.authorization.scope}</div> : null}
    {error || server.authorization?.error ? <p className="mcp-server-error" role="alert">{error ?? server.authorization?.error}</p> : null}
  </div>;
}
