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

import { useState, type ReactNode } from "react";
import { ChevronRightIcon } from "./icons.js";

/** Active content retains its original surface; terminal records are disclosures. */
export function ProcessRecord({ active = false, children, failed = false, label, className = "" }: {
  active?: boolean;
  children: ReactNode;
  failed?: boolean;
  label: ReactNode;
  className?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  return <details className={active ? "process-live" : `process-record ${className}${failed ? " failed" : ""}`} open={active || expanded}
    onClickCapture={(event) => {
      if (!active || !(event.target instanceof Element) || event.target.closest("button")) return;
      const detail = event.target.closest("summary")?.parentElement;
      if (detail instanceof HTMLDetailsElement && detail !== event.currentTarget) setExpanded(!detail.open);
    }}
    onToggle={(event) => { if (!active && event.target === event.currentTarget) setExpanded(event.currentTarget.open); }}>
    <summary hidden={active}>
      <span className="record-label">{label}</span>
      {failed ? <span className="record-failure-dot" aria-hidden="true" /> : null}
    </summary>
    <div className={active ? "process-live-body" : "process-record-body"}>{children}</div>
  </details>;
}

export function WorkspaceFolder({ children, label, name }: { children: ReactNode; label: string; name: string }) {
  return <details className="workspace-folder" data-folder={name} open>
    <summary><ChevronRightIcon className="record-chevron" size={14} /><strong>{label}</strong></summary>
    <div className="workspace-folder-body">{children}</div>
  </details>;
}
