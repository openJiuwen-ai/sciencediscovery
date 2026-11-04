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

import { useEffect, useMemo, useRef, useState } from "react";

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

import { useLanguage } from "../app/use-language.js";
import { TEXT } from "../text.js";
import { claimsEscape } from "../views/dialog-escape.js";
import { subscribeFeedbackOpen, type FeedbackSeed } from "./open.js";
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
} from "./store.js";
import { submitFeedback, type FeedbackFailure } from "./submit.js";

const REPRODUCIBILITY_OPTIONS = ["always", "sometimes", "once"];
const IMPACT_OPTIONS = ["blocker", "major", "minor"];

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
  // Re-render on a language switch so `TEXT.feedback` resolves afresh.
  const locale = useLanguage();
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

  const submittingRef = useRef(submitting);
  useEffect(() => { submittingRef.current = submitting; }, [submitting]);

  const fb = TEXT.feedback;

  const KIND_LABELS: Record<FeedbackKind, string> = {
    bug: fb.kind.bug,
    idea: fb.kind.idea,
    other: fb.kind.other,
  };
  const REPRODUCIBILITY_LABELS: Record<string, string> = {
    always: fb.reproducibility.always,
    sometimes: fb.reproducibility.sometimes,
    once: fb.reproducibility.once,
  };
  const IMPACT_LABELS: Record<string, string> = {
    blocker: fb.impact.blocker,
    major: fb.impact.major,
    minor: fb.impact.minor,
  };
  const FAILURE_MESSAGES: Record<FeedbackFailure["code"], string> = {
    network: fb.failure.network,
    timeout: fb.failure.timeout,
    forbidden: fb.failure.forbidden,
    rate_limited: fb.failure.rateLimited,
    duplicate: fb.failure.duplicate,
    too_large: fb.failure.tooLarge,
    unavailable: fb.failure.unavailable,
    upstream: fb.failure.unavailable,
    invalid: fb.failure.invalid,
    http: fb.failure.network,
  };

  function optionLabel(map: Record<string, string>, value: string): string {
    return map[value] ?? value;
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
  }), []);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (!claimsEscape(event)) return;
      if (submittingRef.current) return;
      event.preventDefault();
      setOpen(false);
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [open]);

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
    if (reproducibility) lines.push(`${fb.reproducibility.label}: ${optionLabel(REPRODUCIBILITY_LABELS, reproducibility)}`);
    if (impact) lines.push(`${fb.impact.label}: ${optionLabel(IMPACT_LABELS, impact)}`);
    return lines.length ? `\n\n${lines.join("\n")}` : "";
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [reproducibility, impact, locale]);
  const bodyBudget = FEEDBACK_MAX_BODY - triageSuffix.length;

  const piiKindLabels = piiHints.map((hint) => (
    hint.kind === "phone" ? fb.pii.phone : hint.kind === "id-card" ? fb.pii.idCard : fb.pii.email
  ));
  const uniquePiiKinds = [...new Set(piiKindLabels)];

  function close(): void {
    if (submitting) return;
    setOpen(false);
  }

  function titleForPayload(): string {
    return seed?.title ?? deriveFeedbackTitle(body);
  }

  function fullText(): string {
    const lines: string[] = [];
    lines.push(`${fb.kind.label}: ${KIND_LABELS[kind]}`);
    if (reproducibility) lines.push(`${fb.reproducibility.label}: ${optionLabel(REPRODUCIBILITY_LABELS, reproducibility)}`);
    if (impact) lines.push(`${fb.impact.label}: ${optionLabel(IMPACT_LABELS, impact)}`);
    lines.push("", body);
    if (contact.trim()) lines.push("", `${fb.contact.label}: ${contact.trim()}`);
    if (includeDiagnostics && diagnostics) lines.push("", `${fb.diagnostics.label}:`, diagnostics);
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
      version: "desktop",
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
    <div className="modal-backdrop" onPointerDown={(event) => { if (event.target === event.currentTarget) close(); }}>
      <section
        aria-labelledby="feedback-title"
        aria-modal="true"
        className="modal-panel feedback-dialog"
        onPointerDown={(event) => event.stopPropagation()}
        role="dialog"
      >
        <header className="modal-header">
          <span className="modal-eyebrow">{fb.entry}</span>
          <h2 id="feedback-title">{fb.dialogTitle}</h2>
          <button aria-label={fb.close} className="modal-close" onClick={close} title={fb.close} type="button">
            ×
          </button>
        </header>

        <div className="feedback-tabs" role="tablist">
          <button role="tab" aria-selected={tab === "compose"} className={tab === "compose" ? "active" : undefined} type="button" onClick={() => setTab("compose")}>{fb.tab.compose}</button>
          <button role="tab" aria-selected={tab === "history"} className={tab === "history" ? "active" : undefined} type="button" onClick={() => setTab("history")}>{fb.tab.history}</button>
        </div>

        {tab === "history" ? (
          <div className="feedback-history modal-body">
            {history.length === 0 ? <p className="muted">{fb.history.empty}</p> : history.map((record) => (
              <div className="feedback-history-item" key={record.receipt}>
                <div className="feedback-history-copy">
                  <strong className="feedback-receipt">{record.receipt}</strong>
                  <small>{KIND_LABELS[record.kind]} · {fb.history.status.submitted} · {record.submittedAt}</small>
                </div>
                <button className="feedback-delete" onClick={() => deleteRecord(record.receipt)} aria-label={fb.history.delete} title={fb.history.delete} type="button">🗑</button>
              </div>
            ))}
          </div>
        ) : submitState.state === "success" ? (
          <div className="feedback-result modal-body">
            <h3>{fb.success.title}</h3>
            <p>{fb.success.note}</p>
            <div className="feedback-receipt-banner">{submitState.receipt}</div>
            <div className="feedback-actions">
              <button className="primary-button" type="button" onClick={() => void copyReceipt(submitState.receipt)}>
                {copyState === "copied" ? fb.success.copied : fb.success.copyReceipt}
              </button>
              <button className="secondary-button" type="button" onClick={close}>{fb.success.done}</button>
            </div>
          </div>
        ) : submitState.state === "failure" ? (
          <div className="feedback-result feedback-failure modal-body">
            <h3>{FAILURE_MESSAGES[submitState.failure.code]}</h3>
            {submitState.failure.code === "duplicate" && submitState.failure.receipt ? (
              <div className="feedback-receipt-banner">{submitState.failure.receipt}</div>
            ) : null}
            <p>{fb.failure.kept}</p>
            <div className="feedback-actions">
              <button className="secondary-button" type="button" onClick={() => void copyToClipboard(fullText()).then((ok) => setCopyState(ok ? "copied" : "failed"))}>
                {copyState === "copied" ? fb.success.copied : fb.failure.copyAll}
              </button>
              <button className="secondary-button" type="button" onClick={openIssueFromFailure}>{fb.failure.openIssue}</button>
              <button className="secondary-button" type="button" onClick={() => setSubmitState({ state: "idle" })}>{fb.back}</button>
            </div>
          </div>
        ) : (
          <div className="feedback-form modal-body">
            <div className="feedback-kind" role="radiogroup" aria-label={fb.kind.label}>
              {FEEDBACK_KINDS.map((option) => (
                <button className={kind === option ? "active" : undefined} key={option} role="radio" aria-checked={kind === option} type="button" onClick={() => setKind(option)}>
                  {KIND_LABELS[option]}
                </button>
              ))}
            </div>

            <label className="feedback-field">
              <span>{fb.body.label}</span>
              <textarea
                autoFocus
                className="feedback-body"
                maxLength={bodyBudget}
                onChange={(event) => { setBody(event.target.value); setPiiConfirmed(false); }}
                placeholder={fb.body.placeholder}
                rows={6}
                value={body}
              />
              <span className="feedback-counter">{fb.body.counter(trimmedBody.length, bodyBudget)}</span>
            </label>
            {showBodyTooShort ? <p className="feedback-inline-error" role="status">{fb.body.tooShort(FEEDBACK_MIN_BODY)}</p> : null}

            <label className="feedback-field">
              <span>{fb.contact.label}</span>
              <input
                className="feedback-contact"
                onChange={(event) => setContact(event.target.value)}
                placeholder={fb.contact.placeholder}
                value={contact}
              />
            </label>
            {contactInvalid ? <p className="feedback-inline-error" role="status">{fb.contact.invalid}</p> : null}

            <div className="feedback-option-grid">
              <label className="feedback-field">
                <span>{fb.reproducibility.label}</span>
                <select value={reproducibility} onChange={(event) => setReproducibility(event.target.value)}>
                  <option value="">{fb.selectPlaceholder}</option>
                  {REPRODUCIBILITY_OPTIONS.map((option) => <option key={option} value={option}>{optionLabel(REPRODUCIBILITY_LABELS, option)}</option>)}
                </select>
              </label>
              <label className="feedback-field">
                <span>{fb.impact.label}</span>
                <select value={impact} onChange={(event) => setImpact(event.target.value)}>
                  <option value="">{fb.selectPlaceholder}</option>
                  {IMPACT_OPTIONS.map((option) => <option key={option} value={option}>{optionLabel(IMPACT_LABELS, option)}</option>)}
                </select>
              </label>
            </div>
            {detailsMissing ? <p className="feedback-hint">{fb.requiredHint}</p> : null}

            <div className="feedback-diagnostics">
              <label className="feedback-checkbox">
                <input checked={includeDiagnostics} disabled={!diagnostics} type="checkbox" onChange={(event) => setIncludeDiagnostics(event.target.checked)} />
                <span>{fb.diagnostics.label}</span>
              </label>
              {diagnostics ? (
                <details className="feedback-diagnostics-preview">
                  <summary>{fb.diagnostics.preview}</summary>
                  <pre>{diagnostics}</pre>
                </details>
              ) : <p className="feedback-hint">{fb.diagnostics.none}</p>}
            </div>

            {piiBlocking ? (
              <div className="feedback-pii">
                <p role="status">{fb.pii.warning(uniquePiiKinds.join("、"))}</p>
                <label className="feedback-checkbox">
                  <input checked={piiConfirmed} type="checkbox" onChange={(event) => setPiiConfirmed(event.target.checked)} />
                  <span>{fb.pii.confirm}</span>
                </label>
              </div>
            ) : null}

            <div className="feedback-actions">
              <button className="primary-button" disabled={!canSubmit} type="button" onClick={() => void submit()}>
                {submitting ? fb.submitting : fb.submit}
              </button>
            </div>
          </div>
        )}
      </section>
    </div>
  );
}