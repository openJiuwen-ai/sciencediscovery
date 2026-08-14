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

import { useCallback, useEffect, useRef, useState } from "react";

import { AlertCircleIcon, CheckIcon, CloseIcon, InfoIcon } from "./icons.js";
import { useLocale } from "./i18n/index.js";

export type ToastTone = "error" | "info" | "success";

export interface Toast {
  detail?: string;
  id: number;
  title: string;
  tone: ToastTone;
}

const MAX_TRANSIENT_TOASTS = 4;
const TOAST_TIMEOUT_MS = 4500;

export function toastAutoDismissDelay(tone: ToastTone): number | undefined {
  return tone === "error" ? undefined : TOAST_TIMEOUT_MS;
}

/** Two notifications are the same event when they read identically. */
function isSameNotification(left: Toast, right: Toast): boolean {
  return left.tone === right.tone && left.title === right.title && left.detail === right.detail;
}

export function addToastToQueue(current: Toast[], toast: Toast): Toast[] {
  // One condition can fail many in-flight requests at once — a rejected access
  // token fails every startup call with the identical "Unauthorized" — and error
  // toasts stay until the user dismisses them. Without this guard the column
  // grows by one entry per failed request and eventually covers whatever dialog
  // the user needs to fix the condition with. Collapsing exact duplicates keeps
  // the notification visible and dismissible while bounding the stack; a
  // genuinely different message still gets its own toast, and a repeat after the
  // user dismissed this one notifies again.
  if (current.some((item) => isSameNotification(item, toast))) return current;

  const next = [...current, toast];
  const transientOverflow = next.filter((item) => item.tone !== "error").length - MAX_TRANSIENT_TOASTS;
  if (transientOverflow <= 0) return next;

  let remainingToDrop = transientOverflow;
  return next.filter((item) => {
    if (item.tone === "error" || remainingToDrop === 0) return true;
    remainingToDrop -= 1;
    return false;
  });
}

export function removeToastFromQueue(current: Toast[], id: number): Toast[] {
  return current.filter((toast) => toast.id !== id);
}

export function useToasts() {
  const [toasts, setToasts] = useState<Toast[]>([]);
  const nextToastId = useRef(1);
  const timers = useRef(new Map<number, number>());

  const dismiss = useCallback((id: number) => {
    const timer = timers.current.get(id);
    if (timer !== undefined) window.clearTimeout(timer);
    timers.current.delete(id);
    setToasts((current) => removeToastFromQueue(current, id));
  }, []);

  const push = useCallback((tone: ToastTone, title: string, detail?: string) => {
    const id = nextToastId.current;
    nextToastId.current += 1;
    setToasts((current) => addToastToQueue(current, { detail, id, title, tone }));
    const timeout = toastAutoDismissDelay(tone);
    if (timeout !== undefined) timers.current.set(id, window.setTimeout(() => dismiss(id), timeout));
  }, [dismiss]);

  useEffect(() => {
    const pending = timers.current;
    return () => {
      for (const timer of pending.values()) window.clearTimeout(timer);
      pending.clear();
    };
  }, []);

  return { dismiss, push, toasts };
}

function ToastToneIcon({ tone }: { tone: ToastTone }) {
  if (tone === "success") return <CheckIcon size={15} />;
  if (tone === "error") return <AlertCircleIcon size={15} />;
  return <InfoIcon size={15} />;
}

export function ToastViewport({
  onDismiss,
  toasts,
}: {
  onDismiss: (id: number) => void;
  toasts: Toast[];
}) {
  const { t } = useLocale();
  if (!toasts.length) return null;
  return (
    <div aria-live="polite" className="toast-viewport" role="status">
      {toasts.map((toast) => (
        <div className={`toast ${toast.tone}`} key={toast.id}>
          <span className="toast-icon"><ToastToneIcon tone={toast.tone} /></span>
          <div className="toast-body">
            <strong>{toast.title}</strong>
            {toast.detail ? <small title={toast.detail}>{toast.detail}</small> : null}
          </div>
          <button aria-label={t("common.dismiss")} className="icon-button" onClick={() => onDismiss(toast.id)} title={t("common.dismiss")} type="button"><CloseIcon size={13} /></button>
        </div>
      ))}
    </div>
  );
}
