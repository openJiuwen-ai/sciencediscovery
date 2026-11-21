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

import { useState } from "react";

import type { SessionArtifactOutput } from "../api/types.js";
import { artifactPath } from "../app/artifact-labels.js";
import { fileName } from "../app/paths.js";
import { useLanguage } from "../app/use-language.js";
import { TEXT } from "../text.js";
import { FileGlyph } from "./UploadCards.js";
import { uploadKindOf } from "./uploads.js";

const INITIAL_COUNT = 5;

export function RunArtifactList({ outputs, onOpen, selectedVersionId }: {
  outputs: readonly SessionArtifactOutput[];
  onOpen: (output: SessionArtifactOutput) => void;
  selectedVersionId?: string;
}) {
  const [expanded, setExpanded] = useState(false);
  useLanguage();
  const labels = TEXT.conversation;
  const count = outputs.length;
  const visible = expanded ? outputs : outputs.slice(0, INITIAL_COUNT);
  return (
    <section aria-label={labels.runArtifacts} className="run-artifacts">
      <header>
        <strong>{labels.runArtifacts}</strong>
        <span className="run-artifact-count">{count}</span>
      </header>
      <ul>
        {visible.map((output) => {
          const path = artifactPath(output);
          const name = fileName(path) || fileName(output.artifact.name);
          return (
            <li key={output.version.id}>
              <button
                aria-current={output.version.id === selectedVersionId ? "true" : undefined}
                className="run-artifact-row"
                onClick={() => onOpen(output)}
                title={path}
                type="button"
              >
                <FileGlyph kind={uploadKindOf(name)} size={16} />
                <span className="run-artifact-name">{name}</span>
                <span className="run-artifact-version">v{output.version.version}</span>
                <span aria-hidden="true" className="run-artifact-chevron">›</span>
              </button>
            </li>
          );
        })}
      </ul>
      {count > INITIAL_COUNT ? (
        <button
          aria-expanded={expanded}
          className="run-artifact-toggle"
          onClick={() => setExpanded((current) => !current)}
          type="button"
        >
          {expanded ? labels.collapseRunArtifacts : labels.expandRunArtifacts(count)}
        </button>
      ) : null}
    </section>
  );
}
