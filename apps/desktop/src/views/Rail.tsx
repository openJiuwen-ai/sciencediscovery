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

import type { UserSession } from "../auth/session.js";
import { TEXT } from "../text.js";

interface Props {
  /** The signed-in account, shown at the foot of the rail as 用户. */
  account?: UserSession;
  /** Whether the account surface is the one on screen. */
  accountOpen?: boolean;
  /** Opens the signed-in account page. */
  onOpenAccount?: () => void;
  /** Opens the system settings surface; it is a surface over the task page,
   *  not a page of its own. */
  onOpenSettings: () => void;
  /** Leaves 设置 for the task surface. */
  onSelectTask: () => void;
  settingsOpen: boolean;
}

/** The rail's glyphs are drawn here rather than imported: the handoff ships
 *  outline icons at 17px, and five paths are cheaper than a dependency. */
function TaskGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="17">
      <rect height="15" rx="2.6" width="16" x="4" y="4.5" />
      <path d="M7.5 9.5h9M7.5 13h9M7.5 16.5h5" />
    </svg>
  );
}

function SettingsGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="17" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.6" viewBox="0 0 24 24" width="17">
      <path d="M4 7h9M17 7h3M4 17h3M11 17h9" />
      <circle cx="15" cy="7" r="2.1" />
      <circle cx="9" cy="17" r="2.1" />
    </svg>
  );
}

function UserGlyph() {
  return (
    <svg aria-hidden="true" fill="none" height="13" stroke="currentColor" strokeLinecap="round" strokeLinejoin="round" strokeWidth="1.7" viewBox="0 0 24 24" width="13">
      <circle cx="12" cy="8" r="3.4" />
      <path d="M5.5 19.2c.9-3 3.4-4.7 6.5-4.7s5.6 1.7 6.5 4.7" />
    </svg>
  );
}

/**
 * The 64px rail: the logo, the task surface and 设置.
 *
 * It is the one element every surface shares. Scientific memory is not a
 * surface of its own: it is a capsule in the task header and a card behind a
 * report's citation, so there is no rail entry to return to. The way back to a
 * collapsed left column sits at the left edge of the page itself, not in this
 * rail: the expand control is part of the surface that lost its column.
 */
export function Rail({ account, accountOpen, onOpenAccount, onOpenSettings, onSelectTask, settingsOpen }: Props) {
  const onTask = !settingsOpen && !accountOpen;
  return (
    <nav aria-label={TEXT.appName} className="rail">
      {/* The mark is the stylesheet's `app-mark.png`; the box carries no glyph
          of its own, so replacing the artwork is a one-file change. */}
      <div aria-hidden="true" className="rail-logo" />
      <div className="rail-nav">
        <button
          aria-current={onTask ? "page" : undefined}
          className={`rail-item${onTask ? " is-active" : ""}`}
          onClick={onSelectTask}
          title={TEXT.rail.task}
          type="button"
        >
          <TaskGlyph />
          <span>{TEXT.rail.task}</span>
        </button>
        <button
          aria-current={settingsOpen ? "page" : undefined}
          className={`rail-item${settingsOpen ? " is-active" : ""}`}
          data-guide="settings"
          onClick={onOpenSettings}
          title={TEXT.rail.settings}
          type="button"
        >
          <SettingsGlyph />
          <span>{TEXT.rail.settings}</span>
        </button>
      </div>
      {onOpenAccount ? (
        <div className="rail-foot">
          <button
            aria-current={accountOpen ? "page" : undefined}
            aria-label={account ? TEXT.rail.user : TEXT.login.accountTab}
            className={`rail-item rail-user${accountOpen ? " is-active" : ""}`}
            onClick={onOpenAccount}
            title={account ? TEXT.rail.user : TEXT.login.accountTab}
            type="button"
          >
            <span className={`rail-user-avatar${account ? "" : " is-guest"}`}>
              {account
                ? account.avatarUrl
                  ? <img alt="" src={account.avatarUrl} />
                  : account.displayName.trim().slice(0, 1).toUpperCase()
                : <UserGlyph />}
            </span>
          </button>
        </div>
      ) : null}
    </nav>
  );
}
