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

import type { WorkspaceActions } from "../app/use-workspace.js";
import type { SessionDetail } from "../api/types.js";
import { TEXT } from "../text.js";
import { PromptDialog } from "./PromptDialog.js";
import { sessionTitle } from "../app/session-title.js";
import { SidebarToggle } from "./SidebarToggle.js";

interface Props {
  actions: WorkspaceActions;
  detail?: SessionDetail;
  /** Brings the collapsed left column back. The control belongs at the page
   *  head's left edge, where the content itself starts. */
  onExpandSidebar?: () => void;
  onToggleWorkspace: () => void;
  projectName?: string;
  sidebarCollapsed?: boolean;
  workspaceOpen: boolean;
}

function stamp(detail: SessionDetail): string {
  const raw = detail.updatedAt ?? detail.createdAt;
  const time = Date.parse(raw);
  if (Number.isNaN(time)) return "";
  return new Date(time).toLocaleTimeString(TEXT.languageTag, { hour: "2-digit", minute: "2-digit" });
}

/**
 * The task header: the session's name, the project it belongs to, and the one
 * control that acts on the panel.
 *
 * The crumb used to lead with the Project; the handoff puts the session first
 * and the project beside it as quiet metadata, which is also the order of
 * importance — the project is fixed, the session is what the page is about.
 *
 * The rename is the double-click on the title and the row menu in the sidebar;
 * there is no ⋯ here, because every entry it would carry — rename, archive,
 * delete — is already on the session's own sidebar row.
 */
export function SessionBar({
  actions,
  detail,
  onExpandSidebar,
  onToggleWorkspace,
  projectName,
  sidebarCollapsed,
  workspaceOpen,
}: Props) {
  const [renaming, setRenaming] = useState(false);
  // A Session that has been started but not read back yet has no detail; it
  // then carries the same name the sidebar gives it, not a second word for
  // the same state.
  const title = detail ? sessionTitle(detail.title) : TEXT.sessionBar.untitled;

  return (
    <header className="task-head">
      {sidebarCollapsed && onExpandSidebar ? (
        <SidebarToggle onClick={onExpandSidebar} open={false} />
      ) : null}
      <span
        className="task-head-title"
        onDoubleClick={detail ? () => setRenaming(true) : undefined}
        role={detail ? "button" : undefined}
        title={detail ? `${title} · ${TEXT.sessionBar.renameHint}` : undefined}
        tabIndex={detail ? 0 : undefined}
      >
        {title}
      </span>
      <div className="task-head-meta">
        {projectName ? (
          <>
            <svg aria-hidden="true" fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="13">
              <path d="M3.5 7.5a2 2 0 0 1 2-2h4l2 2.5h7a2 2 0 0 1 2 2v8a2 2 0 0 1-2 2h-13a2 2 0 0 1-2-2z" />
            </svg>
            <span className="project">{projectName}</span>
          </>
        ) : null}
        {detail ? (
          <>
            <span aria-hidden="true" className="sep" />
            <span>{stamp(detail)}</span>
          </>
        ) : null}
      </div>
      <div className="task-head-actions">
        {/* Only the closed state has this button: once the panel is open, its
            own header carries the collapse control, and a second one here
            would be the same action drawn twice. */}
        {workspaceOpen ? null : (
          <button
            aria-expanded={false}
            aria-label={TEXT.sessionBar.workspaceToggle}
            className="bar-icon-button"
            onClick={onToggleWorkspace}
            title={TEXT.sessionBar.workspaceToggle}
            type="button"
          >
            {/* A panel outline with its own right-hand pane: the shape of the
                thing the button opens, rather than a generic grid glyph. */}
            <svg aria-hidden="true" fill="none" height="16" viewBox="0 0 24 24" width="16">
              <rect height="14" rx="2.5" stroke="currentColor" strokeWidth="1.8" width="18" x="3" y="5" />
              <path d="M16 5v14" stroke="currentColor" strokeWidth="1.8" />
            </svg>
          </button>
        )}
      </div>
      {renaming && detail ? (
        <PromptDialog
          accept={TEXT.menu.confirm}
          eyebrow={TEXT.menu.rename}
          fieldLabel={TEXT.sessionBar.sessionTitle}
          onCancel={() => setRenaming(false)}
          onSubmit={(next) => {
            setRenaming(false);
            // The field opens on the name the user can see; confirming it
            // unchanged is not a rename to that phrase.
            if (next !== title) void actions.renameSession(detail, next);
          }}
          title={TEXT.menu.rename}
          value={title}
        />
      ) : null}
    </header>
  );
}
