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

import { createContext, useContext, useMemo, useRef, useState } from "react";

import { formatErrorDiagnostic, errorIssueUrl, type DiagnosticIds, type DiagnosticSnapshot } from "@sciencediscovery/operational-logging/diagnostics";

import { errorDiagnosticIds } from "./error-diagnostics.js";
import { useLocale } from "./i18n/index.js";

declare const __SCIENCE_DISCOVERY_BUILD__: string;
export const ErrorDiagnosticClient = createContext<{
  getErrorDiagnostics(ids: DiagnosticIds): Promise<DiagnosticSnapshot>;
} | undefined>(undefined);

export function ErrorDiagnosticActions({ title, detail = "", ids }: { title: string; detail?: string; ids?: DiagnosticIds }) {
  const client = useContext(ErrorDiagnosticClient);
  const { locale, t } = useLocale();
  const correlation = useMemo(() => ids ?? { ...errorDiagnosticIds(detail) }, [detail, ids]);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<"copied" | "copyFailed" | "popupBlocked">();
  const cache = useRef<{ key: string; bundle: Promise<string> } | undefined>(undefined);

  function bundle(): Promise<string> {
    const key = JSON.stringify([title, detail, correlation, locale]);
    if (cache.current?.key === key) return cache.current.bundle;
    const pending = (async () => {
      let snapshot: DiagnosticSnapshot | undefined;
      try {
        if (client && Object.values(correlation).some(Boolean)) snapshot = await Promise.race([
          client.getErrorDiagnostics(correlation),
          new Promise<undefined>(resolve => setTimeout(() => resolve(undefined), 2000)),
        ]);
      } catch { /* Copying the visible failure works even when the service is down. */ }
      return formatErrorDiagnostic({
        ...correlation, title, detail, locale,
        version: typeof __SCIENCE_DISCOVERY_BUILD__ === "string" ? __SCIENCE_DISCOVERY_BUILD__ : "development",
        os: typeof navigator === "undefined" ? "unavailable" : navigator.platform || navigator.userAgent,
        ...(snapshot ? { snapshot } : {}),
      });
    })();
    cache.current = { key, bundle: pending };
    return pending;
  }

  return <div className="error-diagnostic-actions" onClick={event => event.stopPropagation()}>
    <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
      setBusy(true); setFeedback(undefined);
      try {
        await navigator.clipboard.writeText(await bundle());
        setFeedback("copied");
      } catch { setFeedback("copyFailed"); }
      finally { setBusy(false); }
    }}>{t("diagnostics.copy")}</button>
    <button type="button" className="secondary-button" disabled={busy} onClick={async () => {
      // Reserve the tab during the gesture; awaiting the local snapshot first
      // would trigger popup blockers. No opener or referrer reaches GitHub.
      const tab = window.open("about:blank", "_blank");
      if (!tab) { setFeedback("popupBlocked"); return; }
      tab.opener = null;
      tab.document.write('<meta name="referrer" content="no-referrer">');
      setBusy(true); setFeedback(undefined);
      try { tab.location.replace(errorIssueUrl(title, await bundle())); }
      finally { setBusy(false); }
    }}>{t("diagnostics.issue")}</button>
    {feedback ? <span role="status">{t(`diagnostics.${feedback}`)}</span> : null}
  </div>;
}
