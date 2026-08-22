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

import type { ToolTrace } from "@sciencediscovery/schema";
import { useState } from "react";

import { CopyButton } from "../CopyButton.js";
import { ChevronRightIcon } from "../icons.js";
import { formatToolInput, parseToolResultSections } from "./tool-result-sections.js";
import { useLocale } from "../i18n/index.js";

function ToolIoSection({
  content,
  label,
  onToggle,
  open,
}: {
  content: string;
  label: string;
  onToggle: (open: boolean) => void;
  open: boolean;
}) {
  return (
    <details
      className="tool-io-section"
      open={open}
      onToggle={(event) => {
        if (event.currentTarget.open !== open) onToggle(event.currentTarget.open);
      }}
    >
      <summary>
        <span className="tool-io-chevron"><ChevronRightIcon size={14} /></span>
        <span className="tool-io-label">{label}</span>
        {/* Keep the copy click from toggling the section. */}
        <span className="tool-io-actions" onClick={(event) => event.preventDefault()}>
          <CopyButton className="tool-io-copy" getText={() => content} label={`Copy ${label}`} />
        </span>
      </summary>
      <pre>{content}</pre>
    </details>
  );
}

/** Shared raw, sectioned tool I/O renderer for main and nested subagent cards. */
export function ToolIoSections({
  outputText,
  trace,
}: {
  outputText?: string;
  trace: ToolTrace;
}) {
  const { t } = useLocale();
  const [collapsedSections, setCollapsedSections] = useState<Record<string, boolean>>({});
  const inputText = formatToolInput(trace);
  const outputSections = outputText ? parseToolResultSections(outputText, trace.status) : [];
  const renderSection = (sectionId: string, label: string, content: string) => (
    <ToolIoSection
      content={content}
      key={sectionId}
      label={label}
      onToggle={(open) => setCollapsedSections((current) => ({ ...current, [sectionId]: !open }))}
      open={!collapsedSections[sectionId]}
    />
  );

  return <div className="tool-io-sections">
    {inputText ? renderSection("input", t("timeline.input"), inputText) : null}
    {trace.inputTruncated ? <p className="muted">The input was truncated by the retention policy.</p> : null}
    {outputSections.length > 0
      ? outputSections.map((section) => renderSection(section.id, section.label, section.content))
      : (
        <pre>{trace.status === "running"
          ? t("timeline.toolRunning")
          : trace.outputStream
            ? t("timeline.loadingResult")
            : t("timeline.noOutput")}</pre>
      )}
    {trace.outputTruncated ? <p className="muted">The result was truncated by the retention policy.</p> : null}
  </div>;
}
