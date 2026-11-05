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

import { useEffect, useMemo, useState } from "react";

import {
  FEEDBACK_KINDS,
  FEEDBACK_MAX_BODY,
  FEEDBACK_MIN_BODY,
  buildFeedbackPayload,
  classifyContact,
  deriveFeedbackTitle,
  detectFeedbackPii,
  redactFeedbackText,
  type FeedbackKind,
  type FeedbackMeta,
} from "@sciencediscovery/operational-logging/feedback";
import { errorIssueUrl } from "@sciencediscovery/operational-logging/diagnostics";

import { submitFeedback, type FeedbackFailure } from "./api/feedback.js";
import {
  clearFeedbackDraft,
  loadFeedbackDraft,
  loadFeedbackHistory,
  readFeedbackInstallId,
  removeFeedbackRecord,
  saveFeedbackDraft,
  saveFeedbackRecord,
  type FeedbackRecord,
  type FeedbackStorage,
} from "./feedback-store.js";
import { subscribeFeedbackOpen, type FeedbackSeed } from "./feedback-open.js";
import { CloseIcon, SendIcon, SpinnerIcon, TrashIcon } from "./icons.js";
import { useLocale, type MessageKey } from "./i18n/index.js";

declare const __SCIENCE_DISCOVERY_BUILD__: string;

const KIND_LABEL_KEYS: Record<FeedbackKind, MessageKey> = {
  bug: "feedback.kind.bug",
  idea: "feedback.kind.idea",
  other: "feedback.kind.other",
};

const REPRODUCIBILITY_OPTIONS = ["always", "sometimes", "once"];
const IMPACT_OPTIONS = ["blocker", "major", "minor"];

const REPRODUCIBILITY_LABEL_KEYS: Record<string, MessageKey> = {
  always: "feedback.reproducibility.always",
  sometimes: "feedback.reproducibility.sometimes",
  once: "feedback.reproducibility.once",
};

const IMPACT_LABEL_KEYS: Record<string, MessageKey> = {
  blocker: "feedback.impact.blocker",
  major: "feedback.impact.major",
  minor: "feedback.impact.minor",
};

const FAILURE_MESSAGE_KEYS: Record<FeedbackFailure["code"], MessageKey> = {
  network: "feedback.failure.network",
  timeout: "feedback.failure.timeout",
  forbidden: "feedback.failure.forbidden",
  rate_limited: "feedback.failure.rateLimited",
  duplicate: "feedback.failure.duplicate",
  too_large: "feedback.failure.tooLarge",
  unavailable: "feedback.failure.unavailable",
  upstream: "feedback.failure.unavailable",
  invalid: "feedback.failure.invalid",
  http: "feedback.failure.network",
};

type SubmitState =
  | { state: "idle" }
  | { state: "success"; receipt: string }
  | { state: "failure"; failure: FeedbackFailure };

function storage(): FeedbackStorage {
  return window.localStorage;
}

async function copyToClipboard(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const textarea = document.createElement("textarea");
      textarea.value = text;
      textarea.style.position = "fixed";
      textarea.style.opacity = "0";
      document.body.appendChild(textarea);
      textarea.select();
      const copied = document.execCommand("copy");
      textarea.remove();
      return copied;
    } catch {
      return false;
    }
  }
}

