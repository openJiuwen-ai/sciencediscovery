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

import { useEffect, useRef, useState, type ReactNode } from "react";
import { ChevronRightIcon } from "./icons.js";

/** Active content retains its original surface; terminal records are disclosures.
 * A new `reveal` token opens the record and scrolls it into view, so another
 * part of the page can point the user at this record. */
export function ProcessRecord({ active = false, children, failed = false, label, className = "", reveal,
  expanded: controlledExpanded, onExpandedChange }: {
  active?: boolean;
  children: ReactNode;
  failed?: boolean;
  label: ReactNode;
  className?: string;
  reveal?: number;
  expanded?: boolean;
  onExpandedChange?: (expanded: boolean) => void;
}) {
  const [localExpanded, setLocalExpanded] = useState(false);
  const expanded = controlledExpanded ?? localExpanded;
  const setExpanded = onExpandedChange ?? setLocalExpanded;
  const element = useRef<HTMLDetailsElement>(null);
  useEffect(() => {
    if (reveal === undefined) return;
    setExpanded(true);
    element.current?.scrollIntoView?.({ block: "nearest" });
  }, [reveal]);
  return <details className={active ? "process-live" : `process-record ${className}${failed ? " failed" : ""}`} open={active || expanded} ref={element}
    onClickCapture={(event) => {
      // Preserve a nested detail opened while active when this record becomes terminal.
      if (!active || !(event.target instanceof Element) || event.target.closest("button")) return;
      const detail = event.target.closest("summary")?.parentElement;
      if (detail instanceof HTMLDetailsElement && detail !== event.currentTarget) setExpanded(!detail.open);
    }}
    onToggle={(event) => { if (!active && event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary hidden={active} onClick={onExpandedChange ? (event) => {
      // Commit the user's choice before a live-to-history remount. Native
      // toggle is asynchronous and can arrive after this instance disappears.
      event.preventDefault();
      setExpanded(!expanded);
    } : undefined}>
      <span className="record-label">{label}</span>
      {failed ? <span className="record-failure-dot" aria-hidden="true" /> : null}
    </summary>
    <div className={active ? "process-live-body" : "process-record-body"}>{children}</div>
  </details>;
}

export function WorkspaceFolder({ children, label, name, reveal }: { children: ReactNode; label: string; name: string; reveal?: number }) {
  const [expanded, setExpanded] = useState(true);
  useEffect(() => { if (reveal !== undefined) setExpanded(true); }, [reveal]);
  return <details className="workspace-folder" data-folder={name} open={expanded}
    onToggle={(event) => {
      if (event.target === event.currentTarget) setExpanded(event.currentTarget.open);
    }}>
    <summary><ChevronRightIcon className="record-chevron" size={14} /><strong>{label}</strong></summary>
    <div className="workspace-folder-body">{children}</div>
  </details>;
}
