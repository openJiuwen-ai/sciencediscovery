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

import {
  classifyScientificArtifact,
  resolveScientificArtifactKind,
  type ScientificArtifact,
  type ScientificArtifactKind,
  type SessionArtifactOutput,
  type WorkspaceFile,
} from "@sciencediscovery/schema";

import {
  ChevronRightIcon,
  CodeFileIcon,
  FileIcon,
  ImageIcon,
  MarkdownIcon,
  NotebookIcon,
  ReportIcon,
  StructureIcon,
  TableIcon,
} from "../icons.js";
import { useLocale } from "../i18n/index.js";

function artifactIconKind(artifact: Pick<ScientificArtifact, "kind" | "name">): ScientificArtifactKind {
  if (artifact.kind === "other") return classifyScientificArtifact(artifact.name) ?? "other";
  return resolveScientificArtifactKind(artifact.kind, artifact.name);
}

function ArtifactOutputIcon({ artifact }: { artifact: Pick<ScientificArtifact, "kind" | "name"> }): ReactNode {
  const props = {
    className: `artifact-tree-node-icon artifact-tree-node-icon-${artifactIconKind(artifact)}`,
    size: 14,
  };
  switch (artifactIconKind(artifact)) {
    case "dataset": return <TableIcon {...props} />;
    case "figure": return <ImageIcon {...props} />;
    case "markdown": return <MarkdownIcon {...props} />;
    case "report": return <ReportIcon {...props} />;
    case "notebook": return <NotebookIcon {...props} />;
    case "structure": return <StructureIcon {...props} />;
    case "html":
    case "json":
    case "latex": return <CodeFileIcon {...props} />;
    default: return <FileIcon {...props} />;
  }
}

export function ConversationArtifactList({
  outputs,
  onOpen,
  currentFiles = [],
  onOpenCurrentFile,
}: {
  onOpen: (artifact: ScientificArtifact, version: SessionArtifactOutput["version"]) => void;
  outputs: readonly SessionArtifactOutput[];
  currentFiles?: readonly WorkspaceFile[];
  onOpenCurrentFile?: (file: WorkspaceFile) => void;
}): ReactNode {
  const { t } = useLocale();
  const [expanded, setExpanded] = useState(false);
  const count = outputs.length + currentFiles.length;
  if (!count) return null;
  const visibleOutputs = expanded ? outputs : outputs.slice(0, 5);
  const visibleFiles = expanded ? currentFiles : currentFiles.slice(0, Math.max(0, 5 - outputs.length));
  const canToggle = count > 5;
  const heading = outputs.length ? t("artifact.runOutputs") : t("record.currentFiles");
  return <section aria-label={heading} className="conversation-artifact-list">
    <header>
      <span><strong>{heading}</strong><small>{count}</small></span>
    </header>
    <ul>
      {visibleOutputs.map(({ artifact, version }) => {
        const label = artifact.title?.trim() || artifact.name;
        return <li key={version.id}>
          <button
            aria-label={t("artifact.openRunOutput", { name: label })}
            onClick={() => onOpen(artifact, version)}
            title={artifact.name}
            type="button"
          >
            <ArtifactOutputIcon artifact={artifact} />
            <span>
              <strong>{label}</strong>
              <small>{artifact.kind} · v{version.version}</small>
            </span>
            <ChevronRightIcon className="conversation-artifact-open-icon" size={16} />
          </button>
        </li>;
      })}
      {visibleFiles.map((file) => <li key={`current:${file.path}`}><button type="button"
        aria-label={t("record.openCurrentFile", { name: file.path })} onClick={() => onOpenCurrentFile?.(file)} title={file.path}>
        <FileIcon size={14} /><span><strong>{file.path}</strong><small>{t("record.currentFile")}</small></span>
        <ChevronRightIcon className="conversation-artifact-open-icon" size={16} />
      </button></li>)}
    </ul>
    {canToggle ? <footer>
      <button
        aria-expanded={expanded}
        onClick={() => setExpanded((current) => !current)}
        type="button"
      >
        {expanded ? t("artifact.collapseRunOutputs") : t("artifact.expandRunOutputs", { count })}
      </button>
    </footer> : null}
  </section>;
}
