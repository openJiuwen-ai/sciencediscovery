// Copyright (C) 2026-2026 Huawei Technologies Co., Ltd
// Licensed under the Apache License, Version 2.0 (the "License");
import { createContext, useContext, useState } from "react";
import type { Subagent } from "@sciencediscovery/schema";
import type { ApiClient } from "./api.js";
import { useLocale } from "./i18n/index.js";

export const RuntimeConfigClient = createContext<Pick<ApiClient, "configureCodex"> | undefined>(undefined);

/** Credential entry stays outside the chat composer and persisted transcript. */
export function CodexConfigCard({ subagent }: { subagent: Subagent }) {
  const client = useContext(RuntimeConfigClient);
  const { t } = useLocale();
  const [fallback, setFallback] = useState(subagent.runtimeOptions?.fallback ?? true);
  const [key, setKey] = useState("");
  const [state, setState] = useState<"idle" | "saving" | "saved">("idle");
  const [error, setError] = useState(false);
  if (!client || subagent.status !== "running" || subagent.runtimeInput?.state !== "pending") return null;
  const inputId = subagent.runtimeInput.id;
  return <form className="model-editor codex-config-card" aria-label={t("codex.configure")} onSubmit={async event => {
    event.preventDefault();
    if (state !== "idle" || !key.trim()) return;
    setState("saving"); setError(false);
    try { await client.configureCodex(subagent.id, inputId, key, fallback); setKey(""); setState("saved"); }
    catch { setState("idle"); setError(true); }
  }}>
    <strong>{t("codex.configure")}</strong>
    <p>{t("codex.configHelp")}</p>
    {state === "saved" ? <p role="status">{t("codex.configured")}</p> : <>
      <label><span>{t("codex.apiKey")}</span><input type="password" autoComplete="off" required value={key} onChange={event => setKey(event.target.value)} disabled={state === "saving"} /></label>
      <label className="skill-library-checkbox"><input type="checkbox" checked={fallback} onChange={event => setFallback(event.target.checked)} disabled={state === "saving"} /><span>{t("codex.fallback")}</span></label>
      {error ? <p role="alert">{t("codex.configError")}</p> : null}
      <button className="primary-button" type="submit" disabled={state === "saving" || !key.trim()}>{t(state === "saving" ? "codex.saving" : "codex.continue")}</button>
    </>}
  </form>;
}