export function FeedbackDialog() {
  const { t, locale } = useLocale();
  const [open, setOpen] = useState(false);
  const [tab, setTab] = useState<"compose" | "history">("compose");
  const [seed, setSeed] = useState<FeedbackSeed | undefined>(undefined);
  const [kind, setKind] = useState<FeedbackKind>("bug");
  const [body, setBody] = useState("");
  const [contact, setContact] = useState("");
  const [reproducibility, setReproducibility] = useState("");
  const [impact, setImpact] = useState("");
  const [includeDiagnostics, setIncludeDiagnostics] = useState(true);
  const [diagnostics, setDiagnostics] = useState("");
  const [piiConfirmed, setPiiConfirmed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [submitState, setSubmitState] = useState<SubmitState>({ state: "idle" });
  const [history, setHistory] = useState<FeedbackRecord[]>([]);
  const [copyState, setCopyState] = useState<"idle" | "copied" | "failed">("idle");

  function optionLabel(map: Record<string, MessageKey>, value: string): string {
    const key = map[value];
    return key ? t(key) : value;
  }

  useEffect(() => subscribeFeedbackOpen((incoming) => {
    const draft = loadFeedbackDraft(storage());
    setSeed(incoming);
    setOpen(true);
    setTab("compose");
    setSubmitState({ state: "idle" });
    setPiiConfirmed(false);
    setCopyState("idle");
    setSubmitting(false);
    setKind(incoming?.kind ?? draft.kind);
    setBody(incoming?.body ?? draft.body);
    setContact(draft.contact);
    setReproducibility(draft.reproducibility);
    setImpact(draft.impact);
    setDiagnostics(incoming?.diagnostics ?? "");
    setIncludeDiagnostics(incoming?.diagnostics ? true : draft.includeDiagnostics);
    setHistory(loadFeedbackHistory(storage()));
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }), []);

  useEffect(() => {
    if (!open || submitState.state !== "idle") return;
    saveFeedbackDraft(storage(), { kind, body, contact, reproducibility, impact, includeDiagnostics });
  }, [open, submitState, kind, body, contact, reproducibility, impact, includeDiagnostics]);

  const trimmedBody = useMemo(() => body.trim(), [body]);
  const piiHints = useMemo(() => detectFeedbackPii(body), [body]);
  const contactType = useMemo(() => classifyContact(contact), [contact]);

  const bodyTooShort = trimmedBody.length < FEEDBACK_MIN_BODY;
  /** Only complain once there is something to complain about: an untouched
   *  field shows the placeholder's range, not a red error on open. */
  const showBodyTooShort = body.length > 0 && bodyTooShort;
  const contactInvalid = contact.trim().length > 0 && contactType === undefined;
  const piiBlocking = piiHints.length > 0 && !piiConfirmed;
  // Frequency and impact are required: a report without them cannot be
  // triaged, so the dialog will not send one.
  const detailsMissing = reproducibility === "" || impact === "";
  const canSubmit = !submitting && !bodyTooShort && !contactInvalid && !piiBlocking && !detailsMissing;

  /** The triage lines are appended after the description, so the description
   *  must leave room for them; measuring the suffix lets the counter state the
   *  real budget instead of a cap the send path then trims. */
  const triageSuffix = useMemo(() => {
    const lines: string[] = [];
    if (reproducibility) {
      lines.push(`${t("feedback.reproducibility.label")}: ${optionLabel(REPRODUCIBILITY_LABEL_KEYS, reproducibility)}`);
    }
    if (impact) lines.push(`${t("feedback.impact.label")}: ${optionLabel(IMPACT_LABEL_KEYS, impact)}`);
    return lines.length ? `\n\n${lines.join("\n")}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reproducibility, impact, t]);
  const bodyBudget = FEEDBACK_MAX_BODY - triageSuffix.length;

  const piiKindLabels = useMemo(() => {
    const labels = new Set<string>();
    for (const hint of piiHints) {
      labels.add(hint.kind === "phone" ? t("feedback.pii.phone") : hint.kind === "id-card" ? t("feedback.pii.idCard") : t("feedback.pii.email"));
    }
    return [...labels];
  }, [piiHints, t]);

  function close(): void {
    if (submitting) return;
    setOpen(false);
  }

  function titleForPayload(): string {
    return seed?.title ?? deriveFeedbackTitle(body);
  }

  function fullText(): string {
    const lines: string[] = [];
    lines.push(`${t("feedback.kind.label")}: ${t(KIND_LABEL_KEYS[kind])}`);
    if (reproducibility) lines.push(`${t("feedback.reproducibility.label")}: ${optionLabel(REPRODUCIBILITY_LABEL_KEYS, reproducibility)}`);
    if (impact) lines.push(`${t("feedback.impact.label")}: ${optionLabel(IMPACT_LABEL_KEYS, impact)}`);
    lines.push("", body);
    if (contact.trim()) lines.push("", `${t("feedback.contact.label")}: ${contact.trim()}`);
    if (includeDiagnostics && diagnostics) lines.push("", `${t("feedback.diagnostics.label")}:`, diagnostics);
    return lines.join("\n");
  }

  async function submit(): Promise<void> {
    if (!canSubmit) return;
    setSubmitting(true);
    // Reserve on the *redacted* text: redaction runs before the payload's
    // length cap and lengthens paths and key assignments, so measuring the raw
    // description would let the cap slice off the mandatory triage lines.
    const finalBody = `${redactFeedbackText(trimmedBody).slice(0, Math.max(0, FEEDBACK_MAX_BODY - triageSuffix.length))}${triageSuffix}`;

    const meta: FeedbackMeta = {
      version: typeof __SCIENCE_DISCOVERY_BUILD__ === "string" ? __SCIENCE_DISCOVERY_BUILD__ : "development",
      os: typeof navigator === "undefined" ? "unavailable" : navigator.platform || navigator.userAgent,
      locale,
      installId: readFeedbackInstallId(storage()),
      ...seed?.meta,
    };

    try {
      const payload = buildFeedbackPayload({
        kind,
        title: titleForPayload(),
        body: finalBody,
        contact: contactType ? { type: contactType, value: contact.trim() } : undefined,
        meta,
        diagnostics: includeDiagnostics ? diagnostics : undefined,
      });
      const outcome = await submitFeedback(payload);
      if (outcome.ok) {
        saveFeedbackRecord(storage(), {
          receipt: outcome.receipt,
          kind,
          title: payload.title,
          submittedAt: outcome.createdAt,
          status: "submitted",
        });
        clearFeedbackDraft(storage());
        setHistory(loadFeedbackHistory(storage()));
        setSubmitState({ state: "success", receipt: outcome.receipt });
      } else {
        setSubmitState({ state: "failure", failure: outcome.failure });
      }
    } finally {
      setSubmitting(false);
    }
  }

  function deleteRecord(receipt: string): void {
    setHistory(removeFeedbackRecord(storage(), receipt));
  }

  async function copyReceipt(receipt: string): Promise<void> {
    setCopyState(await copyToClipboard(receipt) ? "copied" : "failed");
  }

  function openIssueFromFailure(): void {
    const tabWindow = window.open("about:blank", "_blank");
    if (!tabWindow) return;
    tabWindow.opener = null;
    tabWindow.document.write('<meta name="referrer" content="no-referrer">');
    tabWindow.location.replace(errorIssueUrl(titleForPayload(), fullText()));
  }

  if (!open) return null;

  return (
    <div className="config-backdrop" onMouseDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section aria-label={t("feedback.dialogTitle")} aria-modal="true" className="config-panel feedback-dialog" role="dialog">
        <div className="config-header">
          <div><span className="eyebrow">{t("feedback.entry")}</span><h2>{t("feedback.dialogTitle")}</h2></div>
          <button className="icon-button" onClick={close} aria-label={t("feedback.close")} title={t("feedback.close")}><CloseIcon size={20} /></button>
        </div>

        <div className="feedback-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "compose"} className={tab === "compose" ? "active" : undefined} type="button" onClick={() => setTab("compose")}>{t("feedback.tab.compose")}</button>
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : undefined} type="button" onClick={() => setTab("history")}>{t("feedback.tab.history")}</button>
        </div>

        {tab === "history" ? (
          <div className="feedback-history">
            {history.length === 0 ? <p className="muted">{t("feedback.history.empty")}</p> : history.map((record) => (
              <div className="feedback-history-item" key={record.receipt}>
                <div className="feedback-history-copy">
                  <strong className="feedback-receipt">{record.receipt}</strong>
                  <small>{t(KIND_LABEL_KEYS[record.kind])} · {t("feedback.history.status.submitted")} · {record.submittedAt}</small>
                </div>
                <button className="icon-button" onClick={() => deleteRecord(record.receipt)} aria-label={t("feedback.history.delete")} title={t("feedback.history.delete")} type="button"><TrashIcon size={16} /></button>
              </div>
            ))}
          </div>
        ) : submitState.state === "success" ? (
          <div className="feedback-result">
            <h3>{t("feedback.success.title")}</h3>
            <p>{t("feedback.success.note")}</p>
            <div className="feedback-receipt-banner">{submitState.receipt}</div>
            <div className="feedback-actions">
              <button className="primary-button" type="button" onClick={() => void copyReceipt(submitState.receipt)}>
                {copyState === "copied" ? t("feedback.success.copied") : t("feedback.success.copyReceipt")}
              </button>
              <button className="secondary-button" type="button" onClick={close}>{t("feedback.success.done")}</button>
            </div>
          </div>
        ) : submitState.state === "failure" ? (
          <div className="feedback-result feedback-failure">
            <h3>{t(FAILURE_MESSAGE_KEYS[submitState.failure.code])}</h3>
            {submitState.failure.code === "duplicate" && submitState.failure.receipt ? (
              <div className="feedback-receipt-banner">{submitState.failure.receipt}</div>
            ) : null}
            <p>{t("feedback.failure.kept")}</p>
            <div className="feedback-actions">
              <button className="secondary-button" type="button" onClick={() => void copyToClipboard(fullText()).then((ok) => setCopyState(ok ? "copied" : "failed"))}>
                {copyState === "copied" ? t("feedback.success.copied") : t("feedback.failure.copyAll")}
              </button>
              <button className="secondary-button" type="button" onClick={openIssueFromFailure}>{t("feedback.failure.openIssue")}</button>
              <button className="secondary-button" type="button" onClick={() => setSubmitState({ state: "idle" })}>{t("feedback.back")}</button>
            </div>
          </div>
        ) : (
          <div className="feedback-form">
            <div className="feedback-kind" role="radiogroup" aria-label={t("feedback.kind.label")}>
              {FEEDBACK_KINDS.map((option) => (
                <button className={kind === option ? "active" : undefined} key={option} role="radio" aria-checked={kind === option} type="button" onClick={() => setKind(option)}>
                  {t(KIND_LABEL_KEYS[option])}
                </button>
              ))}
            </div>

            <label>
              <span>{t("feedback.body.label")}</span>
              <textarea
                autoFocus
                className="feedback-body"
                maxLength={bodyBudget}
                onChange={(event) => { setBody(event.target.value); setPiiConfirmed(false); }}
                placeholder={t("feedback.body.placeholder")}
                rows={6}
                value={body}
              />
              <span className="feedback-counter">{t("feedback.body.counter", { count: trimmedBody.length, max: bodyBudget })}</span>
            </label>
            {showBodyTooShort ? <p className="feedback-inline-error" role="status">{t("feedback.body.tooShort", { min: FEEDBACK_MIN_BODY })}</p> : null}

            <label>
              <span>{t("feedback.contact.label")}</span>
              <input
                className="feedback-contact"
                onChange={(event) => setContact(event.target.value)}
                placeholder={t("feedback.contact.placeholder")}
                value={contact}
              />
            </label>
            {contactInvalid ? <p className="feedback-inline-error" role="status">{t("feedback.contact.invalid")}</p> : null}

            <div className="feedback-option-grid">
              <label>
                <span>{t("feedback.reproducibility.label")}</span>
                <select value={reproducibility} onChange={(event) => setReproducibility(event.target.value)}>
                  <option value="">{t("feedback.selectPlaceholder")}</option>
                  {REPRODUCIBILITY_OPTIONS.map((option) => <option key={option} value={option}>{optionLabel(REPRODUCIBILITY_LABEL_KEYS, option)}</option>)}
                </select>
              </label>
              <label>
                <span>{t("feedback.impact.label")}</span>
                <select value={impact} onChange={(event) => setImpact(event.target.value)}>
                  <option value="">{t("feedback.selectPlaceholder")}</option>
                  {IMPACT_OPTIONS.map((option) => <option key={option} value={option}>{optionLabel(IMPACT_LABEL_KEYS, option)}</option>)}
                </select>
              </label>
            </div>
            {detailsMissing ? <p className="feedback-hint">{t("feedback.requiredHint")}</p> : null}

            <div className="feedback-diagnostics">
              <label className="feedback-checkbox">
                <input checked={includeDiagnostics} disabled={!diagnostics} type="checkbox" onChange={(event) => setIncludeDiagnostics(event.target.checked)} />
                <span>{t("feedback.diagnostics.label")}</span>
              </label>
              {diagnostics ? (
                <details className="feedback-diagnostics-preview">
                  <summary>{t("feedback.diagnostics.preview")}</summary>
                  <pre>{diagnostics}</pre>
                </details>
              ) : <p className="feedback-hint">{t("feedback.diagnostics.none")}</p>}
            </div>

            {piiBlocking ? (
              <div className="feedback-pii">
                <p role="status">{t("feedback.pii.warning", { kinds: piiKindLabels.join(t("plugins.listSeparator")) })}</p>
                <label className="feedback-checkbox">
                  <input checked={piiConfirmed} type="checkbox" onChange={(event) => setPiiConfirmed(event.target.checked)} />
                  <span>{t("feedback.pii.confirm")}</span>
                </label>
              </div>
            ) : null}

            <div className="feedback-actions">
              <button className="primary-button" disabled={!canSubmit} type="button" onClick={() => void submit()}>
                {submitting ? <span className="feedback-button-copy"><SpinnerIcon size={14} />{t("feedback.submitting")}</span> : <span className="feedback-button-copy"><SendIcon size={14} />{t("feedback.submit")}</span>}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}