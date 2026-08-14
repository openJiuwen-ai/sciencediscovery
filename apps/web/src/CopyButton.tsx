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

import { CheckIcon, CopyIcon, WarningIcon } from "./icons.js";

export function CopyButton({
  className,
  getText,
  label = "Copy",
}: {
  className?: string;
  getText: () => string;
  label?: string;
}) {
  const [state, setState] = useState<"copied" | "failed" | "idle">("idle");
  const timer = useRef<number | undefined>(undefined);

  useEffect(() => () => {
    if (timer.current !== undefined) window.clearTimeout(timer.current);
  }, []);

  const copy = async (): Promise<void> => {
    const text = getText();
    let copied = true;
    try {
      await navigator.clipboard.writeText(text);
    } catch {
      try {
        const textarea = document.createElement("textarea");
        textarea.value = text;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        copied = document.execCommand("copy");
        textarea.remove();
      } catch {
        copied = false;
      }
    }
    setState(copied ? "copied" : "failed");
    if (timer.current !== undefined) window.clearTimeout(timer.current);
    timer.current = window.setTimeout(() => setState("idle"), 1600);
  };

  const feedback = state === "copied" ? "Copied" : state === "failed" ? "Copy failed" : label;
  return (
    <button
      aria-label={feedback}
      className={`copy-button${state !== "idle" ? ` ${state}` : ""}${className ? ` ${className}` : ""}`}
      onClick={() => void copy()}
      title={feedback}
      type="button"
    >
      {state === "copied" ? <CheckIcon size={14} /> : state === "failed" ? <WarningIcon size={14} /> : <CopyIcon size={14} />}
    </button>
  );
}
